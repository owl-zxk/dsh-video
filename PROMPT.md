# 提示词：实现 DSH 插件 `dsh-video`

> 把下面整段（从「# 任务」到末尾）交给一个编码代理即可。
> 文中所有路径、模型、价格、API 均已在目标机器上实测确认，**不要重新探测**。

---

# 任务

实现一个 DSH 插件 `dsh-video`，核心能力是**准确理解视频内容**（画面 + 声音 + 时间轴 → 结构化结果）。
插件必须设计成**可扩展**：以后要能平滑加入「生成视频」「剪辑」「字幕」等其它视频相关功能，
而不需要推翻重写当前实现。

工作目录：`D:\DSH\deepseek harness\wokrspace\dsh-video`

---

## 0. 环境事实（已验证，直接用，不要重新探测）

### 外部二进制

| 工具 | 路径 | 备注 |
|---|---|---|
| ffmpeg | `D:\DSH\dsh-home\bili-whale\bin\ffmpeg.exe` | 9.0.2 |
| ffprobe | `D:\DSH\dsh-home\bili-whale\bin\ffprobe.exe` | 同目录 |
| whisper.cpp | `C:\Users\Administrator\.dsh\voice\whisper\bin\Release\whisper-cli.exe` | CPU 版 v1.8.0 |
| whisper base | `C:\Users\Administrator\.dsh\voice\whisper\ggml-base.bin` | 141 MB |
| whisper small | `C:\Users\Administrator\.dsh\voice\whisper\ggml-small.bin` | 465 MB |

**这些路径要放进插件 settings，可被用户覆盖** —— 不要硬编码成唯一来源，但默认值就用上面这些。

### 可用视觉模型（`input` 含 `image`）

| 模型 id | 价格（$/1M in/out） | 备注 |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 0.3 / 1.2 | ctx 1,048,576 · maxTokens 943,718 · **首选** |
| `deepseek/deepseek-v4-flash-vision-exp` | 0.2156 / 0.6468 | 更便宜，maxTokens 262,144 |
| `deepseek/deepseek-v4.1-flash:batch` | 0.112 / 0.336 | **最便宜**，批量分析用 |
| `minimax/minimax-m3` | 0.3 / 1.2 | ctx 524,288 · ⚠️ **没有 image token calculator**，会触发 `spill-policy` 警告 |

⚠️ **大量 DeepSeek 模型不支持图片**（`deepseek-v4-pro` / `v4-pro-0813` / `v4-flash` / `v3.2` 全是纯文本）。
**选模型前必须校验 `input` 含 `image`**，否则图片会被静默替换成占位符，模型"看不见"却不会报错。

### DSH 运行时约束（踩过的坑，必须遵守）

1. **DSH 内置模型目录里没有任何 `type: "video"` 模型** —— 生视频必须走外部 API，插件自己接。
2. **图片有硬预算**：一次请求里保留的图片超过该路由的 `LlmImageRequestBudget` 会失败并抛
   `IMAGE_OFFLOAD_REQUIRED`（提示要省略多少张最老的图）。**绝不能一次把几十帧塞进一个请求。**
3. **DeepSeek 适配器的图片规则**：
   - 不设 `imagePixelBudget` 时按官方视觉 token 网格定尺寸：14px patch、3:1 降采样、单图最多 1024 token
     → 正方形最多 1302×1302 px，**16:9 图片按 1708×961 发送**
   - `imagePixelBudget: 'low'` → 总计 512×512 像素（省 token，但看不清字）
   - `imageMaxBytes` 默认 **2 MiB/张**
   - 单边最多 4096 px（这是"请求带 ≥15 张图"时的提供方限制）
4. **附件层限制**：`ctx.attachments.imageLimits` → `maxImageBytes` 20 MiB、`maxImagesPerMessage`、
   `maxMessageImageBytes`、`maxImagePixels`、`maxImageDimension`；媒体类型仅 png / jpeg / webp / gif。
5. **`cordis.patch.yml` 里同一个 `id` 不能插两次** —— 插件 README 明确说了，插两次直接把启动搞崩。
6. 插件常用 API：`ctx.llm.stream(options)`（产出原始分片，用 `BlockAssembler` 拼）、
   `ctx.llm.listProviders()`、`ctx.llm.listModels(providerId)`、
   `ctx.llm.resolveModelInfo(providerId, modelId)`、`ctx.llm.prepareCall(...)`、
   `ctx.llm.imageRequestPricing(provider, model)`、`ctx.sessionController.prompt(...)`。
   给 `ctx.llm.stream()` 传图的内容块形状是 `{ type: 'image', data: <base64>, mimeType: 'image/png' }`。

### 已验证可复用的现成实现（**照抄思路，不要重写**）

- **`D:\DSH\deepseek harness\dsh_bilibili虚拟账号\whale-listen.mjs`** —— 已经解决了音频转录的三个坑：
  ① dsh-voice-call 的 whisper 路径不是 volatile 字段，改了要重启才生效；
  ② 插件只取 whisper JSON 的 `transcription[0].text`，长视频只能拿到开头一句；
  ③ 插件不传语言参数，中文靠自动检测会偶尔误判。
  它的做法：自己抽音轨（16 kHz 单声道 wav）→ 自己跑 `whisper-cli -oj` → **自己拼全文并保留每段的 offsets**。
  管线已经跑通，直接沿用。
- **`D:\DSH\deepseek harness\dsh_bilibili虚拟账号\ffx.mjs`** —— ffmpeg 调用封装。
  **关键：用 `spawnSync(FFMPEG, [参数数组])` 传参，不要拼命令字符串。**
  PowerShell 会把 `$i:v` 这种写法当变量吃掉，`[0:v]scale=...` 会变成 `scale=...`。
- **插件模板**：照 `D:\DSH\dsh-home\lanpangzi-src\` 的结构写
  （`package.json` + `cordis.patch.yml` + `lib/` + `scripts/build-client.mjs` + `tests/`）。

---

## 1. 架构：能力注册表（这是可扩展性的关键）

不要把「理解视频」写成一个巨型工具函数。设计成：

```
lib/
  index.js              插件入口：装配 + 注册能力
  capabilities/
    registry.js         能力注册表：registerCapability({ id, tool, description, schema, run })
    understand.js       能力①：视频理解
    index.js            导出所有能力
  media/
    ffmpeg.js           ffmpeg / ffprobe 封装（spawnSync 参数数组）
    probe.js            读容器与流元信息
    frames.js           抽帧：场景检测 + 均匀兜底 + 时间戳映射
    reframe.js          自适应重采样：针对模型点名的窗口重新高分辨率抽帧 + 预算闸门
    audio.js            音轨抽取 + whisper 转录（沿用 whale-listen 的管线）
  llm/
    vision.js           调 ctx.llm.stream 传图 + BlockAssembler 拼结果
    budget.js           图片/ token 预算计算与分批
  util/
    paths.js            二进制路径解析（用户覆盖 > 默认值）
    perf.js             计时器：分环节耗时统计 + 墙钟预算闸门
```

**将来加「生成视频」时**：只需在 `capabilities/` 下新增一个文件、往注册表里 `registerCapability` 一项，
`media/` 和 `llm/` 那层设施直接复用。**不要为将来猜需求去提前抽象**——注册表本身就够了。

---

## 2. 能力①：视频理解（`video_understand`）

### 输入

```jsonc
{
  "path": "D:\\...\\video.mp4",   // 必填，本地文件路径
  "question": "这个视频在讲什么？",  // 可选，默认给通用理解
  "detail": "standard",           // 可选: "quick" | "standard" | "deep"
  "maxFrames": 24,                // 可选，默认按 detail 推导
  "lang": "zh",                   // 可选，音频语言；默认 zh（不要用 auto）
  "model": "deepseek/deepseek-v4.1-flash",  // 可选，默认按 detail 推导
  "adaptive": true,               // 可选，是否开启 Agent 自适应重采样（见 §2.5），默认按 detail 推导
  "maxRounds": 2,                 // 可选，自适应重采样轮数上限；0 = 关闭
  "concurrency": 4,               // 可选，并发度（视觉批次 / whisper 分块），默认按 CPU 核数推导，见 §2.7
  "maxWallClockMs": 300000        // 可选，墙钟上限；超时则停在当前进度返回部分结果，见 §2.7
}
```

### detail 三档的成本/质量取舍

| detail | maxFrames | 批大小 | 自适应重采样 | 用途 |
|---|---|---|---|---|
| `quick` | 6 | 6 | ❌ 关（`maxRounds: 0`） | 先看一眼值不值得细看 |
| `standard` | 16 | 8 | ✅ 最多 1 轮 | 默认 |
| `deep` | 40 | 10 | ✅ 最多 2 轮 | 细节/字幕/文字多的视频 |

### 处理管线（**顺序不能变**）

```
1. probe        ffprobe → duration / width / height / fps / 是否有音轨
2. frames       抽帧 → 每帧一个 jpg + (帧序号 → 时间戳) 映射      ← 一次全解码 + 快速 seek，见 §2.7.3
3. audio        抽音轨 → whisper 转录 → 带 offsets 的 segments   ← 分块并发，见 §2.7.5
4. batch        视觉分批：每批 N 帧 → 模型产出该批的场景描述 + 可能提出的重采样请求
                                                          ↑ 批次之间**并发**，见 §2.7.4
5. reframe      收集各批的重采样请求 → 对点名的窗口高分辨率重抽 → 只把新帧送回模型
                （循环，轮数/帧数/成本三重闸门，见 §2.5）
6. merge        把所有批次描述 + reframe 补充 + 完整转录 → 模型做全局理解（串行，最后一步）
7. output       合并成结构化 JSON
```

### 2.1 抽帧策略（**准确性的核心，不要用均匀抽帧**）

均匀抽帧会漏掉关键画面。正确做法是**混合采样**：

```bash
# a) 场景切换点（解析 stderr 里的 pts_time）
ffmpeg -i in.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null -
# b) 均匀兜底：每 max(1, duration/maxFrames) 秒 1 帧
ffmpeg -i in.mp4 -vf "fps=1/<interval>" -f image2 frame_%04d.jpg
# c) 首帧 + 尾帧必取
ffmpeg -i in.mp4 -vf "select='eq(n,0)+eq(n,<total-1>)'" -f image2 edge_%02d.jpg
```

合并三组，去重（按时间戳容差 0.5s），按时间排序，截断到 `maxFrames`。
**场景切换点的优先级高于均匀帧** —— 保留场景点，再补均匀帧。

抽帧时把画面**缩到长边 ≤ 1708 px**（DeepSeek 16:9 的实际发送尺寸），
JPEG 质量 85，单帧控制在 2 MiB 内。

### 2.2 时间戳对齐（**不做这个，模型无法回答"第几分钟"**）

- 每张图送给模型前，**紧挨着它插一行文本**：`帧 3 · 00:12.4`
- 批次描述里要求模型**显式引用帧号和时间戳**
- 音频 segments 同样保留 `offsets.from`（毫秒）

### 2.3 分批（**对抗 `IMAGE_OFFLOAD_REQUIRED`**）

- 一次请求最多 `batchSize` 张图，**绝不一次发全部帧**
- 每批的提示词要带上：这一批覆盖的时间区间、总时长、以及"只描述你看到的画面，不要编造画面外的事"
- 每批产出结构化结果（让模型输出 JSON，字段见 §2.5.1 —— **含 `needsReframe` 数组**，即使不需要重采样也要给出空数组）
- 最后一步把「各批描述摘要 + reframe 补充 + 完整转录 + 用户 question」交给模型做全局总结
- **汇总那一步不要再带图**（避免二次触发图片预算），只带文字

### 2.4 模型调用

- 用 `ctx.llm.stream({ provider, model, messages, ... })`，配 `BlockAssembler` 拼文本
- 送图前**必须**用 `ctx.llm.resolveModelInfo(provider, model)` 确认 `input` 含 `image`，
  不含就**换模型并明确报错**，不要静默降级
- 调 `ctx.llm.imageRequestPricing(provider, model)` 估算成本，输出里带上 `estimatedCostUsd`
- 每批之间要有**重试**：失败重试 2 次（指数退避），仍失败就把该批标为 `failed` 继续，不要整体崩
- **reframe 轮复用同一个模型和同一套调用封装**，不要另起一条调用路径 —— 两条路径的
  校验/重试/计费逻辑必须一致，否则 reframe 轮就会绕过图片预算校验
- **各批次并发发起**（受 `concurrency` 限流，见 §2.7.5），不要串行等待

### 2.5 Agent 自适应重采样（**当前 Agent 视频理解最大的准确率增益点**）

这是从「一次性抽帧喂给模型」升级到「**模型自己决定看哪里**」。

**为什么必须有**：静态管线的抽帧在**预处理阶段就定死了**，模型没有参与权。视频里真正要紧的那 2 秒（一个手势、一行小字幕、一个二维码）很可能落在两帧之间 —— 模型压根没见过它。

**机制**：分批推理时，让模型在产出描述的同时**声明它需要更清楚的哪一段**；插件针对那些时间窗重新抽更高分辨率的帧，只把新帧送回模型，再走一轮。

**核心原则：增量补充，不重跑全片。** 重跑会让已经付出的调用全部作废。

```
Round 0  混合抽帧（广角扫描，低分辨率，覆盖全片）
         → 分批 → 每批产出 { visual, ..., needsReframe: [...] }
Round 1  合并所有 needsReframe → 对每个窗口「特写」重抽（高分辨率 + 窗口内密集采样）
         → 只把这些新帧送给模型 → 模型补充描述，可能再要 reframe
Round 2  ...（受 maxRounds 限制）
停止条件  ① 没有 needsReframe  ② 达到 maxRounds  ③ 达到帧预算  ④ 成本超限
```

#### 2.5.1 怎么让模型「要」

**用结构化输出，不要用 function calling**（v0.1 保持简单、确定、可测；tool-call 变体留作后续升级）。

每批要求模型返回（**必须严格 JSON，不要让它输出散文**）：

```jsonc
{
  "startMs": 0,
  "endMs": 5200,
  "visual": "……",
  "onScreenText": ["……"],
  "actions": ["……"],
  "needsReframe": [
    {
      "startMs": 3200,
      "endMs": 4800,
      "reason": "看不清右下角的小字",
      "kind": "detail"
    }
  ]
}
```

`kind` 的取值与含义 —— **这一栏决定要不要真的重抽**：

| kind | 含义 | 值得重抽？ |
|---|---|---|
| `detail` | 画面里有细节看不清（远处的小字、纹理） | ✅ |
| `text` | 需要读画面里的字幕/标题/UI 文字 | ✅ |
| `motion` | 需要看清动作过程（这帧是静态的，看不出动没动） | ✅ |
| `blur` | **内容本身就是糊的**（失焦、压缩糊） | ❌ **重抽也没用**，不要触发 |

提示词里要写明这一点，否则模型会对着一段本来就模糊的画面反复要特写，白烧钱。

#### 2.5.2 特写重抽的策略（**和首轮完全不同**）

| | 首轮（广角扫描） | reframe（特写） |
|---|---|---|
| 目的 | 覆盖全片，知道大致讲了什么 | 看清某一段的细节 |
| 分辨率 | 长边 ≤ **1708 px**（DeepSeek 16:9 实际发送尺寸） | 长边 ≤ **4096 px**（DeepSeek 单边上限） |
| 采样范围 | 全片 | **只在请求的时间窗内** |
| 密度 | 稀疏（覆盖优先） | 窗口内密集（每 0.5–1 秒 1 帧） |
| 编码 | JPEG q85，≤ 2 MiB | 同上，但优先保清晰度 |

ffmpeg 用 `-ss` / `-to` 精确定位，**比 `-vf select` 快得多**：

```bash
# -ss 放在 -i 之前 = 快速定位（跳过前面的解码）；放后面 = 精确解码但慢。
# 抽帧用前者。
ffmpeg -ss 3.2 -to 4.8 -i in.mp4 -vf "fps=2,scale=4096:-2" -f image2 close_%04d.jpg
```

窗口很短时（比如 0.5 秒）可能一帧都抽不到 —— 这时**退回抽窗口中间那一帧**（`-ss mid -frames:v 1`），不能空手而归。

#### 2.5.3 预算与防死循环（**必须有，否则会烧钱**）

| 闸门 | 默认 | 作用 |
|---|---|---|
| `maxRounds` | standard=1 / deep=2 | 重采样轮数上限 |
| `maxReframeWindows` | 3 | 单轮最多接受几个窗口请求 |
| `maxExtraFrames` | 12 | 额外帧总数上限（跨所有轮次累计） |
| `maxCostUsd` | 由 `detail` 推导 | 本能力总成本上限，超了就停 |
| `maxWindowMs` | 30000 | 单个窗口时长上限 |

**请求合法性校验**（不合法直接丢弃并记进 `reframes[].accepted=false`）：

- 必须落在 `[0, durationMs]` 内
- 窗口长度 ≥ 300 ms、≤ `maxWindowMs`
- `kind` 必须是 `detail` / `text` / `motion`（`blur` 直接丢弃）

**去重（防死循环的关键）**：用 `[Math.floor(startMs/1000), Math.floor(endMs/1000)]` 做窗口签名，
**同一个签名被请求第二次就拒绝**并让模型继续 —— 不要反复重抽同一段。
已经抽过的帧也要记签名，避免「换个时间窗但其实是同一画面」反复触发。

#### 2.5.4 增量合并

- reframe 轮产出的描述**合并回对应的时间区间**，不覆盖首轮描述
- 同一时间段两者不一致时，**reframe 的优先**（更近、信息更多），但**首轮的描述保留为 `firstPass`** 便于调试
- 合并后**重新按时间排序**，`scenes` 的时间区间不得重叠或断裂

#### 2.5.5 必须能关掉

`detail: "quick"` 默认 `maxRounds: 0`（关闭）。
用户也可以显式传 `"adaptive": false` 或 `"maxRounds": 0` 关掉 —— **它会明显增加成本和耗时**，
不该由插件替用户默认打开。

### 2.6 输出结构（固定 schema，别自创）

```jsonc
{
  "source": "video.mp4",
  "durationMs": 123456,
  "width": 1920, "height": 1080, "fps": 30,
  "hasAudio": true,
  "model": "deepseek/deepseek-v4.1-flash",
  "framesAnalyzed": 16,
  "reframes": [                 // 自适应重采样记录；没触发就是空数组
    { "round": 1, "startMs": 3200, "endMs": 4800, "reason": "看不清右下角的小字",
      "kind": "detail", "frames": 4, "accepted": true }
  ],
  "scenes": [
    { "startMs": 0, "endMs": 5200, "frames": [0, 1], "visual": "……", "onScreenText": ["……"], "actions": ["……"] }
  ],
  "transcript": [ { "startMs": 1200, "endMs": 4800, "text": "……" } ],
  "summary": "……",
  "answer": "……",              // 针对 question 的直接回答
  "failures": [ { "batch": 2, "reason": "……" } ],
  "timings": {                  // 分环节耗时；见 §2.7.2
    "probeMs": 12, "framesMs": 8400, "audioMs": 21000,
    "visionMs": 31500, "reframeMs": 9000, "mergeMs": 4200,
    "totalMs": 74100, "wallClockMs": 74300
  },
  "concurrency": 4,
  "estimatedCostUsd": 0.0031
}
```

`answer` 字段：用户问什么就直接答什么；没给 `question` 时 `answer` 等于 `summary`。

### 2.7 性能：在保证准确性的前提下尽可能快

#### 2.7.1 第一原则：**并行化优先于降级**

先榨干并行度（解码分段、whisper 分块、视觉批次并发），再考虑减少工作量。

**绝对不要一上来就砍帧数** —— 那是准确性的直接损失，和"跑快一点"不是一回事。
真正该降的是**档位**（`quick` vs `standard` vs `deep`），而那必须是**用户显式选的**，
插件不许静默替用户降级。

> 插件可以**更快地拿到同样的结果**；但**不可以**用更少的信息换速度，除非用户明说。

#### 2.7.2 先量再优化：输出里必须带 `timings`

没有分环节耗时，就不知道该优化哪一段。`lib/util/perf.js` 提供一个分段计时器，
**每一段都要计时**：

```jsonc
"timings": {
  "probeMs": 12,
  "framesMs": 8400,
  "audioMs": 21000,
  "visionMs": 31500,
  "reframeMs": 9000,
  "mergeMs": 4200,
  "totalMs": 74100
}
```

`totalMs` 是墙钟时间（不是各段之和 —— 并发段会重叠，两个都写：另加 `wallClockMs`）。

#### 2.7.3 各环节的提速手段（按收益排序）

| 环节 | 手段 | 收益 | **准确性影响** |
|---|---|---|---|
| 视觉推理 | **多批并发** | ⭐⭐⭐ 最高 | **无** |
| 抽帧 | 场景检测**只做一次全解码** + 抽帧用 seek | ⭐⭐⭐ | **无** |
| 音频 | whisper 多线程 + 静音裁剪 + 分块并发 | ⭐⭐ | **无** |
| 抽帧 | `scale=...:flags=fast_bilinear` | ⭐ | **无** |
| I/O | 帧写本地临时目录，base64 直读不落盘二次拷贝 | ⭐ | **无** |
| 音频 | `quick` 档用 `ggml-base`（141 MB）而非 `small`（465 MB） | ⭐ | 轻微（转录精度） |
| 帧数 | 降 `maxFrames` | ⭐⭐ | ⚠️ **直接掉准确率** |
| 模型 | 批次降级到便宜档 | ⭐⭐ | ⚠️ **直接掉准确率** |

**下面四行是「免费」的，上面最后两行是「要付准确率代价」的 —— 报告成本时要说清楚用了哪档。**

#### 2.7.4 抽帧：**一次全解码 + 快速 seek**

最常见的性能错误：为了拿场景切换点和均匀帧，跑了好几遍 ffmpeg，**每遍都全量解码**。

正确做法 —— **只有一次全解码**：

```bash
# 第 1 遍（唯一一次全解码）：只为了拿场景切换点的时间戳
ffmpeg -i in.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null -

# 第 2..N 遍（快速 seek）：每帧只解码那一帧附近
ffmpeg -ss <t> -i in.mp4 -frames:v 1 -vf "scale=1708:-2:flags=fast_bilinear" -f image2 out_%04d.jpg
```

`-ss` 放 `-i` **之前** = 快速定位（跳过前面的解码）。

**权衡**：每帧一次进程启动（Windows 上约 50–100 ms），N 帧就是 N 倍开销。
- **帧数少（< 40）** → 用 seek，更快
- **帧数多** → 改用一次 `-vf "fps=1/interval,scale=..."` 全量输出，事后按时间戳挑

#### 2.7.5 视觉批次：**必须并发**

- 批次之间**没有依赖**（每批独立送模型）→ **必须并发**，串行是纯浪费
- 默认并发度 `concurrency = min(4, max(2, cpus - 2))`，可由入参覆盖
- **reframe 轮依赖上一轮结果，不能并发**；但**同一轮内的多个 reframe 窗口之间可以并发**
- merge（汇总）永远在最后，串行 —— 它要等所有批次结果
- 并发要用**信号量**限流，不要 `Promise.all` 一把梭（会同时打满 N 个请求触发网关 429）

#### 2.7.6 音频转录提速

- whisper 加 `-t <线程数>`（默认 CPU 物理核数的一半）
- **静音预裁剪**：先用 ffmpeg 的 `silencedetect` 找出有声段，只对有声段跑 whisper
- **长音频分块并发**：按 30 秒切块，每块一个 whisper 进程，并发跑，最后按 `offsets` 拼回
  - ⚠️ 切块要在**静音处**切，不要硬切 —— 硬切会把词切一半，转录质量下降
- `quick` 档用 `ggml-base.bin`；`standard` / `deep` 用 `ggml-small.bin`

#### 2.7.7 明确的性能预算（`standard` 档，CPU-only）

| 场景 | 目标耗时 |
|---|---|
| 1 分钟 720p | ≤ 30 秒 |
| 10 分钟 720p | ≤ 2.5 分钟 |
| 30 分钟 1080p | ≤ 6 分钟 |

**超时保护**：整体墙钟超过 `maxWallClockMs`（默认 5 分钟）就**停在当前进度**，
返回已完成的部分 + 在 `failures` 里说明「因超时截断，reframe 轮未执行」。
**不要为了赶时间跳过 reframe** —— 那会静默降准确率。要么做，要么明确标注没做。

#### 2.7.8 不许做的事

- ❌ 不要为了快而**静默减少帧数** —— 降帧必须是用户显式选择
- ❌ 不要**串行**跑视觉批次（并发是最大的免费加速项）
- ❌ 不要为每一帧启动一次**全量解码**
- ❌ 不要用 `Promise.all` 无限制并发打模型请求（会触发 429）
- ❌ 不要在 reframe 轮里重发首轮帧（既慢又贵）
- ❌ 不要为了赶墙钟而**跳过 reframe 却假装做过** —— 必须在 `timings`/`failures` 里如实反映

---

## 3. 目录与实现要求

### `package.json`

按 `dsh-lanpangzi-src\package.json` 的形状写，**必须包含**：

```jsonc
{
  "name": "dsh-video",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib", "assets", "cordis.patch.yml", "README.md", "docs"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [], "platform": "web" } },
  "scripts": { "build": "node scripts/build-client.mjs", "test": "node --test tests/*.test.mjs" },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/<账号>/dsh-video.git" },
  "homepage": "https://github.com/<账号>/dsh-video#readme",
  "bugs": { "url": "https://github.com/<账号>/dsh-video/issues" }
}
```

### `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-video
      name: dsh-video
```

**同一个 id 只能出现一次。** 装法：`dsh plugin --profile desktop add "link:D:\DSH\deepseek harness\wokrspace\dsh-video"`

### 代码风格（照本机既有约定）

- ESM，`import` / `export`
- 2 空格缩进
- **文件头注释写清楚「为什么这样写」，不是写「做了什么」** —— 本机既有插件（whale-listen.mjs、ffx.mjs、char-design.mjs）都是这个风格，把踩过的坑记在注释里
- 写 `.ps1` 必须带 UTF-8 BOM（PowerShell 5.1 会把无 BOM 的 UTF-8 按 GBK 解，中文注释变乱码 → 语法报错）；
  写 `.json` / `.jsonl` **不能**带 BOM（`JSON.parse` 会在首行抛错）—— 用 `UTF8Encoding($false)`
- 改完任何文件跑一次语法检查（`node --check`）

---

## 4. 测试

`node --test tests/*.test.mjs`，**测试素材必须自己用 ffmpeg 生成，不依赖任何外部下载**：

```bash
# 合成测试视频：彩条 + 音频 + 字幕
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25:duration=8 \
       -f lavfi -i sine=frequency=440:duration=8 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test.mp4
```

至少覆盖：

| 用例 | 断言 |
|---|---|
| `probe` | duration / 宽高 / 有无音轨正确 |
| 抽帧 | 帧数 ≤ maxFrames；**每个帧都有时间戳**；时间戳单调递增 |
| 时间戳映射 | 帧时间戳落在 [0, duration] 内，且与实际抽帧位置一致 |
| 音频转录 | 有音轨时产出非空 segments；无音轨时返回空数组而不是报错 |
| 分批 | 批次数 = ceil(帧数 / 批大小)；**每批图片数 ≤ 批大小**（守住图片预算） |
| 模型校验 | 传一个 text-only 模型时**明确报错**，不静默降级 |
| **reframe 窗口校验** | 越界 / 过短 / `kind: "blur"` 的请求**一律被拒**，`accepted: false` 且**不抽帧** |
| **reframe 去重** | 同一窗口签名被请求两次 → **第二次被拒**，总额外帧数不增加 |
| **reframe 预算** | 超过 `maxRounds` / `maxExtraFrames` / `maxCostUsd` 任一闸门 → **立刻停止**，不再发请求 |
| **reframe 增量** | reframe 轮**只带新帧**，不重发首轮帧；`scenes` 合并后时间区间不重叠、不断裂 |
| **reframe 关闭** | `maxRounds: 0` → `reframes` 为空数组，调用次数与首轮相同 |
| **reframe 兜底** | 极短窗口抽不到帧时，**退回抽窗口中间一帧**，不返回空结果 |
| **计时输出** | `timings` 里**每一段都有值**，且 `wallClockMs` ≥ 任何一个分段耗时 |
| **批次并发** | 4 批的 `visionMs` **明显小于**串行耗时（断言并发路径真的走了，不是假并发） |
| **抽帧只解码一次** | 场景检测**只跑一次**全解码；抽帧走 seek（断言 ffmpeg 调用次数 ≈ 帧数 + 1，不是 × 遍数） |
| **并发限流** | 同时在飞的请求数 **≤ concurrency**（用假模型计数断言） |
| **墙钟超时** | 超过 `maxWallClockMs` → **停止并返回部分结果**，`failures` 里写明「因超时截断」 |
| **超时不静默降级** | 超时后帧数**没有被动减少**；`timings` 如实反映未完成的阶段 |
| 端到端 | 对合成测试视频跑一次 `video_understand`，断言返回结构完整、`scenes` 非空 |
| 降级 | 模型调用连续失败 → 该批进 `failures`，整体仍返回结构化结果 |

**端到端测试要能跳过**：没有可用 API key 时用环境变量判断并 `t.skip()`，不要让 CI 红。

---

## 5. 验收标准（做完逐条自查）

- [ ] `dsh plugin --profile desktop add "link:<路径>"` 能装上，DSH 启动不崩
- [ ] 模型里能看到 `video_understand` 工具，参数说明清楚
- [ ] 对一个真实视频（含人声）跑 `quick`，能同时得到画面描述和语音转录
- [ ] 输出里每帧都有时间戳，`scenes` 的时间区间能对上视频实际进度
- [ ] 长视频（>10 分钟）不会触发 `IMAGE_OFFLOAD_REQUIRED`，且耗时/成本可接受
- [ ] 模型不可用时降级成结构化结果 + `failures`，不抛未捕获异常
- [ ] **自适应重采样生效**：跑 `deep` 时模型点名某段看不清 → `reframes` 里有该窗口记录，
      且该段的 `visual` 描述**比首轮更具体**（对比首轮的 `firstPass`）
- [ ] **重采样有界**：故意让模型反复请求同一窗口 → 第二次被拒，帧数和成本**不失控**
- [ ] **`maxRounds: 0` 能完全关闭**重采样，行为与开启前一致
- [ ] **性能达标**：对一段 1 分钟 720p 视频跑 `standard`，墙钟 **≤ 30 秒**（见 §2.7.7 的预算表）
- [ ] **提速手段确实生效**：`timings.framesMs` 明显低于「每帧全量解码」的做法；
      `timings.visionMs` 明显低于串行批次
- [ ] **没有为了快而降准确率**：跑出来的 `framesAnalyzed` 与 `detail` 档位对得上，
      `timings` 里的模型档位与实际调用一致
- [ ] **超时不静默降级**：把 `maxWallClockMs` 设成 1 秒 → 返回部分结果，
      `failures` 写明因超时截断，**帧数没有被动减少**
- [ ] `npm test` 全绿
- [ ] `package.json` 三个仓库字段齐全，`cordis.patch.yml` 的 id 只出现一次

---

## 6. 明确不要做的事

- ❌ 不要实现「生视频」—— DSH 没有 video 模型，那是另一件事。**但架构要给它留位置**（能力注册表）。
- ❌ 不要用 `dsh-voice-call` 的 `transcribe` 工具做音频——它只取第一段，长视频会丢内容（见 §0）。
- ❌ 不要用拼字符串的方式调 ffmpeg——用参数数组（见 §0）。
- ❌ 不要一次把所有帧塞进一次模型请求——会撞图片预算。
- ❌ 不要假设模型能看图——先校验 `input` 含 `image`。
- ❌ 不要硬编码二进制路径到逻辑里——做成可配置的 settings，默认值用 §0 的路径。
- ❌ **不要在重采样时重发首轮的帧**——只发新抽的帧，否则成本和上下文都会爆。
- ❌ **不要让重采样变成死循环**——窗口签名去重 + 轮数/帧数/成本三重闸门，一个都不能少。
- ❌ **不要对 `kind: "blur"` 的请求重抽**——内容本身是糊的，重抽一百次还是糊。
- ❌ 不要在没有真实测试通过前声称"已完成"——区分「测过了」/「看着对」/「没验」。
- ❌ **不要为了快而静默减少帧数或降模型档位**——提速靠并行化，不靠少给模型信息。
- ❌ **不要串行跑视觉批次**——并发是最大的免费加速项。
- ❌ **不要每帧跑一次全量解码**——场景检测一次全解码，其余走 seek。
- ❌ **不要用 `Promise.all` 无限制并发打模型请求**——要限流，否则 429。
- ❌ **不要为了赶墙钟跳过 reframe 却假装做过**——如实写进 `timings` / `failures`。

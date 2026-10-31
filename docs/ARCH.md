# dsh-video · 架构

> 这份文档回答**为什么**。怎么装、参数怎么填、输出长什么样，看 [`../README.md`](../README.md)；
> 每个函数的确切签名看 [`CONTRACT.md`](CONTRACT.md)。

---

## 零、一页版

```
lib/
  index.js              唯一允许 import @deepseek-ai/* 的文件：只做装配
  capabilities/
    registry.js         能力注册表（register 一项 = 加一个能力）
    understand.js       能力①：video_understand（业务逻辑全在这里）
    index.js            导出全部能力
  media/                ffmpeg 世界：probe / frames / reframe / audio
  llm/                  模型世界：vision（送图 + 拼流）/ budget（预算与分批）
  util/                 paths（二进制解析）/ perf（分段计时 + 墙钟闸门）/ t2s（繁转简查表）
assets/opencc/          繁转简词表（OpenCC 数据，运行时必需，不是开发期资源）
```

三条主线：**能力靠注册表扩展**、**准确率靠采样策略而不是靠模型自觉**、
**提速靠并行而不是靠少给信息**。

---

## 一、能力注册表：为什么是「注册一项」而不是「再加一个 if」

### 问题

`video_understand` 很容易写成 `lib/index.js` 里一个两千行的 apply：
读文件、抽帧、调模型、拼 JSON 全在一个函数里。第一次能跑，**第二次加功能就废**：
「生成视频」「剪辑」「字幕」各有各的输入输出、各有各的预算和错误语义，
塞进同一个函数后，任何一处改动都可能让已经跑通的理解能力回归。

### 做法

把「能力」定义成数据，而不是控制流：

```js
// capabilities/understand.js
export const understandCapability = { id: 'video_understand', tool: { name, description, parameters }, run }

// index.js —— 只做装配，业务逻辑一行都不留
const registry = createRegistry()
registry.register(understandCapability)
for (const cap of registry.capabilities()) ctx.tools.register(cap.tool, wrap(cap.run))
```

`registry.register` 只校验两件事：`id` 唯一、`tool.name` 唯一。
`defineCapability` 返回 `Object.freeze` —— 注册进去的能力定义不会被下游改写，
（并行开发时这一点很重要：一个能力顺手改掉另一个能力的 schema，会安静地坏掉）。

### 加一个新能力要做几步

以「生成视频」为例，三步，**不碰 `understand.js`**：

1. 新建 `lib/capabilities/generate.js`，导出 `{ id, tool, run }`
2. 在 `lib/capabilities/index.js` 里加一行 export
3. 在 `lib/index.js` 的装配列表里加一行 register

`media/`（ffmpeg 封装、抽帧、音频）和 `llm/`（预算、调用、重试）那层设施直接复用。
**不为将来猜需求去提前抽象** —— 注册表 + 一层设施就够了，
再往上做插件化的能力市场是过度设计，等真的有第三个能力再说。

### 边界在哪

注册表**只管登记，不管编排**。能力之间可以互相调用吗？v0.1 不允许 ——
一旦能力之间互相调用，预算（`maxCostUsd`）和闸门就跨能力失效了。
真要组合，走宿主层的会话，不要在这里造 DAG 调度器。

---

## 二、七步管线：顺序为什么不能变

```
1 probe → 2 frames → 3 audio → 4 batch → 5 reframe → 6 merge → 7 output
```

| 步 | 输入 | 产物 | 为什么不能往前挪 |
|---|---|---|---|
| 1 probe | 文件路径 | duration / 宽高 / fps / hasAudio | 时长是一切的前提：没有 `durationMs` 就算不出均匀兜底间隔、生成不出必取的首尾帧、也定不了窗口合法区间 |
| 2 frames | meta.sceneTimes + durationMs | 帧文件 + `(序号 → 时间戳)` 映射 | 时间戳映射是后面**每一张图**的锚点，必须和帧同时产出；先抽帧再补时间戳等于二次读文件 |
| 3 audio | 整个视频 | 带绝对毫秒 offset 的 segments | 转录和视觉**无依赖**，物理上可以与 2 并发；放在 4 之前是因为 merge 要完整转录，而 merge 在最后 |
| 4 batch | 帧 + 时间戳 + `durationMs` | 每批的 `visual` / `onScreenText` / `actions` / `needsReframe` | 服务端只接受「一批图 + 覆盖区间」；批次之间独立才能并发，并发是最大的免费加速项 |
| 5 reframe | 第 4 步收集的 `needsReframe` | 特写帧 + 增量描述 | **依赖第 4 步的输出** —— 模型没点名就不知道该看哪儿。它必须在 merge 之前，因为 merge 要吃它的增量结论 |
| 6 merge | 全部批次描述 + reframe 补充 + 完整转录 + question | `summary` / `answer` | 它要吃全量输入，所以只能最后；且**只带文字不带图**，否则二次触发图片预算 |
| 7 output | 全部中间产物 | 固定 schema | 合并、排序、补齐缺失键（给 0 或 `[]`，绝不给 `undefined`），是全管线唯一写输出的地方 |

两条顺序不变量（被测试直接断言）：

- **`scenes` 按 `startMs` 升序、区间不重叠不断裂。** 第 5 步的增量描述要合并回对应时间区间，
  如果不重新排序，reframe 产出的片段会以「插在后面」的形式出现，时间轴就乱了。
- **同段冲突时 reframe 优先，但首轮描述保留为 `firstPass`。** 覆盖会把调试线索一起抹掉，
  而保两份的成本只是一个字段。

### 一个例外：3 和 2 可以并发

「顺序不能变」说的是**依赖关系**，不是墙钟上的串行。抽音轨（`audioMs`）和抽帧（`framesMs`）
互不依赖，放同一个 `Promise.all` 里跑是纯收益。
真正必须串行的是：`probe → 一切`、`batch → reframe`、`全部 → merge`。

---

## 三、混合采样：为什么比均匀抽帧准

### 均匀抽帧错在哪

均匀抽帧假设「信息在时间上均匀分布」。视频不是这样分布的：
一段 20 分钟的访谈，结论可能就在某人举起一张纸的那 1.5 秒里。
均匀间隔 30 秒取一帧，取到的几乎必然是「两个人在说话」的同质画面，
**模型看到 40 张差不多的脸，然后自信地说了一堆不存在的细节**。

### 混合采样

三组合并，去重（0.5 s 容差），排序，截断到 `maxFrames`：

| 组 | 来源 | 负责什么 |
|---|---|---|
| a 场景切换点 | `select='gt(scene,0.3)',showinfo` | 抓住**变化**：切镜、翻页、界面跳转 —— 信息量密度最高的地方 |
| b 均匀兜底 | `fps=1/<interval>` | 抓住**持续**：长镜头里的缓慢变化，场景检测看不见 |
| c 首尾帧 | `select='eq(n,0)+eq(n,<last>)'` | 定住上下文：片头标题、片尾二维码 / 字幕 / 结论 |

**保护顺序**：先保场景点，再补均匀帧。因为场景点是「一次性的、不可再生的」——
错过的那一次切镜，均匀帧大概率补不回来；而均匀帧本身就是冗余覆盖，砍掉几帧不影响全局。

### 为什么是 1708 px（以及特写为什么只上 2730）

不是随便定的。图片进模型前会被**压两次**：

1. 附件层 `dsh-attachment-local` 的 `normalizedImageMaxPixels = 4,194,304`
   → 16:9 的归一化上限约 **2730×1536**
2. DeepSeek 适配器按官方视觉 token 网格定尺寸：14 px patch、3:1 降采样、单图最多 1024 token
   → **16:9 的实际发送尺寸是 1708×961**

首轮抽帧压到 1708，是「送给模型的像素一个不浪费、也不多传一个用不上的像素」的那个点。

**特写为什么是 2730 而不是 4096**：4096 会在第一步就被压回 2730，
**没有任何空间分辨率收益** —— 多花解码和磁盘 IO，买回一个一样的数字。
硬证据（C 组实测）：`estimateImageTokens(2730×1536) === estimateImageTokens(1708×961) === 968`。
也就是说 2730 和 1708 送到模型手里，是**同样 968 个 token 的一张图**。

所以 reframe 的**真收益是时间密度**（窗口内每 0.5 s 一帧），不是「看得更清楚」。
要看清局部细节只能先把那一块 crop 出来再送 —— v0.1 明确没做。

> ⚠️ 因此：**不许**在文档或提示词里宣称「重采样能看到更清楚的字」。它拿到的是
> 同一分辨率、更多时刻的帧。这条留在这里，是为了挡住后来的人照着 4096 改回去。

### 只解码一次

最常见的性能错误：为了拿场景点、均匀帧、首尾帧跑三遍 ffmpeg，**每遍都全量解码**。
正确做法是只有第 a 组全解码一次，其余全部用 `-ss <t>` **放在 `-i` 之前**（快速定位，
跳过前面的解码）。代价是每帧一次进程启动（Windows 上 50–100 ms），所以：
帧数 < 40 用 seek；帧数多时改用一次 `-vf fps=...` 全量输出、事后按时间戳挑。

---

## 四、自适应重采样：三重闸门与窗口签名去重为什么必须有

### 为什么必须有

静态管线的抽帧在**预处理阶段就定死了**，模型没有参与权。
真正要紧的那 2 秒（一个手势、一行小字幕、一个二维码）大概率落在两帧之间 ——
模型压根没见过它，于是用四周的画面「合理地猜」，猜出来的东西看起来特别可信。

自适应重采样把「看哪里」的决定权交回给模型：分批推理时让它声明需要更清楚的哪一段，
插件对那个窗口用高分辨率密集重抽，**只把新帧送回模型**，再走一轮。

### 三重闸门

| 闸门 | quick / standard / deep | 作用 |
|---|---|---|
| 轮数 `maxRounds` | 0 / 1 / 2 | 防止「一轮又一轮」 |
| 帧数 `maxExtraFrames`（跨轮累计） | 0 / 12 / 24 | 防止每轮都要一大堆特写，把上下文和成本顶穿 |
| 成本 `maxCostUsd` | 0.02 / 0.10 / 0.40 | 最终兜底：钱花到线就停 |

另有单轮窗口数上限 `maxReframeWindows = 3` 与单窗口时长上限 `maxWindowMs = 30000`。

为什么三个都要：它们防的是三种不同的失控。
只有轮数 → 一轮里模型可以要 20 个窗口；只有帧数 → 无限轮也可以每轮 1 帧磨下去；
只有成本 → 便宜模型下成本线形同虚设。**任意一个闸门触发都要立刻停止，不是降档继续。**

### 窗口签名去重

签名 = `floor(startMs/1000) + ':' + floor(endMs/1000)`。同一签名第二次出现 → 直接拒。

这不是优化，是**正确性要求**。模型的典型失败模式是：抽到的特写还是不够清楚 →
它把同一个窗口再要一次 → 抽出来的帧几乎一样 → 再要一次。没有去重，这就是个
自费的死循环：每一轮都在为同一段画面付钱，而信息量零增长。

按秒取整（而不是按毫秒）是为了让「3200–4800」和「3210–4810」算同一个窗口 ——
模型自己也不会两次给出完全相同的边界，毫秒级签名等于没去重。

### `kind: "blur"` 直接丢弃

`detail` / `text` / `motion` 值得重抽：**信息在更高分辨率或更密采样里确实存在**。
`blur` 相反 —— 内容本身就是糊的（失焦、码率太低），重抽一百次还是糊。
提示词里必须写明这一条，否则模型会对着糊画面反复要特写，白烧钱。

窗口校验的拒绝理由是封闭集合，只在 `accepted: false` 时写进 `reframes[].rejectReason`
（`reason` 留给模型给的原文理由，两者不混用）：

| rejectReason | 触发条件 |
|---|---|
| `duplicate` | 窗口签名（按秒取整）已经出现过 |
| `kind-blur` | 模型自报内容本来就糊 |
| `too-short` / `too-long` | 窗口 < 300 ms / > 30 s |
| `out-of-range` | 越出 `[0, durationMs]` |
| `unknown-kind` | 不在 `detail` / `text` / `motion` / `blur` 之内 |
| `window-limit` / `frame-budget` / `cost-budget` / `round-limit` | 单轮窗口数上限 / 三重闸门触发 |

把闸门拒绝也写进同一个字段，是为了让「这一轮为什么停」在输出里可查 ——
否则用户只看到成本涨了，却不知道卡在哪一道闸门上。

### 增量，不重跑

reframe 轮**只发新抽的帧**。重发首轮帧会让成本与上下文一起翻倍，而且对结果没有任何增益。
`reframes` 里每一行都留 `{ round, startMs, endMs, reason, kind, frames, accepted, rejectReason? }` ——
跑完能一眼看出「这一轮到底为什么花了钱」。

### 必须能关掉

自适应重采样是**准确率增益**，也是**成本与耗时的明显增量**。
所以 `quick` 默认 `maxRounds: 0`，用户也可以显式 `adaptive: false` 或 `maxRounds: 0`。
默认打开会让「随便看一眼」变成「昂贵的一次深读」，这个决定不能由插件替用户做。

---

## 五、预算闸门：分批是硬需求，不是优化

一次请求里保留的图片超过路由的 `LlmImageRequestBudget` 会**失败**并抛
`IMAGE_OFFLOAD_REQUIRED`（提示要省略多少张最老的图）。
所以「把 40 帧塞进一次请求」不是慢，是**必然失败**。

| 层 | 限制 | 本插件的应对 |
|---|---|---|
| 请求 | `LlmImageRequestBudget` | 分批：批大小 6 / 8 / 10，`planBatches` 保证批次数 = `ceil(帧数 / 批大小)` |
| 单图 | `imageMaxBytes` 2 MiB | 超了降质量重编一次；首轮长边 1708、特写 2730（4096 在附件层就被压回 2730，无收益） |
| 附件层 | `maxImageBytes` / `maxImageDimension` / 只收 png·jpeg·webp·gif | 只产 JPEG |
| 汇总 | 二次触发图片预算 | merge **只带文字**，一张图都不带 |

图片必须走**附件层**：`ctx.attachments.admitPromptContent([{ type:'image', data, mediaType }])`，
原始 base64 不能直接塞进 messages —— 那只是上传前的 wire 形状，塞进去模型看不到图。

两个编码上的坑，都与「省字节」有关：

- **`-q:v` 是 qscale，不是 libjpeg quality。** 取值 2（最好）… 31（最烂），**方向相反**。
  把 quality 85 直接写进 `-q:v 85` 得到的是糊图；实现里换算成 `-q:v 6`。
- 超过 2 MiB 只降质量**重编一次**：再降就不是省字节，而是改内容了。

---

## 六、性能原则：并行优先于降级

提速手段分两类，混在一起谈就会出问题：

| 免费（不损失信息） | 要付准确率代价（必须用户显式选） |
|---|---|
| 视觉批次并发（受信号量限流） | 降 `maxFrames` |
| 场景检测只全解码一次 + 抽帧走 seek | 批次降级到便宜 / 小模型 |
| whisper 多线程 + 静音预裁剪 + 分块并发 | 换 `detail` 档位（这是它唯一合法的入口） |
| 汇总前不重复送图、reframe 只送新帧 | |
| 帧写本地临时目录、base64 直读 | |

**插件可以更快地拿到同样的结果；不可以用更少的信息换速度，除非用户明说。**
这句话是硬约束，因为它决定了输出的可信度：静默减帧之后，`framesAnalyzed` 变小了，
但用户不知道，于是把一次「没看清」当成了「视频里没有」。

### 并发要限流

批次之间没有依赖 → 必须并发。但**不能用 `Promise.all` 一把梭**：
同时打满 N 个请求会触发网关 429，反而比串行更慢。
用信号量（`budget.js` 的 `Semaphore`），默认 `concurrency = min(4, max(2, cpus - 2))`。

例外，必须串行：`merge` 永远最后（要等所有批次）、reframe **轮与轮之间**
（下一轮依赖上一轮的 `needsReframe`）。同一轮内的多个窗口可以并发。

### 墙钟超时不等于降级

超过 `maxWallClockMs` → **停在当前进度**，返回已完成的部分，并在 `failures` 里写明
「因超时截断，reframe 轮未执行」。
不许为了赶时间跳过 reframe 却假装做过 —— 那等于静默降准确率，只是把损失藏进了耗时里。

### 先量再优化

没有分环节耗时，优化就是猜。`perf.js` 的 `createTimers` 给每一段计时，
`timings()` 保证 8 个键全在（没跑的记 0）。`totalMs` 是各段之和，
`wallClockMs` 是真实墙钟 —— 两者都写，因为并发段会重叠，只有后者是用户等的。

### 实测数字（本机 CPU-only，可以引用）

| 项 | 实测 |
|---|---|
| whisper small 转录 | 20 s 音频 → **5.65 s**（约 3.5× 实时，比原先估的 2.8× 快） |
| 抽帧子进程次数 | 8 s / 25 fps / 640×360 → 约 **帧数 + 1**（场景检测 1 次全解码 + 每帧 1 次 seek） |
| 离线测试全量 | 88 个用例 / **10.4 s** |

PROMPT 里那张「1 分钟 720p ≤ 30 秒」是**目标**：端到端要真 API key，
到目前**没在真宿主里跑过**。已测的是上面这些单项，不是那条端到端预算。

---

## 七、隔离约束：为什么一个 `@deepseek-ai/*` 静态 import 都不许有

事实：`@deepseek-ai/*` 这些包**只在 DSH 宿主进程里可解析**。
工作区里的普通 node 解析不到（实测 `require.resolve('@deepseek-ai/dsh-llm')` → `MODULE_NOT_FOUND`）。

后果很直接：只要 `lib/media/frames.js` 里出现一行 `import '@deepseek-ai/...'`，
`node --test tests/media.test.mjs` 就整组起不来。而这个插件的测试价值恰恰在于
**媒体层可以脱离 DSH 单独跑** —— 抽帧、分批、窗口校验这些是不变量，不该靠启动宿主来验。

所以：

| 文件 | 允许 import |
|---|---|
| `lib/index.js` | **也不许**（2026-10-31 装上之后实测改的，见本节末尾） |
| 其它全部 `lib/**` | **只用 node 内置模块** |
| `tests/**` | 不许 import `lib/index.js`（会把 `@deepseek-ai/*` 一起拉进来） |

### 靠注入，不靠全局 mock

最容易破例的是 `llm/vision.js`：它天生需要 `BlockAssembler`。
做法是从 deps 拿**可选注入**的 `deps.BlockAssembler`，没有时退回本地的小累加器
（只吃 `text-delta` / `block-end` 两种 chunk）。运行期由 `lib/index.js` 把真实现传进去。

### 2026-10-31 补：装上之后被日志打脸

原本 `lib/index.js` 里 import 了 `schemastery` / `defineTool` / `BlockAssembler`。装上之后 DSH 日志直接回：

```
dsh-video (dsh-video): failed to import: ERR_MODULE_NOT_FOUND:
Cannot find package '@deepseek-ai/schemastery'
imported from .../wokrspace/dsh-video/lib/index.js
```

结论：**宿主不会为 junction 指向的 workspace 路径做 ESM 解析插桩**。
本机两个 junction 插件（`dsh-lanpangzi` / `dsh-bili-whale`）之所以能用，是因为它们一个
`@deepseek-ai/*` 都不 import；`dsh-voice-call` 能 import 是因为它在 `profiles/desktop/node_modules/`
里是**真实目录**。

三个替代（都不降级）：

| 原本依赖 | 现在 | 等价性 |
|---|---|---|
| `schemastery` 的 Config | 顶层 `await import(...)` + try/catch，失败则 `Config = undefined` | cordis 允许无 Config，config 照旧传进 `apply()` |
| `defineTool` | 自己把属性级 `required` 转成对象级数组 | `ctx.tools.register` 只要求 `{ name, output: { schema, render } }` |
| `BlockAssembler` | 不注入，用本地累加器 | 只吃 text-delta / block-end |

代价写明白：**配置 schema 在没有 schemastery 的环境里会缺失**（设置页没有字段提示），
但配置值本身照旧生效、照旧被 `normalizeConfig` 过滤。

同样，`@deepseek-ai` 的 Config schema 只出现在 `index.js`。
`config` 在别处就是一个普通对象 —— 这让 `paths.resolveBinaries({ ffmpeg: 'x' })` 这种
纯函数在任何环境都能测。

宿主服务也靠声明，不靠猜。`lib/index.js` 里一行：

```js
export const inject = ['tools', 'llm', 'attachments']
```

`tools` 是工具注册表本身。不声明它，插件就可能跑到工具表挂载**之前**去注册工具，
表现是「装上了，但模型看不到 `video_understand`」—— 这种失败不报错，最难查。
本机 `dsh-voice-call` / `dsh-win-bash` 都是这么写的。

一句话：**代码要对「真宿主」和「裸 node 测试」同时成立，靠的是依赖注入，不是全局 mock。**

---

## 八、错误语义：结构化返回，不抛异常

`run` 永远返回固定 schema 的结构化结果：模型全挂也只是 `scenes: []` + `failures` 非空。
理由是 DSH 的调用方是**模型**：一个未捕获异常会让整轮对话崩掉，
而一个带 `failures` 的部分结果还能被模型读懂并用上。

例外是「配置层面就错了」的情况，这些**必须明确抛错**，因为它们不该被降级掩盖：

| code | 场景 | 为什么不降级 |
|---|---|---|
| `BINARY_MISSING` | ffmpeg / ffprobe 找不到 | 没有 ffmpeg 就没有任何画面，返回空结果是撒谎 |
| `MODEL_NOT_VISION` | 模型 `input` 不含 `image` | 宿主会把图换成占位符，模型「看不见」却不报错 —— 这正是要拦住的静默失败 |
| `NO_VIDEO_STREAM` | 文件里没有视频流 | 传错文件了，得让用户知道 |
| `WALL_CLOCK_EXCEEDED` | 墙钟超时（内部信号） | 不抛给使用者，转成 `failures` 里的一条记录 |

注意 `hasAudio: false` **不在**这张表里：没有音轨是正常情况，不是错误。

---

## 九、可测性：每个子进程调用都是接缝

`media/*` 的每个函数都额外接受一个可选的 `runImpl`（签名同 `ffmpeg.js` 的 `run`）。
这是**唯一**的子进程接缝，测试靠它：

- 统计 spawn 次数 → 断言「场景检测只全解码一次」「抽帧是 seek 不是全量」
- 制造失败 → 走降级路径（某批挂掉、whisper 缺失、超时）

**不要为了测试去 mock 全局 `child_process`**：那样测的是 mock 的行为，不是代码的行为，
而且一旦有人加了第二个子进程调用的入口，测试会假绿。

### 在 DSH 沙箱里怎么跑测试

`node --test` 的默认测试隔离会给每个测试文件 spawn 一个子进程、并用管道收它的输出。
沙箱禁止命名管道 → `spawn EPERM (errno -4048)`，一个测试都起不来。
所以 `package.json` 里有两个脚本，跑的是**同一批测试文件**：

| 脚本 | 命令 | 用在哪 |
|---|---|---|
| `test` | `node --test tests/*.test.mjs` | 真实终端 / CI，默认隔离 |
| `test:local` | `node --test --test-isolation=none tests/*.test.mjs` | DSH 沙箱内的会话 |

这和第七节的隔离约束是一件事的两面：测试之所以能在裸 node 里跑，
是因为 `lib/**`（除 `index.js`）不 import `@deepseek-ai/*`；
而能不能把它们跑起来，只取决于执行方式（单进程 vs 隔离进程），不取决于代码。

### 端到端用例默认 skip

`tests/e2e.test.mjs` 要两个条件同时满足才跑：环境变量 `DSH_VIDEO_E2E=1`，
且宿主注入了 `globalThis.__dshVideoE2E = { llm, attachments, provider?, model? }`。缺一个就 skip。

这不是走过场：`@deepseek-ai/*` 只在宿主进程里可解析，裸 node 拿不到真的 llm / attachments，
勉强跑只会得到一个**假绿** —— 假绿比 skip 危险得多，因为它会让人以为端到端通了。
**真 API key 那条路径目前一次都没跑过**，所以任何文档都不许写成已验证。

---

## 十、繁转简：为什么内置词表，而不是让模型顺手翻

### 为什么必须有

实测：本机 whisper small 对真实视频人声输出的**就是繁体**。
真实视频（174.6 s / 1280×720 / aac）前 20 秒：

```text
花四個月時間給貓咪小鎮做的地鐵站和地鐵今天終於通車了
```

不改的话，用户看到的第一次成功输出就是「一堆繁体」。这不是模型没听懂，
是 whisper 的中文输出习惯 —— 插件不能把这个问题甩给用户。

### 为什么是查表，不是再调一次模型

| 方案 | 成本 | 确定性 | 风险 |
|---|---|---|---|
| 让视觉/汇总模型顺手翻译 | 多一通调用 | 低（每次措辞不同） | 模型会**顺手改写内容**，转录就不再是转录 |
| 第三方 npm 繁简包 | 加依赖 | 中 | 装包失败整条链路受影响；离线环境直接挂 |
| **内置 OpenCC 词表纯查表** | 零 | 高（同一输入永远同一输出） | 词表缺失时要能 fail-open |

选第三种。`lib/util/t2s.js` + `assets/opencc/`（`TSCharacters.txt` / `TSPhrases.txt`，
OpenCC 数据，Apache-2.0）：**先短语表整段替换，未命中再单字表逐字查**。
短语表在前是因为「乾」这类字单看无法判断（乾隆 / 干净），短语才能定。

### 为什么 fail-open

词表缺失或读不出来时**原样返回、不报错**。理由：繁转简是**后处理**，
它失败不该让「已经跑完的抽帧 + 转写 + 视觉推理」全部作废 —— 那才是真正的浪费。
代价是繁体漏出来时用户不知道为什么，所以转换段数记在内部字段 `detected.t2s.converted`
（只在 `detected` / `failures` 里，**不进输出 schema**，因为它是实现细节不是理解结果）。

---

## 十一、v0.1 明确没做（以及为什么）

| 没做 | 为什么 |
|---|---|
| 生成视频 | DSH 内置目录没有 `type: "video"` 模型，必须接外部 API；架构已留位（注册表） |
| 前端 bundle / 设置页 UI | 9 个配置项用 cordis 配置 schema 就够，自定义 UI 是纯成本；因此 `exports` 里没有 `./client` |
| function calling 版重采样 | 结构化 JSON 更确定、更可测；tool-call 变体留作后续升级 |
| 能力之间互调 | 会让预算与闸门跨能力失效；真要组合走宿主会话 |
| 自定义 DAG 调度器 | 七步管线是固定的，没有第二个用法；等第三个能力进来再说 |
| 局部 crop | 看清小字得先裁出那一块再送；reframe 只买到时间密度，4096 在附件层就被压回 2730（见第三节） |

# dsh-video · 看懂视频

给 DSH 加一个 `video_understand` 工具：**看画面 + 听声音 + 对时间轴**，
把一个本地视频变成结构化结果 —— 分场景的画面描述、屏幕上的文字、动作、
带毫秒时间戳的语音转录、全局总结，以及针对你提问的直接回答。

> ## 这是「理解」视频，不是「生成」视频
> 它不会写 mp4、不会剪辑、不会配音、不会生成画面。
> DSH 内置模型目录里**没有任何 `type: "video"` 的模型**，生视频必须走外部 API，是另一件事。
> v0.1 只做理解；架构上给「生成 / 剪辑 / 字幕」留了位置（能力注册表，见 [`docs/ARCH.md`](docs/ARCH.md)）。

---

## 它能干什么 / 不能干什么

| 能 | 不能 |
|---|---|
| 告诉你这段视频大致讲了什么 | 生成新视频 |
| 说出第几分钟出现了什么画面、屏幕上是哪几个字 | 剪辑 / 拼接 / 转码导出 |
| 把语音转成带时间戳的文字（长视频分块并发，不是只取第一句） | 生成字幕文件、烧进画面 |
| 按你的问题直接回答（「结尾那个二维码是干什么的」） | 实时分析（它是离线的批处理管线） |
| 模型觉得某 2 秒看不清时，自己要求重新特写那一段 | 保证 100% 准确（没意识到的细节它也可能错） |

状态：v0.1，能力①（理解）在实现中。装法 / 配置 / 输出契约已经定稿，见下。

---

## 依赖

三个外部二进制，缺了插件会明确报错，不会静默降级：

| 依赖 | 本机默认位置 | 说明 |
|---|---|---|
| ffmpeg | `$DSH_HOME\bili-whale\bin\ffmpeg.exe` | 抽帧、抽音轨、场景检测、静音检测 |
| ffprobe | `$DSH_HOME\bili-whale\bin\ffprobe.exe` | 读时长 / 分辨率 / 帧率 / 有没有音轨 |
| whisper-cli | `$DSH_HOME\voice\whisper\bin\Release\whisper-cli.exe` | whisper.cpp 的 CPU 版命令行 |
| whisper 模型 | `$DSH_HOME\voice\whisper\ggml-base.bin`（141 MB）、`ggml-small.bin`（465 MB） | `quick` 档用 base，`standard` / `deep` 用 small |

`$DSH_HOME` 的含义：环境变量 `DSH_HOME` 优先，否则 `%USERPROFILE%\.dsh`。
**这些默认值全部由 `$DSH_HOME` 推导，仓库里没有任何硬编码绝对路径。**
你的 whisper 装在别处（或干脆装在系统 PATH 里）都行 —— 解析顺序是
`config` > 环境变量（`DSH_VIDEO_WHISPER_BIN` 等）> **系统 PATH** > `$DSH_HOME` 推导的默认位置。

> 早期的一份需求文档把 whisper 写成某个固定的用户主目录路径，那在别的部署里并不成立；
> 所以这里只认推导与环境变量，**不认任何写死的路径**。

还需要：一个 **`input` 含 `image` 的模型**（见下方「已知限制」第 3 条）。

---

## 安装

仓库：<https://github.com/owl-zxk/dsh-video>（MIT）

### 先装这三样（不装会明确报错，不会静默降级）

**① ffmpeg + ffprobe** —— 抽帧、读时长全靠它。任选一种：

```powershell
winget install Gyan.FFmpeg      # 或 scoop install ffmpeg / choco install ffmpeg
ffmpeg -version                  # 装完确认在 PATH 里
```

**② whisper.cpp**（CPU 版，做语音转录）—— 从官方 release 解压即可，不用编译：

```powershell
# 1. 下载 whisper-bin-x64.zip：https://github.com/ggml-org/whisper.cpp/releases
# 2. 解压到 $env:DSH_HOME\voice\whisper\ ，让 exe 落在 bin\Release\ 下
#    （解压后目录结构已就是这样，整个 Release 文件夹搬过去即可）
# 3. 下模型（base 141MB / small 465MB，二选一或都下）：
#    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
#    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
#    国内慢就用镜像：https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
$env:DSH_HOME\voice\whisper\          # ← 最终长这样：
#   bin\Release\whisper-cli.exe
#   ggml-base.bin
#   ggml-small.bin
```

> 已经装在别处也行：设 `DSH_VIDEO_WHISPER_BIN` / `DSH_VIDEO_WHISPER_DIR`，
> 或者把 `whisper-cli` 放进 PATH。**没有 whisper 只是没有转录**，画面分析照常，
> `failures` 里会写清缺哪个文件 —— 不会假装成功。

**③ 一个能吃图的模型** —— 插件会在送图前校验 `inputModalities` 含 `image`，
选错了明确报错而不是把图换成占位符。默认值写的是 `deepseek-account/deepseek-flash`，
但**各家部署的 provider 名不一样**：默认值在你的宿主里不存在时，插件会**自动从宿主里挑一个
吃图的模型**并在 `failures` 里记一条说明。也可以在设置界面直接选（见下）。

### 方式 A：一行装（推荐）

```powershell
dsh plugin --profile desktop add "https://github.com/owl-zxk/dsh-video/tarball/main"
```

直接指向仓库 tarball，装完重启 DSH 即可 —— 不用 clone、不用管目录放哪。

### 方式 B：克隆到本地再 link（改代码时用这条）

```powershell
# 目标目录自己定，习惯上放在 $DSH_HOME 下（别放进 DSH 安装目录树，见下方警告）
git clone https://github.com/owl-zxk/dsh-video.git "$env:DSH_HOME\dsh-video-src"
dsh plugin --profile desktop add "link:$env:DSH_HOME\dsh-video-src"
```

> ⚠️ **别把它 link 到 DSH 安装目录树里**（比如 `...\DSH NEXT\` 下面）。
> 宿主的模块解析插桩覆盖不到那种路径，插件里的宿主包解析会失败。
> 上面用的 `$DSH_HOME\...` 是安全位置（与 `lanpangzi-src` / `whale-src` 同级）。

克隆下来后先自检依赖（ffmpeg / whisper）：

```powershell
cd "$env:DSH_HOME\dsh-video-src"
$env:DSH_HOME = "$env:DSH_HOME"   # 已有就不用设；缺了会回落到 %USERPROFILE%\.dsh
node --test --test-isolation=none tests/media.test.mjs   # 抽帧与 probe 需要 ffmpeg
```

> 真用例（抽帧 / 转写 / 端到端）需要找到 ffmpeg 与 whisper，找不到会**跳过**而不是失败。
> 解析顺序：`config` > 环境变量（`DSH_VIDEO_FFMPEG` 等）> **系统 PATH** > `$DSH_HOME` 推导的默认位置。
> 所以最省事的做法是把 ffmpeg 放进 PATH；或者显式设 `DSH_HOME` 指向装了它的那份 DSH。
### 方式 C：手改 profile（没有 `dsh` 命令时）

编辑 `%DSH_HOME%\profiles\desktop\package.json`：

```jsonc
{
  "dependencies": {
    // 二选一：tarball（不用 clone）或本地 link（改代码时）
    "dsh-video": "https://github.com/owl-zxk/dsh-video/tarball/main"
    // "dsh-video": "link:<你 clone 下来的目录>"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-video"]
    }
  }
}
```

**装完必须重启 DSH** —— bundle 列表在启动时读一次。

### ⚠️ 一个能让启动直接崩的坑

`cordis.patch.yml` 里的 `id` 在**整份 profile 的 patch 链里只能出现一次**。
手改过 profile、又跑过一次 `dsh plugin add` 的话，会插进去两条同名实例，
宿主启动直接崩，而且报错不会指向这个文件。装完在 profile 目录里搜一下有没有重复条目，
有就删掉一条再重启。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-video
```

或者把上面那两处手改的字段删掉，重启。

---

## 配置

插件 Config 就这 9 个键，全部可选：

| key | 默认值 | 说明 |
|---|---|---|
| `ffmpeg` | `$DSH_HOME/bili-whale/bin/ffmpeg.exe` | ffmpeg 可执行文件 |
| `ffprobe` | `$DSH_HOME/bili-whale/bin/ffprobe.exe` | ffprobe 可执行文件 |
| `whisperBin` | `$DSH_HOME/voice/whisper/bin/Release/whisper-cli.exe` | whisper 命令行 |
| `whisperDir` | `$DSH_HOME/voice/whisper` | 模型目录（从中挑 `ggml-<name>.bin`） |
| `provider` | `deepseek-account` | 模型路由的 provider 部分（**本机实际的 provider 名**） |
| `model` | `deepseek-account/deepseek-flash` | 默认视觉模型（= DeepSeek-V4.1-Flash，`inputModalities` 含 image），三档 `detail` 都是它 |
| `lang` | `zh` | 音频语言。**不要用 `auto`** —— 中文靠自动检测会偶发误判 |
| `concurrency` | `min(4, max(2, cpus - 2))` | 视觉批次 / whisper 分块的并发上限 |
| `maxWallClockMs` | `300000`（5 分钟） | **模型调用阶段**（视觉批次 / reframe / merge）的墙钟上限；超了停在当前进度返回部分结果。**不含抽帧与转写**，见下方说明 |
| `detail` | `standard` | **默认档位**。工具调用时传 `detail` 会覆盖它；这一项是「不传时用哪一档」 |

**配置存在哪、什么时候生效**：`$DSH_HOME/dsh-video.config.json`（不是 profile 的 `cordis.patch.yml`）。
宿主侧**每次调用工具时都重读这个文件**，所以改完下一次调用就生效，**不用重启**。
优先级：配置文件 > 环境变量 > 内置默认。profile 里 `dsh-video` 的 `config:` 仍然可写，作为最底层的 base。

**每个二进制的解析顺序（逐级回退）**：

```
显式 config  >  环境变量  >  $DSH_HOME 默认值  >  PATH
```

| 二进制 | 环境变量（优先） | 环境变量（其次） |
|---|---|---|
| ffmpeg | `DSH_VIDEO_FFMPEG` | `FFMPEG` |
| ffprobe | `DSH_VIDEO_FFPROBE` | `FFPROBE` |
| whisper-cli | `DSH_VIDEO_WHISPER_BIN` | — |
| whisper 模型目录 | `DSH_VIDEO_WHISPER_DIR` | — |

`video_understand` 的入参优先于这里的 config（单次覆盖，不写回）。

### ⚠️ `maxWallClockMs` 只管模型调用阶段

它**只拦住模型调用**（视觉批次 / reframe / merge），**不管抽帧、也不管转写**：

| 阶段 | 会被 `maxWallClockMs` 拦住吗 | 为什么 |
|---|---|---|
| 抽帧 | ❌ 要跑完 | 中途停会让帧数被动减少 —— 那正是「为了快静默降准」，明令禁止 |
| 转写 | ❌ 要跑完 | whisper 跑完一遍才有结果，中断等于把已经花掉的时间全部丢掉 |
| 视觉批次 / reframe / merge | ✅ 拦住 | 这些按批推进，停在批次边界不损失已完成的工作 |

所以**一个 3 分钟视频配慢 CPU，把 `maxWallClockMs` 设成 1 秒也会等转写跑完**。
这是刻意的取舍：宁可慢，也不制造「以为看全了、其实少看了」的结果。
真的被截断时会在 `failures` 里如实写明截断发生在哪一步，不会假装做过。

---

## 用法

装好重启后直接让模型调工具，例如：

> 「用 `quick` 看一眼 <你的视频路径> 讲的是什么」
>
> 「`deep` 读一下这段视频里出现的所有字幕，顺便说说第 3 分 20 秒那个画面右下角的字是什么」

### `video_understand` 入参

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `path` | string | **必填** | 本地视频文件路径 |
| `question` | string | — | 你关心的问题。不给就做通用理解，此时 `answer` 等于 `summary` |
| `detail` | `quick` / `standard` / `deep` | `standard` | 档位，决定帧数 / 批大小 / 自适应轮数 / 成本上限 |
| `maxFrames` | number | 按 `detail` 推导 | 覆盖首轮帧数上限 |
| `lang` | string | `zh` | 音频语言 |
| `model` | string | 按 `detail` 推导 | 覆盖视觉模型，如 `deepseek-account/deepseek-flash`。**`provider` 写错会得到 `NO_ADAPTER`** —— PROMPT.md 里的 `deepseek/deepseek-v4.1-flash` 在这台机器上不存在 |
| `adaptive` | boolean | 按 `detail` 推导 | 是否开启自适应重采样 |
| `maxRounds` | number | 按 `detail` 推导 | 重采样轮数上限；**`0` = 完全关闭** |
| `concurrency` | number | 按 CPU 核数推导 | 并发上限 |
| `maxWallClockMs` | number | `300000` | **模型调用阶段**的墙钟上限（不含抽帧 / 转写）；超时返回部分结果并在 `failures` 里写明 |

### `detail` 三档：成本 / 质量取舍

| detail | 首轮帧数 | 批大小 | 重采样轮数 | 额外帧上限 | 成本闸门 | 用途 |
|---|---|---|---|---|---|---|
| `quick` | 6 | 6 | 0（关） | 0 | $0.02 | 先看一眼值不值得细看 |
| `standard` | 16 | 8 | 1 | 12 | $0.10 | 默认 |
| `deep` | 40 | 10 | 2 | 24 | $0.40 | 字幕 / 文字 / 动作多的视频 |

档位是**用户显式选的**。插件不会为了跑快一点偷偷降档或减帧 —— 那是拿准确率换时间。

---

## 输出

永远是同一个结构，字段不省略、不给 `undefined`（缺数据给空数组 / `0`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | string | 源文件名 |
| `durationMs` | number | 时长（毫秒） |
| `width` / `height` | number | 分辨率 |
| `fps` | number | 帧率 |
| `hasAudio` | boolean | 有没有音轨（没有是**正常情况**，不是错误） |
| `model` | string | 实际用的视觉模型 |
| `framesAnalyzed` | number | 实际送进模型的帧数 |
| `reframes` | array | 重采样记录 `{ round, startMs, endMs, reason, kind, frames, accepted, rejectReason? }`；没触发就是 `[]`。`reason` 是模型给的原文理由；`rejectReason` **只在 `accepted: false` 时出现**，取值见下表 |
| `scenes` | array | `{ startMs, endMs, frames, visual, onScreenText, actions }`，按 `startMs` 升序、区间不重叠不断裂 |
| `transcript` | array | `{ startMs, endMs, text }`，毫秒绝对时间戳 |
| `summary` | string | 全局总结 |
| `answer` | string | 针对 `question` 的直接回答；没给 `question` 时等于 `summary` |
| `failures` | array | `{ batch, reason }`：哪批挂了、为什么（含因超时截断） |
| `timings` | object | 分环节耗时，见下 |
| `concurrency` | number | 实际用的并发度 |
| `estimatedCostUsd` | number | 估算成本 |

### `reframes[].rejectReason` 取值

| 拒绝码 | 含义 |
|---|---|
| `duplicate` | 同一窗口签名（按秒取整）被请求过第二次 —— 防死循环的那道闸 |
| `kind-blur` | 模型自报 `kind: "blur"`：内容本身糊，重抽没用 |
| `too-short` | 窗口 < 300 ms |
| `too-long` | 窗口 > 30 s |
| `out-of-range` | 窗口越出 `[0, durationMs]` |
| `unknown-kind` | 不是 `detail` / `text` / `motion` / `blur` |
| `window-limit` | 单轮窗口数超过 `maxReframeWindows`（3） |
| `frame-budget` | 额外帧总数超过 `maxExtraFrames` |
| `cost-budget` | 成本超过 `maxCostUsd` |
| `round-limit` | 轮数超过 `maxRounds` |

---

## 耗时和成本：凭什么、怎么看

耗时由几段主导，`timings` 就照这个顺序拆（键名和顺序固定，8 个键一个不少）：

```jsonc
"timings": {
  "probeMs": 12,        // ffprobe 读元信息
  "framesMs": 8400,     // 场景检测（全片唯一一次全解码）+ 抽帧（seek）
  "audioMs": 21000,     // 抽 wav + whisper 转录（分块并发）
  "visionMs": 31500,    // 首轮各批视觉推理（并发）
  "reframeMs": 9000,    // 自适应重采样：特写重抽 + 增量推理
  "mergeMs": 4200,      // 全局汇总（串行，只带文字不带图）
  "totalMs": 74100,     // 各段之和
  "wallClockMs": 74300  // 真实墙钟
}
```

怎么读：

- `wallClockMs` 是真实耗时；`totalMs` 是各段相加。并发段会重叠，所以两者数值不必相等，
  只有 `wallClockMs` 是用户真正等的时间。
- 没跑的段记 `0`，**但键一定在** —— 不会少一个键让你以为没计时。
- 想优化先看谁大：一般是 `audioMs`（whisper 是 CPU 推理，最慢）和 `visionMs`（网络往返）。
- 超时截断时 `failures` 里有「因超时截断」的记录，`timings` 如实反映未完成的阶段 ——
  插件**不会**为了赶墙钟假装做过 reframe，也不会偷偷减帧。

成本由两部分决定：送多少图（每帧按视觉 token 网格计费）、跑多少轮。
`standard` 档一个 1 分钟视频通常在**几美分以内**；`deep` 档的 40 帧 + 2 轮重采样明显更贵。
三档分别有 $0.02 / $0.10 / $0.40 的硬闸门，超了就停，成本不会失控。

### 已实测的单项（本机 CPU-only，可以引用）

| 项 | 实测 |
|---|---|
| whisper small 转录 | 20 s 音频 → **5.65 s**（约 3.5× 实时，比原先估计的 2.8× 快） |
| 抽帧子进程调用次数 | 8 s / 25 fps / 640×360 → 约 **帧数 + 1** 次（场景检测 1 次全解码 + 每帧 1 次 seek） |
| 全套离线测试 | 88 个用例 / **10.4 s** |

### 端到端目标（`standard` 档，本机 CPU-only）

| 场景 | 目标 |
|---|---|
| 1 分钟 720p | ≤ 30 秒 |
| 10 分钟 720p | ≤ 2.5 分钟 |
| 30 分钟 1080p | ≤ 6 分钟 |

> ⚠️ **这张表是目标，没有在真宿主里实测过** —— 端到端需要真 API key，目前一次都没跑过
> （见「开发 / 端到端测试」）。上面那张单项表才是实测值。

whisper 只有 CPU 版，长音频的转录时间是主要变量。
超过 `maxWallClockMs`（默认 5 分钟）会截断并如实标注 —— 但只截断模型阶段，抽帧和转写会跑完。

---

## 繁转简

**为什么必须有**：本机实测，whisper small 对真实视频的人声输出的**就是繁体**。
用一段真实视频（174.6 s / 1280×720 / aac）的前 20 秒跑出来的是：

```text
花四個月時間給貓咪小鎮做的地鐵站和地鐵今天終於通車了
```

直接把这个端给用户，一半的人第一反应是「转错了」。所以插件内置繁转简：

| | |
|---|---|
| 实现 | `lib/util/t2s.js` + `assets/opencc/`（OpenCC 数据，Apache-2.0） |
| 策略 | 先查短语表（`TSPhrases.txt`）整段替换，未命中再按单字表（`TSCharacters.txt`）逐字查 |
| 依赖 | **零**。纯查表，不联网、不装包 |
| 失败行为 | **fail-open**：词表缺失或读不出来就原样返回，不报错、不中断转录 |
| 默认 | 开启。上例转换后：`花四个月时间给猫咪小镇做的地铁站和地铁今天终于通车了` |
| 可见性 | 转换段数记在内部字段 `detected.t2s.converted`（**不进输出 schema**） |

为什么不直接让模型顺手翻译：那会多一通调用、多一份不确定性，而且转录里混着专有名词时
模型容易「顺手改写」内容。查表改的是字形，不是内容。

---


## 给其它插件用（编程接口，不走工具）

除了给模型用的 `video_understand` 工具，本插件还注册了一个 **cordis 服务**，
别的 DSH 插件可以直接调用它 —— 不需要 import 本包，也不需要知道它装在哪。

服务名：**`videoUnderstand`**

```js
// 你的插件：把 videoUnderstand 声明成依赖，它出现前不会被激活
export const inject = ['videoUnderstand']

export function apply (ctx) {
  // 参数与 video_understand 工具**完全同形**，不用学第二套
  return ctx.effect(() => {
    // …某个时机
  })
}

// 用的时候：
const result = await ctx.videoUnderstand.understand({
  path: 'D:/videos/demo.mp4',
  detail: 'quick',            // quick | standard | deep
  question: '这个视频在讲什么？', // 可选
})
```

> 不想硬依赖就不写进 `inject`，改用 `const svc = ctx.get('videoUnderstand')` 判空 ——
> 本插件没装或被禁用时前者不会激活你的插件，后者拿到 `undefined`，按需要选。

### 方法

| 方法 | 说明 |
|---|---|
| `understand(args, options?)` | 理解一个视频（能力 ① 的便捷入口）。`args` 同工具参数 |
| `run(capabilityId, args, options?)` | 通用入口：按能力 id 调用。将来加「生成视频 / 剪辑 / 字幕」时这里不用改 |
| `capabilities()` | 返回 `[{ id, tool, description }]` —— 当前有哪些能力 |

`options`：

| 键 | 说明 |
|---|---|
| `signal` | `AbortSignal`，中途取消 |
| `config` | **本次调用**的临时配置覆盖（例如只这一次换视觉模型），不写配置文件、不影响别的调用方 |

### 错误语义（和工具刻意不同）

| 情况 | 行为 |
|---|---|
| 能力 id 不存在 / 传空 | **抛** `UNKNOWN_CAPABILITY` / `INVALID_CAPABILITY` |
| 视频坏了、模型挂了、whisper 缺 | **不抛**，返回结构化结果，`failures` 非空 |

分界线是「谁写错了」：调用方写错参数是**编程错误**，必须立刻炸出来；
而模型或媒体失败是**运行时现实**，工具和服务的承诺都是返回结构化的部分结果。

工具与服务共用同一条依赖装配路径（`shared.callDeps`）—— 不会出现「工具校验了图片预算、
服务却绕过」这种两条路径分叉的事故。
## 设置界面（改完即时生效，不用重启）

DSH「设置」里有一页「**视频理解**」：

| 可编辑 | 说明 |
|---|---|
| 视觉模型 | 下拉含两个实测过的候选（`deepseek-account/deepseek-flash` 推荐 / `minimax-cn/MiniMax-M3`），也可手填任意路由 |
| 默认档位 | `quick` / `standard` / `deep`，即「不传 `detail` 时用哪档」 |
| 并发度 | 视觉批次 / whisper 分块上限；留空按 CPU 核数推导 |
| 墙钟上限 | **按分钟输入**（0.5–60，步进 0.5），留空 = 5 分钟；底层存储仍是毫秒（`maxWallClockMs`），只是界面不让人读 300000 |
| 音频语言 | 默认 `zh` |
| 依赖路径（折叠） | ffmpeg / ffprobe / whisper-cli / whisper 模型目录，平时不用改 |

页面底部有「当前实际生效」只读回显 —— 它按**优先级合并后**的真实值显示，
所以「我明明填了却没生效」这种情况一眼能看出来。

界面 ⇄ 同源 `/dsh-video/api/config`（GET 读 / POST 写）⇄ `$DSH_HOME/dsh-video.config.json`，**写是原子的**（同目录临时文件 + rename）。
非回环来源一律 403；留空表示「清除这一项、回落到默认」。

## 已知限制

1. **CPU-only，慢。** whisper.cpp 是 CPU 版（无 CUDA / Metal）。30 分钟 1080p 的视频，
   光转录就可能占掉大部分墙钟时间。想快就用 `quick` 档，或者自己换一个带 GPU 的 whisper 构建。
   注意 `maxWallClockMs` **不会**让转写变快 —— 它只管模型调用阶段（见「配置」那节）。
2. **whisper 输出的就是繁体（已内置转换）。** 本机实测 whisper small 对真实人声输出繁体，
   所以插件带繁转简（`lib/util/t2s.js` + `assets/opencc/` 词表，默认开启，见下方「繁转简」一节）。
   转换是纯查表、**失败即放行**（词表缺失就原样返回、不报错）。极少数专有名词仍可能转不干净。
3. **多数 DeepSeek 模型不支持图片。** `deepseek-v4-pro` / `v4-pro-0813` / `v4-flash` / `v3.2`
   都是**纯文本**模型。选错模型时插件会在送图**之前**校验 `input` 是否含 `image`，
   throw 一个 `.code = 'MODEL_NOT_VISION'` 的明确错误 ——
   **不会**把图替换成占位符再让模型「看不见还硬编」。
4. **视觉模型怎么选：本机两个候选的实测对比（2026-10-31，同一段 174.6 s / 1280x720 视频，`standard` 档，同一个问题）：**

   | | `deepseek-account/deepseek-flash`（默认） | `minimax-cn/MiniMax-M3` |
   |---|---|---|
   | `visionMs` | **11 331** | 76 885（慢 6.8×） |
   | 总耗时 | **89.6 s** | 173.8 s（慢 1.9×） |
   | 画面文字 | 站名/线路/文明标语基本读对，**主动承认看不到的过程** | 召回更多，但含 `COVACS`（应 ECOVACS）、`Xiaoyingzhuang? Station`（自己带问号）、`机站能在地堡回洗的渐溪`（不成句） |
   | 一轮索要特写窗口 | 4 个（1 个被 `window-limit` 挡） | 8 个（**5 个被挡**） |
   | 成本可算 | ✅ 有完整 image token 计算器 | ❌ 没有，`estimatedCostUsd` 会算不准 |

   结论：**默认用 `deepseek-account/deepseek-flash`**。要更多文字召回、且能容忍偶发编造时，
   手动传 `model: 'minimax-cn/MiniMax-M3'`。想换默认：改 `lib/util/paths.js` 的 `DEFAULT_MODELS`，
   或在 profile 配置里写 `model:`（优先级更高，不用改代码）。

   ⚠️ 顺带纠两个 PROMPT.md 里**实测不成立**的值：`deepseek/deepseek-v4.1-flash` 那个 provider 不存在
   （本机 provider 叫 `deepseek-account`，模型 id 是 `deepseek-flash`），用它只会得到 `NO_ADAPTER`。
4. **图片有硬预算。** 一次请求里的图超过路由的 `LlmImageRequestBudget` 会抛
   `IMAGE_OFFLOAD_REQUIRED`。所以帧是**分批**送的（批大小 6 / 8 / 10），绝不一次发几十张。
5. **单帧 ≤ 2 MiB。** 超了降质量重编一次。首轮长边压到 1708 px（DeepSeek 16:9 的实际发送尺寸），
   重采样特写用 **2730 px**（附件层归一化上限），不是 4096。
   原因：图片会被压**两次** —— 附件层 `normalizedImageMaxPixels = 4,194,304`（16:9 约 2730×1536），
   再叠加适配器的 1708×961。实测 `estimateImageTokens(2730×1536) === estimateImageTokens(1708×961) === 968`，
   所以抽 4096 **没有任何空间分辨率收益**，只是多花解码和 IO。
   重采样的真收益是**时间密度**（窗口内每 0.5 s 一帧），不是「看得更清楚」；
   要看清局部细节得先 crop，v0.1 明确没做。
6. **没有音轨不算错。** `hasAudio: false` + 空 `transcript`，纯画面照样能理解。
7. **whisper 缺失不会整体崩。** 转录失败进 `failures`，画面结果照常返回。
8. **只吃本地文件。** 不吃 URL，先下载 / 挂载到本地再传 `path`。

---

## 设计决策

**1. `exports` 里没有 `./client`。**
模板（`dsh-lanpangzi`）留了 `"./client": "./lib/client.js"` 和 `scripts.build`，
因为它有前端 bundle。本插件**不做前端 bundle**：设置项完全由 cordis 配置 schema 生成，
没有自定义 UI。留一个指向不存在文件的导出，后果是 `import('dsh-video/client')` 要到运行期
才炸（`ERR_MODULE_NOT_FOUND`），而不是装的时候就暴露。所以 `exports` 只有 `"."` 和
`"./package.json"`，`dsh.client` 整段去掉，`scripts` 里没有任何 build 脚本。

**2. `files` 里有 `assets/`，没有 `scripts/`。**
`assets/opencc/` 是**运行时必需数据**：繁转简词表（`TSCharacters.txt` 104,520 B、
`TSPhrases.txt` 9,177 B，OpenCC 数据，Apache-2.0）。少打这个目录，装出来的插件转录就是繁体。
`scripts/` 相反：只有测试素材生成器，属于开发期工具，随源码留在仓库里但不必进包。
`lib` / `assets` / `cordis.patch.yml` / `README.md` / `docs` 就是运行时要的全部。

**3. `repository` / `homepage` / `bugs` 三个字段都写全。**
缺 `repository` 的包在 `dsh plugin add` 时拿不到源地址，报错信息会很难读。

**4. 文档分两份，不合并。**
`README.md` 回答「这是什么、怎么装、怎么用、要多久多少钱」；
`docs/ARCH.md` 回答「为什么这么设计」。
混在一份里会让第一次来的人先读三千字设计说明才找到安装命令。

**5. JPEG 质量不直接写进 `-q:v`。**
ffmpeg 的 `-q:v` 是 **qscale**：2 最好、31 最烂，**方向和 libjpeg quality 相反**。
把 quality 85 直接塞进 `-q:v 85` 会得到一张糊图；实现里换算成 `-q:v 6`。这是 A 组实际踩到的坑。

---

## 开发

```powershell
npm test          # node --test tests/*.test.mjs，离线，不需要 API key
```

| 命令 | 什么时候用 |
|---|---|
| `npm test` | 真实终端 / CI：默认测试隔离，每个测试文件独立进程 |
| `npm run test:local` | **DSH 沙箱内的会话里跑测试用这个** |

> ⚠️ **在 DSH 沙箱里必须用 `npm run test:local`。**
> `node --test` 的默认测试隔离会给每个测试文件 spawn 一个子进程、并用管道收它的输出，
> 而沙箱禁止命名管道 → `spawn EPERM (errno -4048)`，一个测试都起不来。
> `test:local` 加了 `--test-isolation=none`，在同一个进程里跑同一批测试文件，能过。
> 两者跑的是同一批用例，区别只在执行方式，不是「沙箱里跑的是精简版」。

测试素材用 ffmpeg 现生成（`scripts/make-fixture.mjs`），不下载任何东西，
产物落在 `test-assets/`（已在 `.gitignore` 里）。
单元测试一律注入 fake（fake llm / fake attachments / fake ffmpeg runner），
不为测试去 mock 全局 `child_process`；需要真二进制的用例在文件顶部检测，缺了就 skip。

### 端到端测试（默认 skip）

`tests/e2e.test.mjs` 默认 **skip，不是失败** —— 要两个条件同时满足才会真跑：

1. 环境变量 `DSH_VIDEO_E2E=1`
2. 宿主注入 `globalThis.__dshVideoE2E = { llm, attachments, provider?, model? }`

缺任何一个都 skip。原因很直接：真宿主侧的 `ctx.llm` / `ctx.attachments` 只存在于宿主进程，裸 node 拿不到
真的 llm / attachments，硬跑只会得到一个假绿 —— 假绿比 skip 危险。

> ⚠️ **真 API key 的那条路径一次都没跑过。** 上面这组条件是为了让它**可跑**，不是证明它跑通了。
> 已验证的是 88 个离线用例（沙箱内 `npm run test:local`，10.4 s 全绿）。

架构、管线七步、闸门设计见 [`docs/ARCH.md`](docs/ARCH.md)；接口契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

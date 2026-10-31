# dsh-video 接口契约（v0.1）

> 这是**唯一事实来源**。四个并行 subagent 各自实现自己的文件，都必须照这里写；
> 任何偏离都要先回来改这份文件，不许在代码里各写一份"差不多的"形状。
>
> 为什么需要它：这批文件之间是调用关系（understand → frames/audio/vision），
> 并行开发时契约一旦漂移，集成阶段就要重写。把形状钉死，集成只是接线。

## 0. 本机环境事实（已实测；PROMPT.md 里的 whisper 路径是错的）

| 项 | 实际值 |
|---|---|
| ffmpeg / ffprobe | \DSH\dsh-home\bili-whale\bin\{ffmpeg,ffprobe}.exe  ✅ 存在 |
| whisper-cli | \DSH\dsh-home\voice\whisper\bin\Release\whisper-cli.exe ✅ |
| whisper 模型 | \DSH\dsh-home\voice\whisper\ggml-base.bin（141MB）、ggml-small.bin（465MB） ✅ |
| ~~PROMPT.md 写的 C:\Users\Administrator\.dsh\voice\whisper\...~~ | ❌ **不存在**（C:\Users\Administrator\.dsh 下只有 electron-user-data 和 logs） |

→ whisper 根目录一律按 $DSH_HOME/voice/whisper 解析（DSH_HOME 环境变量优先，否则
%USERPROFILE%\.dsh），与 dsh-bili-whale/tools/lib/paths.mjs 完全一致。

**解析优先级（每个二进制都一样）**：显式 config > 环境变量 > $DSH_HOME 默认 > PATH。

| 二进制 | 环境变量 |
|---|---|
| ffmpeg | DSH_VIDEO_FFMPEG，其次 FFMPEG |
| ffprobe | DSH_VIDEO_FFPROBE，其次 FFPROBE |
| whisper-cli | DSH_VIDEO_WHISPER_BIN |
| whisper 模型目录 | DSH_VIDEO_WHISPER_DIR |

## 1. 代码风格（本机既有约定，硬性）

- ESM（import/export），**2 空格缩进**，**不写行尾分号**（既有插件就是这个风格）
- **文件头注释写"为什么这样写"**（踩过的坑、取舍），不写"做了什么"
- 所有子进程一律 spawn/execFile + **参数数组**；禁止拼命令字符串，禁止 shell: true
  （PowerShell 会把 $i:v 当变量吃掉，[0:v]scale= 会变成 scale=）
- ffmpeg 相关一律 **async spawn**（child_process.spawn + Promise），不用 spawnSync
  —— 帧抽取与视觉批次要并发，同步调用会卡住事件循环，把并发变成假并发
- 每个文件落地后跑 node --check <file>
- 不要在 lib/ 里写死任何绝对路径常量（除 util/paths.js 的默认值表）

## 2. 固定常量（一处定义，全部引用）

lib/llm/budget.js 导出 DETAILS：

| detail | maxFrames | batchSize | maxRounds | maxExtraFrames | maxCostUsd |
|---|---|---|---|---|---|
| quick | 6 | 6 | 0 | 0 | 0.02 |
| standard | 16 | 8 | 1 | 12 | 0.10 |
| deep | 40 | 10 | 2 | 24 | 0.40 |

lib/util/paths.js 导出 DEFAULT_MODELS（按 detail 推导），三档都默认
**`deepseek-account/deepseek-flash`** —— 这是本机**实测**出来的真实路由：
本机 provider 叫 `deepseek-account`（profile 的 `agent-default-model` 就是它），适配器目录里的模型 id
是 `deepseek-flash`（`name: DeepSeek-V4.1-Flash`、`inputModalities: ["text","image"]`）。
PROMPT.md 写的 `deepseek/deepseek-v4.1-flash` 会得到 `NO_ADAPTER`，那个 provider 不存在。
provider 部分由 config.model 第一个斜杠拆开；config.model 覆盖时以它为准。

lib/media/reframe.js 导出闸门默认值：
maxWindowMs = 30000、minWindowMs = 300、maxReframeWindows = 3（单轮）、
reframe 特写长边 = **2730 px**、首轮长边 = **1708 px**、JPEG 质量 = **85**（libjpeg 语义；
**实现里必须换算成 ffmpeg 的 `-q:v` qscale**：qscale 2 最好 / 31 最烂，方向与 quality 相反。
直接把 85 塞给 `-q:v` 会得到糊图。换算表在 frames.js 的 qscale 函数里，85 → 6）、
（为什么不是 4096：见 §19.4 —— 附件层会把超过 4,194,304 像素的图降采样，16:9 下 2730×1536 正好顶满。
抽到 4096 只是白花解码与磁盘 IO，到模型眼前还是同一尺寸。）
单帧字节上限 = **2 MiB**（超了降质量重编一次）。

**totalMs 与 wallClockMs 的语义**（两个人会实现出两种，这里钉死）：
两者**都取墙钟**，不是各段之和（并发段在时间上重叠，求和会得出比真实耗时更大的假数字）。
`totalMs` 允许被显式 `stop('totalMs')` 覆盖（把「实际量到的时间」钉死），否则等于 wallClockMs。

固定 timing 键名（顺序也要照这个写）：
probeMs, framesMs, audioMs, visionMs, reframeMs, mergeMs, totalMs, wallClockMs

## 3. lib/util/paths.js

- export const DSH_HOME                // string
- export const DEFAULT_BINARIES        // { ffmpeg, ffprobe, whisperBin, whisperDir }
- export const DEFAULT_MODELS          // { quick, standard, deep }
- export function resolveBinaries(config = {}) // -> { ffmpeg, ffprobe, whisperBin, whisperDir }（找不到不抛，返回候选）
- export function requireBinaries(config = {}) // -> 同上，但 ffmpeg/ffprobe 缺失时 throw（.code = 'BINARY_MISSING'）
- export function whisperModelPath(dir, name)  // -> <dir>/ggml-<name>.bin
- export function existingModel(dir, prefer)   // -> 真实存在的模型名（prefer 优先，退回 small > base）
- export function tmpWorkspace(prefix)         // -> fs.mkdtempSync 建的临时目录
- export function splitRoute(model)            // 'deepseek-account/deepseek-flash' -> { provider:'deepseek-account', model:'deepseek-flash' }
  （没有斜杠时 provider 取 config.provider，再缺省 'deepseek'）

config 形状（插件 Config schema 就是它）：
{ ffmpeg, ffprobe, whisperBin, whisperDir, provider, model, lang, concurrency, maxWallClockMs }

## 4. lib/util/perf.js

- export function createTimers(now = Date.now)
  // .start(name) / .stop(name) / .span(name, fn) / .timings() / .wallClockMs()
  // timings() 一定包含 §2 的全部 8 个键；没跑的段记 0（不要漏键）
- export function deadline(maxWallClockMs, now = Date.now)
  // .exceeded() / .remainingMs() / .elapsedMs() / .assert()
- export class TimeoutError extends Error  // .code === 'WALL_CLOCK_EXCEEDED'

## 5. lib/media/ffmpeg.js

- export async function run(bin, args, { timeoutMs = 120000, signal, encoding = 'utf8' } = {})
  // -> { ok: boolean, status: number|null, stdout: string, stderr: string, code?: string }
  // **永不 throw**。code 的完整集合（所有组按同一套分支，不许各造）：
  //   TIMEOUT | ABORTED | SPAWN_FAILED（二进制起不来/路径无效） | EXIT_NONZERO（起来了但退出码非 0）
- export async function ffmpeg(binPath, args, opts)        // 自动前置 ['-hide_banner','-loglevel','error']
- export async function ffprobeJSON(binPath, args, opts)   // -> 解析后的对象 | null

**可注入的 run**：§6–§9 的每个函数都额外接受一个可选 `runImpl`（签名同 `run`，默认就是本模块的
`run`）。这是唯一的子进程接缝 —— 测试靠它统计 spawn 次数（例如断言"场景检测只全解码一次"、
"抽帧是 seek 不是全量"）和制造失败（降级路径）。不要为了测试去 mock `child_process`。

## 6. lib/media/probe.js

- export function parseProbe(json)   // 纯函数
- export async function probe(path, { ffprobe: bin, timeoutMs } = {})

Meta：{ durationMs, width, height, fps, hasAudio, videoCodec, audioCodec, sampleRate, channels, sizeBytes }

无视频流 → throw（.code = 'NO_VIDEO_STREAM'）；读取/解析失败 → .code = 'PROBE_FAILED'。
无音轨是**正常情况**：hasAudio:false，绝不抛错。

## 7. lib/media/frames.js

- export async function detectScenes(video, { ffmpeg: bin, threshold = 0.3, timeoutMs = 600000 } = {})
  // -> number[] 毫秒，升序；失败 -> []      ← 全片**唯一一次**全解码
- export function planFrames({ durationMs, sceneTimes = [], maxFrames })
  // 纯函数：三组合并 + 去重(0.5s 容差) + 场景点优先 + 升序 + 截断到 maxFrames
  // 必含首帧(0)与尾帧(durationMs-1)
- export async function extractFrame(video, ms, { ffmpeg: bin, outFile, longEdge = 1708, quality = 85 })
  // -> { file, bytes, width, height } | null   失败重试 1 次
- export async function extractFrames(video, plan, { ffmpeg: bin, dir, longEdge, quality, concurrency = 4, onProgress })
  // -> Array<{ index, ms, file, bytes }>  ；顺序与 plan 一致，index 从 0 开始
  // 帧数 < 40 → 逐帧 seek；否则一次 fps 全量输出后按时间戳挑；受 concurrency 限流

planFrames 不变量（测试直接断言）：index 由下标决定；ms 单调递增；ms ∈ [0, durationMs]；
**0.5 s 容差只用于「去重」，不是「最小间隔」** —— 短片（durationMs < 1000）里首帧 0 与尾帧
durationMs-1 天然间隔 < 500 ms，那是正常的，不许为了让间隔看起来达标而插入假帧；
durationMs = 0 → 返回单帧 [0]；
**尾帧物理上抽不干净**：8s/25fps 的最后一帧在 7.96s，`-ss 7.999 -frames:v 1` 一个字节都不写
（ffmpeg 还会报 mjpeg "Non full-range YUV"）。实现必须「精确 seek 失败 → 往回退 500ms 重试一次」，
尾帧误差 ≤ 0.5 s 是可以接受的，**但不许丢帧**；
maxFrames 必须夹到 >= 1（传 0 或负数时 planFrames 直接 throw，**调用方负责在入口夹到 >= 1**，
不许把异常漏到 DSH）；
length <= maxFrames；同一 ms 不重复（容差 0.5s）。

## 8. lib/media/reframe.js

- export const REFRAME_LIMITS = { minWindowMs: 300, maxWindowMs: 30000, maxReframeWindows: 3,
    closeupLongEdge: 2730, quality: 85, maxBytes: 2097152 }
- export function validateWindow(req, { durationMs, limits = REFRAME_LIMITS, seen = new Set() })
  // -> { accepted: true } | { accepted: false, reason }
  // reason 只能是：'out-of-range' | 'too-short' | 'too-long' | 'kind-blur' | 'duplicate' | 'unknown-kind'
  // 窗口签名 = Math.floor(startMs/1000) + ':' + Math.floor(endMs/1000)；纯函数，不改 seen
- export async function extractWindow(video, { startMs, endMs }, { ffmpeg: bin, dir, stepMs = 500, longEdge, quality, maxBytes })
  // **单窗口帧数上限 12**（图片预算 maxImagesPerMessage = 20，一个窗口不能自己吃满）：
  // 步长自动放松 step = max(stepMs, ceil(窗口时长 / 12))。30 s 窗口 @0.5 s 不许真抽 60 张。
  // -> Array<{ ms, file, bytes }>  窗口内升序；一帧都抽不到 → 退回抽窗口中间那一帧；中间也失败才返回 []

## 9. lib/media/audio.js

- export async function extractWav(video, { ffmpeg: bin, outFile, timeoutMs = 900000 })   // -> 路径 | null（16kHz 单声道 pcm_s16le）
- export async function detectSpeech(video, { ffmpeg: bin, durationMs, noiseDb = -30, minSilenceMs = 500 })
  // -> Array<{ startMs, endMs }>；拿不到静音信息就返回 [{ startMs: 0, endMs: durationMs }]（不是空数组）
- export function planChunks(speechSpans, { maxChunkMs = 30000 })   // 纯函数，优先在静音处切，不许硬切词
- export async function transcribeChunk(wav, { whisperBin, model, lang, offsetMs, threads, timeoutMs = 1800000 })
  // -> Array<{ startMs, endMs, text }>   offsets 是**已加回 offsetMs** 的绝对时间
- export async function transcribe(video, { ffmpeg, whisperBin, whisperDir, modelName, lang = 'zh',
      concurrency = 2, threads, timeoutMs, signal, meta })
  // -> { segments, failures, detected }
  // 无音轨 / whisper 缺失 / 整体失败 → segments:[] + failures:[...]，**绝不 throw**
  // 另外接受这些注入接缝（不是业务参数）：
  //   runImpl       子进程接缝，默认 media/ffmpeg.js 的 run
  //   toSimplified  = true，出口统一做繁转简；false 则原样
  //   t2sDir        词表目录，默认 assets/opencc（只为 fail-open 用例注入）
  //   maxChunkMs    = 30000，分块上限

detected 形状（**钉死，E 组按这个消费**）：
  { hasAudio: boolean, lang: string | null, speechMs: number, chunkCount: number,
    t2s: { converted: number } }
  lang 取自 whisper JSON 的 result.language；t2s.converted 是"做过繁转简的段数"

failures 元素（**钉死**）：
  { stage: 'audio', reason: <kebab>, missing?: string, chunkIndex?: number, startMs?: number, detail?: string }
  reason 取值集合（只许这些）：
    no-audio-track | whisper-missing | whisper-model-missing | extract-failed |
    whisper-failed | whisper-json-invalid | timeout | aborted | bad-args |
    run-unavailable | run-failed

segments 必须按 startMs 升序、text 非空、endMs > startMs。

### 9.1 繁转简（必须有，理由是实测出来的）

实测：本机 whisper small 对真实视频人声输出的就是**繁体** ——
`花四個月時間給貓咪小鎮做的地鐵站和地鐵今天終於通車了`（用户视频 0–5.9 s）。
PROMPT.md 没提这条，但它是真实输出质量问题，不处理会一直输出繁体。

- 实现放 `lib/util/t2s.js`，词表拷进 `assets/opencc/{TSCharacters.txt,TSPhrases.txt}`
  （OpenCC 数据，Apache-2.0，保留 LICENSE 头；来源是
  `D:\DSH\dsh-home\profiles\desktop\node_modules\dsh-bili-whale\tools\lib\opencc\`）
- 接口照既有实现：`ensureLoaded()` / `toSimplified(text)` / `hasTraditional(text)`
- **短语表优先、单字表兜底**、长词优先匹配、代理对不能按 code unit 切
- 导出 `existingModel(tmp)` 之类之外**不加依赖**：纯查表，不 import 任何包
- **fail-open**：词表文件缺失 → 原样返回，不抛、不记 failure，只在 `detected.t2s.converted` 记 0
- `transcribe` 接受 `toSimplified = true`（默认开）；关掉时 text 原样
- 只要确实转换过，`detected.t2s.converted` 记段数

## 10. lib/llm/budget.js

- export const DETAILS = { quick/standard/deep，见 §2 }
- export function resolveDetail(detail)     // -> 'quick' | 'standard' | 'deep'（**返回档位名字符串**，不是对象）
  // 调用方要写 DETAILS[resolveDetail(x)]；未知识别 -> 'standard'
- export function planBatches(frameCount, batchSize)
  // -> Array<{ index, from, to }>，区间 [from, to)
  // 不变量：批次数 === Math.ceil(frameCount / batchSize)；每批长度 <= batchSize
- export function estimateImageTokens({ width, height, maxTokensPerImage = 1024 })
- export function estimateCostUsd({ pricing, model, imageCount, textTokensIn, textTokensOut, images })
  // model / images 是可选扩展：model 查 KNOWN_PRICING，images 用来调宿主的 priceImages()。
  // **逐字段回落**：config.pricing 只给输入价时，输出价仍取内置表 —— 半张价格表不许把成本算成一半。
- export const KNOWN_PRICING   // 内置费率表，键是 model id，值是 { inputPerMillion, outputPerMillion }
  // 来源：PROMPT.md §0 的实测价（2026-10）。费率会变，变了让用户用 config.pricing 覆盖。
  // 为什么要有它：宿主根本不暴露 $ 费率（imageRequestPricing 只给 visualTokens），
  // 没有兜底表的话 estimatedCostUsd 永远算成 0 —— 那不是"诚实"，那是丢掉一个输出字段。
  // 费率优先级：config.pricing > KNOWN_PRICING[model] > 无（则 0）
- export class Semaphore { constructor(n); run(fn); get active(); get peak() }

## 11. lib/llm/vision.js

**送图必须走附件层**：DSH 的 image block 是 { type: 'image', attachment: ImageAttachmentRef }，
原始 base64 不能直接塞进 messages（那只是上传前的 wire 形状）。
正确路径：ctx.attachments.admitPromptContent([{ type:'image', data:<base64>, mediaType:'image/jpeg' }])
→ 返回带 attachment 的块。

- export async function assertVisionModel(llm, provider, model)
  // 读 ctx.llm.resolveModelInfo(provider, model) 的 inputModalities；不含 'image' → throw（.code='MODEL_NOT_VISION'）
  // 绝不静默降级成"把图丢掉继续跑"
- export async function analyzeBatch(deps, batch)
  // batch: { index, frames: Array<{ ms, data, mediaType }>, windowStartMs, windowEndMs, durationMs }
  // -> { startMs, endMs, visual, onScreenText: string[], actions: string[],
  //      needsReframe: Array<{ startMs, endMs, reason, kind }>,
  //      imageTokens: number }   （needsReframe 缺失补 []；imageTokens 是这一批的图片输入 token）
  // imageTokens 只在 §11 这个**内部**接口里，不进 §15 的最终输出 schema，不冲突。
- export async function analyzeBatchWithRetry(deps, batch, { retries = 2 })   // 退避 500/1500ms
- export async function mergeAnalysis(deps, { question, scenes, transcript, reframes, meta })
  // -> { summary, answer }   **只带文字，不带图**

deps 形状（共用）：{ llm, attachments, provider, model, signal, timeoutMs, now, pricing? }
  pricing 可选：给了优先于 llm.imageRequestPricing()，不给则退回宿主自己的记账。

模型输出必须**严格 JSON**；解析要容忍围栏与前后废话（取第一个 "{" 到最后一个 "}"）。

## 12. lib/capabilities/registry.js

- export function createRegistry()
  // .register({ id, tool, run })   // tool = { name, description, parameters }（dsh-tools schema）
  // .list() / .get(id) / .capabilities()
- export function defineCapability(def)   // 校验 id / tool.name 唯一性，返回 Object.freeze

将来加"生成视频/剪辑/字幕"：只在这里 register 一项，不动 understand.js。

## 13. lib/capabilities/understand.js

- export const understandCapability = { id: 'video_understand', tool: {...}, run }

run(args, deps) 的 deps：{ llm, attachments, binaries, config, signal, log }

run 必须**永远返回 PROMPT.md §2.6 的结构化结果**：模型全挂也只是 scenes:[] + failures 非空，
绝不把异常抛给 DSH。

## 14. lib/index.js

- export const name = 'dsh-video'
- export const Config = z.object({...})   // §3 的 config 形状，全部 optional
- export const inject = ['llm', 'attachments']
- export function apply(ctx, config) { /* 只做装配：解析 config → 建 registry → 注册 ctx.tools */ }

业务逻辑一行都不许留在 index.js（这是可扩展性的关键，别再长成一个巨型 apply）。

## 14.1 `reframes[]` 元素的字段语义（**两个字段，不是一个**）

`{ round, startMs, endMs, reason, kind, frames, accepted, rejectReason? }`

- `reason` —— **永远是模型原文**。accepted=true 时是它要特写的原因；accepted=false 时原样保留（可能空串）。
  下游要统计「模型最常因为什么要特写」只能看这个字段。
- `rejectReason` —— **仅 accepted=false 时出现**的内部码，取值封闭：
  `duplicate | kind-blur | too-short | too-long | out-of-range | unknown-kind | window-limit | frame-budget | cost-budget | round-limit`
  accepted=true 时**连键都不写**（写 null 同样污染下游）。
- 被拒条目 `frames` 恒为 0。

为什么合成一个字段不行：PROMPT §2.6 的 `reason` 是给人看的原因，拒绝码是内部记账 ——
混在一起以后，统计模型意图时会混进 `duplicate`/`frame-budget` 这种噪声。

## 14.2 `inject` 是三个服务

`export const inject = ['tools', 'llm', 'attachments']` —— 一个数组。
`tools` 也是宿主服务：本机 `dsh-voice-call` / `dsh-win-bash` 都列了它，不声明就可能跑到工具注册表挂载之前。

## 15. 输出 schema（固定，别自创）

见 PROMPT.md §2.6。一律 camelCase，时间一律毫秒整数，缺数据给空数组/0，
**不要给 undefined、不要省略键**。scenes 合并后按 startMs 升序、区间不重叠不断裂。

## 16. 测试约定

- node --test tests/*.test.mjs
- 测试素材用 ffmpeg 现生成（scripts/make-fixture.mjs），不下载任何东西
- 需要真 ffmpeg / 真 whisper 的用例：文件顶部检测二进制存在性，缺了 t.skip()
- 需要真 API key 的端到端用例：检测 DSH_VIDEO_E2E=1，否则 t.skip()
- 单元测试一律**注入 fake**（fake llm / fake attachments / fake ffmpeg runner），
  不许为了测试去 mock 全局 child_process
- 断言必须断言**不变量**（见各节），不要断言具体文案

## 17. 文件所有权（并行开发不许越界）

| 组 | 拥有的文件 |
|---|---|
| A 媒体地基 | lib/util/paths.js, lib/util/perf.js, lib/media/ffmpeg.js, lib/media/probe.js, lib/media/frames.js, lib/media/reframe.js, scripts/make-fixture.mjs, tests/media.test.mjs |

**test-assets/ 是共用目录，不许用裸名**：测试素材一律带组前缀（A 已改成
`media-basic8s` / `media-silent8s` / `media-scenes9s` / `media-long45s`；B 用 `audio-*`；
E 用 `e2e-*`）。B 组曾与 A 组都用 `noaudio.mp4`，互覆盖过一次，A 的 probe 断言当场变红。
新写的测试一律放 `test-assets/<组前缀>-` 命名。
| B 音频 | lib/media/audio.js, lib/util/t2s.js, assets/opencc/*, tests/audio.test.mjs |
| C 模型层 | lib/llm/budget.js, lib/llm/vision.js, tests/llm.test.mjs |
| D 打包 | package.json, cordis.patch.yml, README.md, docs/ARCH.md, .gitignore |
| E 集成（第二波） | lib/capabilities/registry.js, lib/capabilities/understand.js, lib/capabilities/index.js, lib/index.js, tests/understand.test.mjs, tests/e2e.test.mjs |

## 18. 一个关键的隔离约束（决定 lib/ 能不能用普通 node 跑测试）

### 18.1 为什么一个都不许 import（2026-10-31 装上之后被日志打脸改的）

先把结论钉死，免得后来人重走一遍：

```
dsh-video (dsh-video): failed to import: Error [ERR_MODULE_NOT_FOUND]:
Cannot find package '@deepseek-ai/schemastery'
imported from D:\DSH\deepseek harness\wokrspace\dsh-video\lib\index.js
```

**我从源码读出来的判断是错的，日志是对的。** 当时的推理是：`dsh-app-boot` 的
`findInterceptionLayer` 会给 `linkedPaths`（junction 的 realPath）建 `{kind:'linked'}` 插桩层，
所以 junction 到 workspace 也应该能 import 宿主包 —— **而实测没覆盖**。

本机两个 junction 插件（`dsh-lanpangzi` / `dsh-bili-whale`）能工作，是因为它们
**一个 `@deepseek-ai/*` 都不 import**（实测过它们的 import 列表：全是 node 内置 + 相对路径）。
`dsh-voice-call` 能 import 是因为它在 `profiles/desktop/node_modules/` 里是**真实目录**。

替代方案与等价性：

| 组件 | 替代 | 为什么等价 |
|---|---|---|
| `schemastery`（Config） | 顶层 `await import(...)` + try/catch，拿不到就 `Config = undefined` | cordis 允许无 Config；config 照旧传进 `apply()`，校验交给 `normalizeConfig` |
| `defineTool` | 自己把**属性级 required** 转成**对象级 required 数组** | `ctx.tools.register` 只要求 `{ name, output:{schema,render} }`（见 dsh-tools 的 register 实现） |
| `BlockAssembler` | 不传；vision.js 的本地累加器 | 只吃 text-delta / block-end 两种 chunk |

**验证方式（可复现）**：在 DSH 运行时里 `import` 插件的 `lib/index.js` → `apply()` →
拿到注册出来的工具定义 → 用宿主自己的 `assertSupportedJsonSchema` 校验 `parameters` 与
`output.schema`，两者都通过（2026-10-31 实测通过）。

### 18.0 先纠一个原件的错（PROMPT.md §0 第 6 条）

PROMPT.md 写「给 `ctx.llm.stream()` 传图的内容块形状是 `{ type:'image', data:<base64>, mimeType:'image/png' }`」——
**这句是错的**：真实类型里没有 `mimeType` 字段，且 `ImageBlock` 只能带 `attachment`。
`{ type:'image', data, mediaType }` 只是**上传前**的 wire 形状（`admitPromptContent` 的入参）。
PROMPT.md 是需求原件，**不改它**；以本条与 §11 为准。

`@deepseek-ai/*` 这些包**只在 DSH 宿主进程里可解析**，workpace 里的普通 node 解析不到
（实测 `require.resolve('@deepseek-ai/dsh-llm')` → MODULE_NOT_FOUND）。
所以：

- **全插件一个 `@deepseek-ai/*` 静态 import 都不许有**（2026-10-31 装上之后被日志打脸改的，见 §18.1）
- lib/llm/vision.js **不许静态 import @deepseek-ai/dsh-llm**。它从 deps 拿可选注入的
  `deps.BlockAssembler`；没有时退回本地的小累加器（只吃 text-delta / block-end 两种 chunk）。
  （现在也**不传**了 —— 本地累加器就是唯一实现）
- 其它 lib/ 文件只用 **node 内置模块 + 仓库内相对导入**。`./budget.js` 这种完全可以；
  §18 禁的是**外部包**（@deepseek-ai/* 与任何 npm 包），不是禁跨文件
- tests/*.test.mjs 里**仍然不许 import lib/index.js**（它是装配层，不是被测对象）

说人话：代码要对"真宿主"和"裸 node 测试"同时成立，靠的是依赖注入，不是全局 mock。

## 19. 已钉死的宿主 API 事实（从 app.asar 真实源码读出来的，别再猜）

源码位置（裸 node 的 fs 能读 asar）：
`D:/DSH/deepseek harness/DSH NEXT/resources/app.asar/node_modules/@deepseek-ai/...`

### 19.1 `defineTool`（`@deepseek-ai/dsh-tools`）

~~~js
ctx.tools.register(defineTool({
  name, description,
  parameters,                          // dsh 自己的 schema spec，见下
  output: {
    schema,                            // **必填**：defineTool 无条件读 options.output.*
    render(args, value) { return [{ type: 'text', text: '...' }] },
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) { ... },   // exec.signal / exec.agent 可用
  presentCall(args) { return { card: 'generic', title, kind: 'search' } },
}))
~~~

**schema spec 不是标准 JSON Schema**：必填是**属性级**的 `required: true`，
不是对象级的 `required: [...]`。照 `dsh-voice-call/lib/tools/transcribe.js` 的写法抄。
`oneOf` / `additionalProperties: false` 都支持。

### 19.2 插件入口

两种都合法（本机都有先例）：
- `export default { name, inject: [...], apply(ctx) {} }`（dsh-bili-whale）
- `export const Config = z.object({...})` + `export function apply(ctx, rawConfig) {}`（dsh-voice-call）

z 来自 `import z from '@deepseek-ai/schemastery'`（**只能在 lib/index.js 里 import**，契约 §18）。
本项目用第二种。`inject` 写成**一个数组**，不要写成两个键 —— 对象字面量后者会覆盖前者，
表现是"注入了但不干活、也不报错"（dsh-bili-whale 踩过）。

### 19.3 测试运行器（本机沙箱的硬事实）

- `node --test <file>`（默认隔离）在 DSH 沙箱里 **EPERM**：默认隔离要 spawn 子进程用管道收输出，
  沙箱禁命名管道 → `spawn EPERM (errno -4048)`
- `node --test --test-isolation=none <file>` ✅
- `node <file>` ✅（进程内跑）

所以：`scripts.test` 保留 `node --test tests/*.test.mjs`（给真实终端），
另设 `scripts['test:local']` = `node --test --test-isolation=none tests/*.test.mjs`（沙箱内用）。
两处入口都要在 README 说明。

### 19.4 图片会被压缩两次（决定 reframe 长边取多少）

从部署实现读出来的两条硬链：

1. **附件层归一化**（`dsh-attachment-local`）：`normalizedImageMaxPixels = 4,194,304`、
   `normalizedImageMaxBytes = 4 MiB`、`normalizedImageMaxDimension = 8192`。
   超过就在 `saveImages` 里降采样，并把原尺寸记在 `ref.originalDimensions`。
   → 16:9 图的上限约 **2730 × 1536**。
2. **提供方适配器**：DeepSeek 不设 `imagePixelBudget` 时按官方视觉 token 网格走
   14px patch、3:1 降采样、单图 ≤ 1024 token → 16:9 实际按 **1708 × 961** 发送。

推论（重要，别写错）：
- reframe 抽 4096 长边**没有任何收益**：先进附件层被压到 2730，再被适配器压到 1708，
  和首轮送出去的尺寸完全一样，只是多花 CPU 与磁盘 IO。所以默认取 **2730**。
- 对 1280×720 这类低分辨率源，`scale` 不会放大，首轮就已经是原生分辨率 ——
  **reframe 的真收益是时间密度（窗口内 0.5 s 一帧），不是空间分辨率**。
- 想真正提升局部细节要 **crop**（把窗口内的子区域裁出来再缩放），PROMPT.md 没要求，
  v0.1 **不做**，但要在 README/ARCH 的「已知限制 / 没做的事」里写明，
  不许对外宣称"重采样能看到更清楚的字"。
- `imageLimits.maxImagesPerMessage = 20`（不是无限）：一次请求超 20 张会抛
  `TOO_MANY_IMAGES`。契约 §2 的 batchSize（6/8/10）都在限内，别自己放大。
- 估成本要用 `ref.width/ref.height`（归一化后的真实尺寸），不是我们抽帧时的尺寸。



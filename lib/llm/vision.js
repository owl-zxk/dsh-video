// 为什么这里每一处都这么绕：
// 1) 图片块不能带 base64。DSH 的 image block 是 { type:'image', attachment: ImageAttachmentRef }，
//    { type:'image', data, mediaType } 只是**上传前**的 wire 形状；直接塞进 messages 会被
//    丢弃或报错。所以送图前一律先过 deps.attachments.admitPromptContent(...) 换成带 attachment 的块。
// 2) 宿主会把「纯文本模型收到的图」静默换成一句占位符（dsh-llm 的 projectImagesForTextModel），
//    模型看不见却不报错。所以送图前必须 assertVisionModel 校验 inputModalities 含 image，
//    不含就 throw —— 绝不静默降级成「把图丢掉继续跑」。
// 3) 宿主 llm.stream() **不会**因为适配器失败而 throw：它把失败合成一个 finish chunk
//    （reason.kind === 'error' | 'aborted'）。只看 for-await 有没有抛错，重试永远不会触发，
//    所以下面的循环必须显式读 finish。
// 4) 契约 §18：这里不许 import '@deepseek-ai/*'。BlockAssembler 靠 deps 注入；
//    没注入就用本地只吃 text-delta / block-end 的小累加器，裸 node 测试照样跑。
// 5) 图片 token 只能在这里算：归一化后的真实尺寸（ref.width/height）只有 admitPromptContent
//    的返回值上有，抽帧尺寸会被附件层压一次、适配器再压一次（契约 §19.4）。

import { estimateImageTokens } from './budget.js'

const MODEL_NOT_VISION = 'MODEL_NOT_VISION'
const ATTACHMENTS_UNAVAILABLE = 'ATTACHMENTS_UNAVAILABLE'
const LLM_UNAVAILABLE = 'LLM_UNAVAILABLE'
const INVALID_BATCH = 'INVALID_BATCH'
const INVALID_MODEL_OUTPUT = 'INVALID_MODEL_OUTPUT'
const EMPTY_MODEL_OUTPUT = 'EMPTY_MODEL_OUTPUT'
const MODEL_STREAM_FAILED = 'MODEL_STREAM_FAILED'
const MODEL_STREAM_ABORTED = 'MODEL_STREAM_ABORTED'

/** 这些是配置/入参错误，重试只会白烧钱和时间，直接抛。 */
const NON_RETRYABLE = new Set([MODEL_NOT_VISION, ATTACHMENTS_UNAVAILABLE, LLM_UNAVAILABLE, INVALID_BATCH])

/** 退避：契约要求 500 / 1500 各一次，共 3 次尝试。 */
const RETRY_DELAYS_MS = [500, 1500]

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

const defaultSleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })

/** 毫秒 -> `mm:ss.s`：帧标签要让人和模型都能对上视频进度。 */
function timecode (ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  const minutes = Math.floor(total / 60000)
  const seconds = (total % 60000) / 1000
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`
}

function toMs (value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : null
}

function stringArray (value) {
  if (Array.isArray(value)) {
    return value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(item => item.length > 0)
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  return []
}

/**
 * 本地累加器：只吃 text-delta 和 block-end 两种 chunk（契约 §11）。
 * 真宿主里由 lib/index.js 注入真的 BlockAssembler，这个只在裸 node 测试和
 * 「没注入」时兜底 —— 所以刻薄一点，不认识的一律忽略，不许抛。
 */
class LocalAssembler {
  #deltas = []
  #blocks = []

  push (chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') this.#deltas.push(chunk.text)
      return
    }
    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') this.#blocks.push(block)
    }
  }

  text () {
    if (this.#blocks.length > 0) return this.#blocks.map(block => block.text).join('')
    return this.#deltas.join('')
  }

  blocks () {
    if (this.#blocks.length > 0) return [...this.#blocks]
    return [{ type: 'text', text: this.#deltas.join('') }]
  }
}

function createAssembler (deps) {
  const injected = deps.BlockAssembler
  if (typeof injected === 'function') return new injected()
  // 也允许直接注入一个已经建好的实例（宿主那侧拿到的是类，这里留条活路）。
  if (injected !== null && typeof injected === 'object' && typeof injected.push === 'function') return injected
  return new LocalAssembler()
}

function assembledText (assembler) {
  if (typeof assembler.text === 'function') return assembler.text()
  const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : []
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
}

/** 单次调用的中止信号：timeoutMs 到点就 abort，宿主会把流收成 aborted finish。 */
function callSignal (deps) {
  const timeoutMs = Number(deps.timeoutMs)
  const upstream = deps.signal
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal: upstream, dispose () {} }
  const controller = new AbortController()
  const forward = () => controller.abort(upstream?.reason)
  if (upstream !== undefined && upstream !== null) {
    if (upstream.aborted) controller.abort(upstream.reason)
    else if (typeof upstream.addEventListener === 'function') upstream.addEventListener('abort', forward, { once: true })
  }
  const timer = setTimeout(() => controller.abort(codedError('MODEL_TIMEOUT', `vision: 单次模型调用超过 ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose () {
      clearTimeout(timer)
      if (typeof upstream?.removeEventListener === 'function') upstream.removeEventListener('abort', forward)
    }
  }
}

/** 把一次 llm.stream 跑成一段文本；适配器失败、空输出、abort 都在这里显式抛。 */
async function collectText (deps, { system, messages }) {
  const llm = deps.llm
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw codedError(LLM_UNAVAILABLE, 'vision: deps.llm 不可用（没有 stream()）')
  }
  const { signal, dispose } = callSignal(deps)
  const assembler = createAssembler(deps)
  const options = {
    provider: deps.provider,
    model: deps.model,
    messages,
    ...system === undefined ? {} : { system },
    ...signal === undefined ? {} : { signal }
  }
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk)
      if (chunk?.type !== 'finish') continue
      const kind = chunk.reason?.kind
      if (kind !== 'error' && kind !== 'aborted') continue
      const failure = chunk.reason?.failure ?? {}
      const detail = `${failure.code ?? 'UNKNOWN'}: ${failure.message ?? '模型流异常结束'}`
      throw codedError(kind === 'aborted' ? MODEL_STREAM_ABORTED : MODEL_STREAM_FAILED, `vision: 模型流以 ${kind} 结束（${detail}）`)
    }
  } finally {
    dispose()
  }
  const text = assembledText(assembler).trim()
  if (text.length === 0) throw codedError(EMPTY_MODEL_OUTPUT, 'vision: 模型没有返回任何文本')
  return text
}

/**
 * 取第一个 `{` 到最后一个 `}` 再 JSON.parse；失败再试「去掉围栏」的版本。
 * 为什么要容错：模型即使被要求「只输出 JSON」，也常带 ```json 围栏或前后一句废话。
 * 为什么最后仍要 throw：半截对象比报错更坏 —— 上层会把空数组当成「模型没发现东西」。
 */
function parseModelJson (text) {
  const attempts = [text, text.replace(/```[a-zA-Z]*/g, '')]
  for (const candidate of attempts) {
    const from = candidate.indexOf('{')
    const to = candidate.lastIndexOf('}')
    if (from === -1 || to <= from) continue
    try {
      const parsed = JSON.parse(candidate.slice(from, to + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 换下一个候选版本
    }
  }
  const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text
  throw codedError(INVALID_MODEL_OUTPUT, `vision: 模型输出里找不到合法 JSON 对象：${preview}`)
}

/**
 * 送图前必须过的闸门。
 * inputModalities 里没有 'image' 就 throw —— 因为宿主的做法是把图片换成占位符，
 * 模型「看不见」却不会报错，这种静默降级在结果里根本查不出来。
 */
export async function assertVisionModel (llm, provider, model) {
  if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') {
    throw codedError(LLM_UNAVAILABLE, 'vision: deps.llm 不可用（没有 resolveModelInfo()）')
  }
  const info = await llm.resolveModelInfo(provider, model)
  const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : []
  if (!modalities.includes('image')) {
    throw codedError(
      MODEL_NOT_VISION,
      `vision: 模型 ${provider}/${model} 的 inputModalities 是 [${modalities.join(', ')}]，不接受图片；请换一个支持图片的模型（不要静默降级）`
    )
  }
  return info
}

const BATCH_SYSTEM_PROMPT = [
  '你是视频画面分析器。只描述这批截图里真的看到的画面，不要编造画面外的事，不要推测剧情。',
  '每张图前面紧挨着一行「帧 N · 时间」，时间是该帧在视频里的绝对位置。',
  '输出必须是一个 JSON 对象：不要 Markdown 围栏，不要任何解释文字。字段：',
  '- startMs / endMs：这批覆盖的时间区间（毫秒整数）',
  '- visual：一两句话描述这批画面里发生了什么（要求引用帧号或时间戳）',
  '- onScreenText：画面里看得清的文字数组；看不清就不要猜，给 []',
  '- actions：画面里发生的动作数组；没有明显动作给 []',
  '- needsReframe：需要更清晰的特写才能看清的时间窗数组，每项 { startMs, endMs, reason, kind }；不需要就给 []',
  'kind 只能是：detail（有细节看不清，如远处小字、纹理）、text（要读字幕/标题/UI 文字）、motion（要看清动作过程，静态帧看不出动没动）、',
  'blur（内容本身就是糊的：失焦、压缩糊）。blur 表示重抽也没用，这种情况不要请求重抽。'
].join('\n')

const MERGE_SYSTEM_PROMPT = [
  '你是视频内容总结器。下面给你按时间排好的画面分析、补充特写描述、语音转录和一个问题。',
  '只根据给出的材料作答，不要编造没有出现的内容；材料不足就直说不足。',
  '输出必须是一个 JSON 对象：不要 Markdown 围栏，不要任何解释文字。字段：',
  '- summary：对整个视频内容的 3-6 句总结（按时间顺序）',
  '- answer：针对用户问题的直接回答；问题为空时给空字符串'
].join('\n')

function describeBatch (batch, frameCount) {
  const windowStartMs = toMs(batch.windowStartMs) ?? 0
  const windowEndMs = toMs(batch.windowEndMs) ?? 0
  const durationMs = toMs(batch.durationMs) ?? 0
  return [
    `这批共 ${frameCount} 张截图，覆盖 ${timecode(windowStartMs)} - ${timecode(windowEndMs)}，视频总时长 ${timecode(durationMs)}。`,
    '只描述这些截图里看得到的内容；看不清就写看不清，不要编造。'
  ].join('\n')
}

/**
 * 分析一批帧。调用方负责把帧切成批（planBatches）、限流（Semaphore）、
 * 并发调度；这里只管「一批帧 -> 一条结构化结果」。
 * @param deps { llm, attachments, provider, model, signal, timeoutMs, BlockAssembler? }
 * @param batch { index, frames: [{ ms, data, mediaType }], windowStartMs, windowEndMs, durationMs }
 */
export async function analyzeBatch (deps, batch) {
  const frames = Array.isArray(batch?.frames) ? batch.frames : []
  if (frames.length === 0) throw codedError(INVALID_BATCH, 'vision: analyzeBatch 收到空批次')
  const attachments = deps.attachments
  if (attachments === undefined || attachments === null || typeof attachments.admitPromptContent !== 'function') {
    throw codedError(ATTACHMENTS_UNAVAILABLE, 'vision: deps.attachments 不可用（没有 admitPromptContent()）；图片不能以 base64 直接送模型')
  }
  // 先校验再动手：不通过就一个 token 都不花。
  await assertVisionModel(deps.llm, deps.provider, deps.model)

  const content = [{ type: 'text', text: describeBatch(batch, frames.length) }]
  frames.forEach((frame, position) => {
    if (typeof frame?.data !== 'string' || frame.data.length === 0) {
      throw codedError(INVALID_BATCH, `vision: 第 ${position} 帧缺少 data（base64）；抽帧结果要先读成 base64 再传进来`)
    }
    content.push({ type: 'text', text: `帧 ${position + 1} · ${timecode(frame.ms)}` })
    content.push({ type: 'image', data: frame.data, mediaType: typeof frame.mediaType === 'string' ? frame.mediaType : 'image/jpeg' })
  })

  // 这一行是「图能送出去」的唯一合法通道：base64 -> 带 attachment 的块。
  const admitted = await attachments.admitPromptContent(content)
  const imageTokens = measureImageTokens(deps, admitted)
  const text = await collectText(deps, { system: BATCH_SYSTEM_PROMPT, messages: [{ role: 'user', content: admitted }] })
  // imageTokens 是 §11 内部接口字段（不进 §15 的最终输出 schema），给上一层的成本估算用。
  return { ...normalizeBatchResult(parseModelJson(text), batch, frames), imageTokens }
}

/**
 * 这一批图片占多少输入 token。
 * 首选宿主自己的记账：deps.pricing / llm.imageRequestPricing() 给的 { priceImages(blocks) } →
 * 每张图的 visualTokens，它才懂 offloaded 与请求图尺寸。
 * 拿不到就用**归一化后的** ref.width/height 过 estimateImageTokens（与提供方同解的网格）。
 * 两者都没有的图按 0 计 —— 不猜。记账失败也不许让整批失败。
 */
function measureImageTokens (deps, blocks) {
  const images = blocks.filter(block => block?.type === 'image')
  if (images.length === 0) return 0
  let pricing = deps.pricing
  if (pricing === undefined && typeof deps.llm?.imageRequestPricing === 'function') {
    pricing = deps.llm.imageRequestPricing(deps.provider, deps.model)
  }
  if (pricing !== null && typeof pricing === 'object' && typeof pricing.priceImages === 'function') {
    try {
      const prices = pricing.priceImages(images)
      if (Array.isArray(prices) && prices.length === images.length) {
        return prices.reduce((sum, price) => sum + (Number.isFinite(price?.visualTokens) ? price.visualTokens : 0), 0)
      }
    } catch {
      // 宿主的记账坏了不该拖垮这一批：退回按 ref 尺寸自己算。
    }
  }
  let total = 0
  for (const block of images) {
    const width = Number(block.attachment?.width)
    const height = Number(block.attachment?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    total += estimateImageTokens({ width, height })
  }
  return total
}

function normalizeBatchResult (parsed, batch, frames) {
  const windowStartMs = toMs(batch.windowStartMs) ?? toMs(frames[0]?.ms) ?? 0
  const windowEndMs = toMs(batch.windowEndMs) ?? toMs(frames[frames.length - 1]?.ms) ?? windowStartMs
  let startMs = toMs(parsed.startMs) ?? windowStartMs
  let endMs = toMs(parsed.endMs) ?? windowEndMs
  if (endMs < startMs) {
    const swapped = startMs
    startMs = endMs
    endMs = swapped
  }
  return {
    startMs,
    endMs,
    visual: typeof parsed.visual === 'string' ? parsed.visual.trim() : '',
    onScreenText: stringArray(parsed.onScreenText),
    actions: stringArray(parsed.actions),
    // 契约：缺失也要给 []，绝不给 undefined。
    needsReframe: normalizeReframes(parsed.needsReframe)
  }
}

function normalizeReframes (value) {
  if (!Array.isArray(value)) return []
  const windows = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const startMs = toMs(item.startMs)
    const endMs = toMs(item.endMs)
    // 合法性（越界/过短/blur/去重）是 reframe.validateWindow 的活，这里只保证形状可用。
    if (startMs === null || endMs === null || endMs <= startMs) continue
    windows.push({
      startMs,
      endMs,
      reason: typeof item.reason === 'string' ? item.reason : '',
      kind: typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : 'detail'
    })
  }
  return windows
}

/**
 * 带退避的重试包装：默认 1 + 2 次尝试，退避 500 / 1500ms。
 * 三次都失败就 throw 给调用方记 failures —— 不要返回半截结果。
 */
export async function analyzeBatchWithRetry (deps, batch, { retries = 2 } = {}) {
  const planned = Number.isFinite(retries) ? Math.floor(retries) : 0
  const attempts = Math.max(1, planned + 1)
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : defaultSleep
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await analyzeBatch(deps, batch)
    } catch (error) {
      lastError = error
      if (deps.signal?.aborted === true) break
      if (NON_RETRYABLE.has(error?.code)) break
      if (attempt >= attempts) break
      await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)])
    }
  }
  throw lastError ?? codedError(MODEL_STREAM_FAILED, 'vision: analyzeBatchWithRetry 没有拿到结果')
}

/** 把 scenes / 转录 / 特写结果摊成纯文本：汇总这一步绝不能带图，否则二次触发图片预算。 */
function renderMergeInput ({ question, scenes, transcript, reframes, meta }) {
  const lines = []
  const durationMs = toMs(meta?.durationMs) ?? 0
  lines.push(`视频总时长 ${timecode(durationMs)}；画面分析 ${scenes.length} 段，语音转录 ${transcript.length} 段，特写补充 ${reframes.length} 条。`)
  if (scenes.length > 0) {
    lines.push('', '【按时间排列的画面分析】')
    for (const scene of scenes) {
      const range = `${timecode(scene?.startMs)} - ${timecode(scene?.endMs)}`
      const visual = typeof scene?.visual === 'string' ? scene.visual : ''
      lines.push(`- ${range} ${visual}`.trimEnd())
      const onScreen = stringArray(scene?.onScreenText)
      if (onScreen.length > 0) lines.push(`  画面文字：${onScreen.join(' / ')}`)
      const actions = stringArray(scene?.actions)
      if (actions.length > 0) lines.push(`  动作：${actions.join(' / ')}`)
      const firstPass = typeof scene?.firstPass === 'string' && scene.firstPass.length > 0 ? scene.firstPass : ''
      if (firstPass.length > 0) lines.push(`  首轮描述（较粗，作参考）：${firstPass}`)
    }
  }
  if (reframes.length > 0) {
    lines.push('', '【特写补充（分辨率更高，优先于首轮描述）】')
    for (const item of reframes) {
      const range = `${timecode(item?.startMs)} - ${timecode(item?.endMs)}`
      const visual = typeof item?.visual === 'string' ? item.visual : ''
      lines.push(`- ${range} ${visual}`.trimEnd())
    }
  }
  if (transcript.length > 0) {
    lines.push('', '【语音转录】')
    for (const segment of transcript) {
      const text = typeof segment?.text === 'string' ? segment.text.trim() : ''
      if (text.length === 0) continue
      lines.push(`- ${timecode(segment?.startMs)} ${text}`)
    }
  }
  const asked = typeof question === 'string' && question.trim().length > 0 ? question.trim() : ''
  lines.push('', asked.length > 0 ? `【用户问题】${asked}` : '【用户问题】（没有提出具体问题，只做整体总结）')
  return lines.join('\n')
}

/**
 * 全局汇总：只带文字，不带图。
 * 不调 assertVisionModel —— 这一步本来就不需要模型能吃图。
 * @returns { summary, answer }（拿不到的字段给空字符串，绝不给 undefined）
 */
export async function mergeAnalysis (deps, { question, scenes = [], transcript = [], reframes = [], meta = {} } = {}) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: renderMergeInput({ question, scenes, transcript, reframes, meta }) }]
  }]
  const text = await collectText(deps, { system: MERGE_SYSTEM_PROMPT, messages })
  const parsed = parseModelJson(text)
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    answer: typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
  }
}

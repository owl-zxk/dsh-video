// 为什么这个文件是纯函数、零依赖：
// 分批大小、并发度、图片 token、成本这四件事必须只有一处定义。散到调用方
// 就会出现「按 8 张切批、按 6 张算预算」这种错位，而它只在真机上以 429 或
// IMAGE_OFFLOAD_REQUIRED 的形式炸出来，测试里看不见。
// 另外这里绝不 import '@deepseek-ai/*'（契约 §18）：裸 node 要能直接测。

/** 三档详情：契约 §2 的唯一事实来源，调用方不许再抄一份。 */
export const DETAILS = Object.freeze({
  quick: Object.freeze({ maxFrames: 6, batchSize: 6, maxRounds: 0, maxExtraFrames: 0, maxCostUsd: 0.02 }),
  standard: Object.freeze({ maxFrames: 16, batchSize: 8, maxRounds: 1, maxExtraFrames: 12, maxCostUsd: 0.1 }),
  deep: Object.freeze({ maxFrames: 40, batchSize: 10, maxRounds: 2, maxExtraFrames: 24, maxCostUsd: 0.4 })
})

/** 未知识别时退回的档位名。 */
export const DEFAULT_DETAIL = 'standard'

/**
 * 内置费率表（美元 / 每百万 token）。
 * 来源：PROMPT.md §0 的实测价表（2026-10 官方价），数值原样抄，没算汇率。
 * 为什么要这张表：宿主**根本不暴露 $ 费率** —— ctx.llm.imageRequestPricing() 只返回
 * { priceImages(blocks) -> [{ visualTokens, text }] }，整个 @deepseek-ai 里搜不到任何
 * per-million 价格字段。没有兜底表，§2.6 要的 estimatedCostUsd 永远是 0，那是丢字段而不是诚实。
 * 费率会变：用户用 config.pricing 覆盖（优先级更高），这张表只是缺省值。
 */
export const KNOWN_PRICING = Object.freeze({
  // 本机真实路由（provider 叫 deepseek-account，见 util/paths.js 的 DEFAULT_MODELS 注释）
  'deepseek-account/deepseek-flash': Object.freeze({ inputPerMillion: 0.3, outputPerMillion: 1.2 }),
  'deepseek-account/deepseek-v4-pro': Object.freeze({ inputPerMillion: 0.3, outputPerMillion: 1.2 }),
  // PROMPT.md §0 记的那几个（换了账号/部署时可能用得上）
  'deepseek/deepseek-v4.1-flash': Object.freeze({ inputPerMillion: 0.3, outputPerMillion: 1.2 }),
  'deepseek/deepseek-v4-flash-vision-exp': Object.freeze({ inputPerMillion: 0.2156, outputPerMillion: 0.6468 }),
  'deepseek/deepseek-v4.1-flash:batch': Object.freeze({ inputPerMillion: 0.112, outputPerMillion: 0.336 }),
  'minimax/minimax-m3': Object.freeze({ inputPerMillion: 0.3, outputPerMillion: 1.2 })
})

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 把任意输入识别成一个已知档位名。
 * 返回的是**档位名**（'quick' | 'standard' | 'deep'），不是详情对象：
 * 调用方用 DETAILS[resolveDetail(x)] 取数值，这样上限只有一份。
 */
export function resolveDetail (detail) {
  return typeof detail === 'string' && Object.hasOwn(DETAILS, detail) ? detail : DEFAULT_DETAIL
}

/**
 * 单次请求能带多少张图的上限 = 宿主 ctx.attachments.imageLimits.maxImagesPerMessage（部署实测 20）。
 * 超过就抛 TOO_MANY_IMAGES，所以这个数是硬闸门，不是建议值（契约 §2 的 6/8/10 都在限内，别放大）。
 */
export const MAX_IMAGES_PER_MESSAGE = 20

const defaultWarn = message => { console.warn(message) }

/**
 * 把帧数切成互不相接、无缝的区间 [from, to)。
 * 不变量：批次数 === ceil(frameCount / batchSize)；每批 to - from <= batchSize，且 <= 20。
 * 为什么右开区间：帧下标从 0 开始，to 直接就是下一批的 from，拼接时不用 +1。
 * 为什么 batchSize 要夹：调用方传 32 就会撞 TOO_MANY_IMAGES，整轮白跑；
 * 夹到 20 并留一条 warn，比静默发出去或者直接抛错都有用（warn 可注入，测试能断言）。
 */
export function planBatches (frameCount, batchSize, { warn = defaultWarn } = {}) {
  const total = Number.isFinite(frameCount) ? Math.floor(frameCount) : 0
  let size = Number.isFinite(batchSize) ? Math.floor(batchSize) : 0
  if (size <= 0) throw codedError('INVALID_BATCH_SIZE', `planBatches: batchSize 必须是正整数，收到 ${String(batchSize)}`)
  if (size > MAX_IMAGES_PER_MESSAGE) {
    warn(`planBatches: batchSize ${size} 超过单请求图片上限 ${MAX_IMAGES_PER_MESSAGE}，已夹到 ${MAX_IMAGES_PER_MESSAGE}（否则会抛 TOO_MANY_IMAGES）`)
    size = MAX_IMAGES_PER_MESSAGE
  }
  const batches = []
  if (total <= 0) return batches
  for (let from = 0, index = 0; from < total; from += size, index += 1) {
    batches.push({ index, from, to: Math.min(from + size, total) })
  }
  return batches
}

// —— 图片 token 网格 ——
// 这组常数是 DeepSeek 视觉计费的官方网格（14px patch、3:1 降采样、单图上限 1024 token）。
// 照抄而不是自创公式：成本估算要和提供方算出来的数字对得上，否则 estimateCostUsd 只是好看。
const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO
const MIN_PIXELS = 544 * 544
const DEFAULT_MAX_IMAGE_TOKENS = 1024

const intDiv = (value, divisor) => Math.trunc(value / divisor)
const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor)
/** 一个网格的 token 数：每行带一个分隔符，再加两个边框 token。 */
const gridTokens = (gridHeight, gridWidth) => gridHeight * (gridWidth + 1) + 2
/** 一条像素轴（已按 patch 对齐）折算成的 token 格数。 */
const gridCells = paddedLength => ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO)

/** 在 token 预算内求保比的最大网格。 */
function solveResizeRatio (height, width, budget) {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight
  let bestWidth
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    const solvedGridHeight = intDiv(budget - 2, 2)
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1
    bestWidth = (intDiv(budget - 2, solvedGridHeight) - 1) * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    const solvedGridHeight = Math.trunc(idealGridHeight)
    const scale = Math.min((solvedGridWidth * CELL_SIZE) / width, (solvedGridHeight * CELL_SIZE) / height)
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE
  }
  return {
    gridHeight: gridCells(bestHeight),
    gridWidth: gridCells(bestWidth),
    bestHeight,
    bestWidth,
    numTokens: gridTokens(gridCells(bestHeight), gridCells(bestWidth))
  }
}

/** 把补齐后的像素尺寸投影到预算内最大的 token 网格。 */
function safeResize (height, width, paddedHeight, paddedWidth, budget) {
  const direct = {
    gridHeight: gridCells(paddedHeight),
    gridWidth: gridCells(paddedWidth),
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridCells(paddedHeight), gridCells(paddedWidth))
  }
  if (direct.numTokens <= budget) return direct
  const solved = solveResizeRatio(height, width, budget)
  if (solved.numTokens > budget) {
    throw codedError('IMAGE_TOKEN_SOLVER_FAILED', `estimateImageTokens: ${width}x${height} 在 ${budget} token 预算内无解`)
  }
  return solved
}

/** 一次 scale-pad-project；调用方迭代到不动点。 */
function resizeOnce (width, height, budget) {
  let scaledWidth = width
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = Math.trunc(scaledWidth * scale)
    scaledHeight = Math.trunc(scaledHeight * scale)
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth, budget)
}

function sameResize (a, b) {
  return a.gridHeight === b.gridHeight && a.gridWidth === b.gridWidth && a.bestHeight === b.bestHeight && a.bestWidth === b.bestWidth && a.numTokens === b.numTokens
}

/**
 * 估算一张图在路由上占多少输入 token。
 * 尺寸必须是**附件层归一化后**的 ref.width / ref.height（契约 §19.4：图会被压两次，
 * 8192/4MiP 归一化一次、适配器再压到 1708x961），不是抽帧时的原始尺寸，也不是 originalDimensions；
 * 尺寸未知时不要瞎猜 —— 直接 throw，让调用方先拿到宽高。
 */
export function estimateImageTokens ({ width, height, maxTokensPerImage = DEFAULT_MAX_IMAGE_TOKENS } = {}) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw codedError('INVALID_IMAGE_SIZE', `estimateImageTokens: 宽高必须是正数，收到 ${String(width)}x${String(height)}`)
  }
  const budget = Number.isFinite(maxTokensPerImage) && maxTokensPerImage >= 3 ? Math.floor(maxTokensPerImage) : DEFAULT_MAX_IMAGE_TOKENS
  let result = resizeOnce(w, h, budget)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight, budget)
    if (sameResize(next, result)) return result.numTokens
    result = next
  }
  throw codedError('IMAGE_TOKEN_SOLVER_FAILED', `estimateImageTokens: ${w}x${h} 的缩放不收敛`)
}

const MILLION = 1000000
/** 定价里输入侧每百万 token 美元价的候选字段名（不同来源叫法不一）。 */
const INPUT_RATE_KEYS = ['inputPerMillion', 'inputPerMTok', 'inputUsdPerMillion', 'input']
const OUTPUT_RATE_KEYS = ['outputPerMillion', 'outputPerMTok', 'outputUsdPerMillion', 'output']

function readRate (pricing, keys) {
  if (pricing === null || typeof pricing !== 'object') return undefined
  for (const key of keys) {
    const value = pricing[key]
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * 按 model id 查内置费率表。先精确匹配，再退回「去掉 provider 前缀后唯一匹配」——
 * 调用方常传 'deepseek-v4.1-flash' 这种裸 model id，静默查不到就会算成 0，
 * 所以给一次唯一匹配的机会；命中多条就是有歧义，当查不到，不猜。
 */
function knownPricing (model) {
  if (typeof model !== 'string' || model.length === 0) return undefined
  const exact = KNOWN_PRICING[model]
  if (exact !== undefined) return exact
  const matches = Object.keys(KNOWN_PRICING).filter(key => key.slice(key.lastIndexOf('/') + 1) === model)
  return matches.length === 1 ? KNOWN_PRICING[matches[0]] : undefined
}

/**
 * 一张图占多少输入 token。优先用宿主给的定价对象（llm.imageRequestPricing 返回的
 * { priceImages(blocks) } —— 它是提供方自己的记账，含 offloaded 的处理），
 * 退而用调用方直接给的估算值；都没有就返回 0，宁可低估也不编。
 */
function readImageTokens (pricing, imageCount, images) {
  if (pricing === null || typeof pricing !== 'object') return 0
  const perImage = pricing.imageTokensPerImage
  if (Number.isFinite(perImage) && perImage >= 0) return imageCount * perImage
  if (Array.isArray(images) && images.length > 0 && typeof pricing.priceImages === 'function') {
    const prices = pricing.priceImages(images)
    if (Array.isArray(prices) && prices.length === images.length) {
      return prices.reduce((sum, price) => sum + (Number.isFinite(price?.visualTokens) ? price.visualTokens : 0), 0)
    }
  }
  const total = pricing.imageTokens
  if (Number.isFinite(total) && total >= 0) return total
  return 0
}

// 6 位小数会把 0.0032232 抹成 0.003223（一次 quick 档总价本来就只有零点几美分），
// 所以保留 9 位：既去掉浮点尾巴，又不会把小额成本截断。
const round9 = value => Math.round(value * 1e9) / 1e9
const positiveToken = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

/**
 * 估算一次调用花了多少美元。
 * 费率优先级：config.pricing > KNOWN_PRICING[model] > 无（则返回 0）。
 * 逐字段回落：config 只给了输入价时，输出价仍取内置表 —— 否则半张价格表会把成本算成一半。
 * 图片 token 一律优先用宿主自己的记账（pricing.priceImages(blocks) 的 visualTokens），
 * 它才懂 offloaded 与请求图尺寸；没有它就退到调用方给的 imageTokensPerImage / imageTokens，
 * 再没有就不计 —— 宁可低估也不编。
 * @param pricing 调用方的费率表（config.pricing），也可直接传宿主 imageRequestPricing() 的对象
 * @param model   完整或裸 model id，用于查 KNOWN_PRICING
 * @param images  已 admit 的 image 块（可选）；给了才能调 priceImages
 */
export function estimateCostUsd ({ pricing, model, imageCount = 0, textTokensIn = 0, textTokensOut = 0, images } = {}) {
  const known = knownPricing(model)
  const inputRate = readRate(pricing, INPUT_RATE_KEYS) ?? readRate(known, INPUT_RATE_KEYS)
  const outputRate = readRate(pricing, OUTPUT_RATE_KEYS) ?? readRate(known, OUTPUT_RATE_KEYS)
  if (inputRate === undefined && outputRate === undefined) return 0
  const count = positiveToken(imageCount)
  // priceImages 来自宿主对象，和费率表是两回事：定价对象里没有图片记账时再看内置表。
  const imageTokens = count > 0 ? readImageTokens(pricing, count, images) || readImageTokens(known, count, images) : 0
  const inputTokens = positiveToken(textTokensIn) + imageTokens
  const outputTokens = positiveToken(textTokensOut)
  return round9(((inputRate ?? 0) * inputTokens + (outputRate ?? 0) * outputTokens) / MILLION)
}

/**
 * 限流信号量。
 * 为什么要它：批次之间无依赖，串行是纯浪费；但 Promise.all 一把梭会同时打满网关触发 429。
 * run() 保证抛错也归还额度，否则一次失败就会永久少一条并发。
 */
export class Semaphore {
  #limit
  #active = 0
  #peak = 0
  #waiters = []

  constructor (limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw codedError('INVALID_CONCURRENCY', `Semaphore: 并发度必须是正整数，收到 ${String(limit)}`)
    }
    this.#limit = limit
  }

  get limit () { return this.#limit }
  /** 当前在飞的任务数。 */
  get active () { return this.#active }
  /** 历史最高在飞数 —— 测试靠它证明「真并发且没超限」。 */
  get peak () { return this.#peak }

  #acquire () {
    if (this.#active < this.#limit) {
      this.#active += 1
      this.#peak = Math.max(this.#peak, this.#active)
      return Promise.resolve()
    }
    return new Promise(resolve => { this.#waiters.push(resolve) })
  }

  #release () {
    const next = this.#waiters.shift()
    // 直接把名额交出去（active 不减），否则会出现瞬间超限。
    if (next === undefined) this.#active -= 1
    else next()
  }

  async run (task) {
    await this.#acquire()
    try {
      return await task()
    } finally {
      this.#release()
    }
  }
}

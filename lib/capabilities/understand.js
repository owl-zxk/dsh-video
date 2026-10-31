// 能力①：视频理解（video_understand）—— 七步管线与它必须守住的不变量
//
// 为什么这么在意「顺序」和「绝不抛」：
//  ① 七步（probe → frames → audio → batch → reframe → merge → output）是 PROMPT §2 明写的顺序。
//     frames 与 audio 明明可以并行（能省几秒），但顺序一动，「墙钟超时截断成什么样」就变得不可预测，
//     而超时语义（停在当前进度、如实标注哪几段没跑）正是这一层唯一要保证的东西。真正的并行收益在
//     视觉批次与 whisper 分块上，那两处已经在各自模块里做掉了 —— 所以这里保持串行。
//  ② 对 DSH 的约定是「永远返回 §2.6 那个结构」：整条管线外面包了一层 guard，任何未预期异常都变成
//     failures 里的一条 unexpected。冒泡上去会让模型看到一段异常栈而不是结构化数据，比降级更糟。
//  ③ 墙钟闸门**只拦可选阶段**（视觉批次 / reframe 轮 / merge），不拦 probe / 抽帧 / 转录。
//     因为抽帧与转录的产物就是「已经拿到的信息」，超时把它们砍掉正是 PROMPT §2.7.8 禁止的静默降准确率。
//     超时只是不再往下走，并在 failures 里写明哪几段没执行、timings 里留 0。
//  ④ 采样与分批的所有数字都从 budget.js 的 DETAILS 取：这个文件里没有 6/16/40/8/10 这种档位常数。
//     写死一份的话，改档位时总有一处忘记改，而它只在真机上以「帧数对不上」的形式暴露。
//  ⑤ 场景区间由**帧时间戳**推，不用模型自报的 startMs/endMs：模型给的时间窗会漂、会重叠，
//     而 §2.5.4/§2.6 要求 scenes 合并后「不重叠、不断裂」。帧是我们自己抽的，只有它是确定的。
//  ⑥ reframe 只送新帧：每轮只把窗口内新抽的帧交给模型，绝不重发首轮帧（§2.5 核心原则 / §6 禁令）。
//     合并时 reframe 描述优先，首轮描述留在 firstPass —— 验收要拿这两个字段对比「更具体了没有」。
//  ⑦ 成本只计图片输入 token：那是宿主唯一真实暴露的记账（imageRequestPricing），文本 token 无处可取，
//     宁可低估也不编。estimateCostUsd 必须拿到 model 才查得到内置费率表，否则它返回 0（C 组特意交代）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { probe } from '../media/probe.js'
import { detectScenes, extractFrames, planFrames } from '../media/frames.js'
import { REFRAME_LIMITS, extractWindow, validateWindow, windowSignature } from '../media/reframe.js'
import { transcribe as transcribeAudio } from '../media/audio.js'
import { analyzeBatchWithRetry, mergeAnalysis } from '../llm/vision.js'
import { DETAILS, Semaphore, estimateCostUsd, planBatches, resolveDetail } from '../llm/budget.js'
import { TIMING_KEYS, createTimers, deadline } from '../util/perf.js'
import { DEFAULT_MODELS, resolveBinaries, splitRoute, tmpWorkspace } from '../util/paths.js'
import { defineCapability } from './registry.js'

/** 墙钟默认上限：PROMPT §2.7.7 写的是 5 分钟。 */
const DEFAULT_WALL_CLOCK_MS = 300000
/** whisper 模型按档位选（PROMPT §2.7.6：quick 用 base，其余用 small）。名字不是数字，不进 DETAILS。 */
const WHISPER_MODEL = Object.freeze({ quick: 'base', standard: 'small', deep: 'small' })
/** 视觉批次并发度公式（PROMPT §2.7.5）：min(4, max(2, cpus - 2))。 */
const CONCURRENCY_MAX = 4
const CONCURRENCY_MIN = 2
const CONCURRENCY_CPU_RESERVE = 2
/** failures.detail 的长度上限：一条失败说明不需要整篇 stderr。 */
const DETAIL_MAX = 300

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 异常 → failures.reason。文本会变，code 不会，所以 reason 只用 code（没有 code 才退回给定的兜底）。 */
function reasonOf (error, fallback) {
  const code = error === null || error === undefined ? '' : String(error.code === undefined ? '' : error.code)
  return code.length > 0 ? code : fallback
}

function messageOf (error) {
  const text = error === null || error === undefined ? '' : String(error.message === undefined ? error : error.message)
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) : text
}

/** 一条 failures 记录：只放 schema 里有、且确实有值的键（§15：不许给 undefined）。 */
function failure (stage, reason, extra) {
  const out = { stage, reason }
  if (extra !== null && typeof extra === 'object') {
    const batch = Number(extra.batch)
    if (Number.isFinite(batch)) out.batch = Math.max(0, Math.round(batch))
    if (typeof extra.detail === 'string' && extra.detail.length > 0) out.detail = extra.detail
  }
  return out
}

function intOf (value) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function numOf (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 0
}

function stringList (value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text.length > 0) out.push(text)
  }
  return out
}

/** 两个字符串数组合并去重：reframe 的文字补进场景时不能把首轮的字丢掉。 */
function uniqueStrings (left, right) {
  const out = []
  for (const item of [...stringList(left), ...stringList(right)]) {
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/** §2 的 8 个 timing 键；没跑的段记 0（不许漏键，否则 timings 的形状会随执行路径漂移）。 */
function zeroTimings () {
  const out = {}
  for (const key of TIMING_KEYS) out[key] = 0
  return out
}

/** §2.6 的 17 个键的空壳。任何提前退出的路径都从它出发，保证键不少、值不为 undefined。 */
function emptyResult (overrides) {
  const base = {
    source: '',
    durationMs: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: false,
    model: '',
    framesAnalyzed: 0,
    reframes: [],
    scenes: [],
    transcript: [],
    summary: '',
    answer: '',
    failures: [],
    timings: zeroTimings(),
    concurrency: 1,
    estimatedCostUsd: 0
  }
  if (overrides === null || typeof overrides !== 'object') return base
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined) base[key] = overrides[key]
  }
  return base
}

function normalizeReframeEntry (raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  const entry = {
    round: Math.max(0, intOf(item.round)),
    startMs: Math.max(0, intOf(item.startMs)),
    endMs: Math.max(0, intOf(item.endMs)),
    // reason 只放模型原文；拒绝码另走 rejectReason（见 mkReframe 的注释）
    reason: typeof item.reason === 'string' ? item.reason : '',
    kind: typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : 'detail',
    frames: Math.max(0, intOf(item.frames)),
    accepted: item.accepted === true
  }
  if (entry.accepted === false) entry.rejectReason = typeof item.rejectReason === 'string' ? item.rejectReason : ''
  return entry
}

function normalizeTranscript (value) {
  const out = []
  for (const raw of Array.isArray(value) ? value : []) {
    if (raw === null || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const startMs = Math.max(0, intOf(raw.startMs))
    const endMs = Math.max(0, intOf(raw.endMs))
    if (text.length === 0 || endMs <= startMs) continue
    out.push({ startMs, endMs, text })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * scenes 的归一化与「不重叠不断裂」修正在这里做（唯一一处）。
 * 为什么后一段的起点直接钉到前一段的终点：模型自报的窗口会重叠、会留缝；
 * 而 §2.5.4 要求合并后的时间轴必须首尾相接。修正在出口做，任何上游写歪了都兜得住。
 */
function normalizeScenes (value) {
  const out = []
  for (const raw of Array.isArray(value) ? value : []) {
    if (raw === null || typeof raw !== 'object') continue
    const scene = {
      startMs: Math.max(0, intOf(raw.startMs)),
      endMs: Math.max(0, intOf(raw.endMs)),
      frames: Array.isArray(raw.frames) ? raw.frames.map(n => Math.max(0, intOf(n))) : [],
      visual: typeof raw.visual === 'string' ? raw.visual : '',
      onScreenText: stringList(raw.onScreenText),
      actions: stringList(raw.actions)
    }
    if (typeof raw.firstPass === 'string') scene.firstPass = raw.firstPass
    out.push(scene)
  }
  out.sort((a, b) => a.startMs - b.startMs)
  for (let i = 0; i < out.length; i += 1) {
    if (i > 0 && out[i].startMs !== out[i - 1].endMs) out[i].startMs = out[i - 1].endMs
    if (out[i].endMs <= out[i].startMs) out[i].endMs = out[i].startMs + 1
  }
  return out
}

function timingsOf (value) {
  const out = zeroTimings()
  if (value !== null && typeof value === 'object') {
    for (const key of TIMING_KEYS) out[key] = Math.max(0, intOf(value[key]))
  }
  return out
}

/** 出口归一化：17 个键、类型、排序、区间连贯，全在这一个函数里保证。 */
function normalizeOutput (value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  const out = emptyResult()
  out.source = typeof raw.source === 'string' ? raw.source : ''
  out.durationMs = Math.max(0, intOf(raw.durationMs))
  out.width = Math.max(0, intOf(raw.width))
  out.height = Math.max(0, intOf(raw.height))
  out.fps = numOf(raw.fps)
  out.hasAudio = raw.hasAudio === true
  out.model = typeof raw.model === 'string' ? raw.model : ''
  out.framesAnalyzed = Math.max(0, intOf(raw.framesAnalyzed))
  out.reframes = (Array.isArray(raw.reframes) ? raw.reframes : []).map(normalizeReframeEntry)
  out.scenes = normalizeScenes(raw.scenes)
  out.transcript = normalizeTranscript(raw.transcript)
  out.summary = typeof raw.summary === 'string' ? raw.summary : ''
  out.answer = typeof raw.answer === 'string' && raw.answer.length > 0 ? raw.answer : out.summary
  out.failures = []
  for (const item of Array.isArray(raw.failures) ? raw.failures : []) {
    if (item === null || typeof item !== 'object') continue
    out.failures.push(failure(String(item.stage), String(item.reason), item))
  }
  out.timings = timingsOf(raw.timings)
  out.concurrency = Math.max(1, intOf(raw.concurrency))
  const cost = Number(raw.estimatedCostUsd)
  out.estimatedCostUsd = Number.isFinite(cost) && cost > 0 ? cost : 0
  return out
}

function defaultConcurrency () {
  const cores = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : CONCURRENCY_MIN
  return Math.max(1, Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, cores - CONCURRENCY_CPU_RESERVE)))
}

/** 整数夹取；非数字/NaN 视为「没给」，退回 fallback。 */
function clampInt (value, min, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= min ? n : fallback
}

/**
 * maxFrames 的入口夹取。
 * planFrames 收到 <= 0 或非数字会 throw（契约 §7 明确「调用方负责在入口夹到 >= 1」），
 * 而异常一旦冒泡到 DSH，用户看到的就是一段栈而不是结构化结果 —— 所以夹在这里，不夹在 planFrames 里。
 */
function normalizeMaxFrames (value, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * 入参 + config → 管线用的输入。所有档位数字都来自 DETAILS（§2 唯一事实来源）。
 * 三个开关的优先级刻意写成「args > config > DETAILS」：用户显式给的最优先，插件不替用户决定档位。
 */
function normalizeInput (args, config) {
  const detail = resolveDetail(args.detail)
  const preset = DETAILS[detail]
  const modelArg = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : ''
  const modelConfig = typeof config.model === 'string' && config.model.trim() !== '' ? config.model.trim() : ''
  const model = modelArg !== '' ? modelArg : (modelConfig !== '' ? modelConfig : DEFAULT_MODELS[detail])
  const route = splitRoute(model, config)
  const adaptive = args.adaptive === undefined ? preset.maxRounds > 0 : args.adaptive === true
  return {
    videoPath: typeof args.path === 'string' ? args.path.trim() : '',
    question: typeof args.question === 'string' ? args.question.trim() : '',
    detail,
    // 输出里的 model 一律是 provider/model：只给裸 model id 时也要补齐 provider，否则用户看不出跑的是谁
    model: route.model === '' ? String(model) : route.provider + '/' + route.model,
    provider: route.provider,
    modelId: route.model,
    lang: typeof args.lang === 'string' && args.lang.trim() !== '' ? args.lang.trim() : (typeof config.lang === 'string' && config.lang.trim() !== '' ? config.lang.trim() : 'zh'),
    maxFrames: normalizeMaxFrames(args.maxFrames, preset.maxFrames),
    batchSize: preset.batchSize,
    maxRounds: adaptive ? clampInt(args.maxRounds, 0, preset.maxRounds) : 0,
    maxExtraFrames: clampInt(args.maxExtraFrames, 0, preset.maxExtraFrames),
    maxCostUsd: Number.isFinite(Number(args.maxCostUsd)) && Number(args.maxCostUsd) >= 0 ? Number(args.maxCostUsd) : preset.maxCostUsd,
    maxReframeWindows: clampInt(args.maxReframeWindows, 1, REFRAME_LIMITS.maxReframeWindows),
    maxWindowMs: clampInt(args.maxWindowMs, 1, REFRAME_LIMITS.maxWindowMs),
    concurrency: clampInt(args.concurrency, 1, clampInt(config.concurrency, 1, defaultConcurrency())),
    maxWallClockMs: Number.isFinite(Number(args.maxWallClockMs)) && Number(args.maxWallClockMs) > 0
      ? Number(args.maxWallClockMs)
      : (Number.isFinite(Number(config.maxWallClockMs)) && Number(config.maxWallClockMs) > 0 ? Number(config.maxWallClockMs) : DEFAULT_WALL_CLOCK_MS),
    whisperModel: WHISPER_MODEL[detail] === undefined ? 'small' : WHISPER_MODEL[detail],
    signal: undefined
  }
}

/** 帧文件 → base64。读不出来就当这帧没抽到（不抛：一帧读不成不该拖垮整条管线）。 */
function framePayload (frame) {
  try {
    const data = fs.readFileSync(frame.file).toString('base64')
    if (data.length === 0) return null
    return {
      index: Math.max(0, intOf(frame.index)),
      ms: Math.max(0, intOf(frame.ms)),
      data,
      mediaType: 'image/jpeg'
    }
  } catch {
    return null
  }
}

function loadFrames (frames) {
  const out = []
  for (const frame of Array.isArray(frames) ? frames : []) {
    const payload = framePayload(frame)
    if (payload !== null) out.push(payload)
  }
  return out
}

/**
 * 一批首轮帧 → 场景区间。
 * 相邻两批的边界取「上一批最后一帧」与「下一批第一帧」的中点，首段从 0 起、末段到 durationMs 止 ——
 * 这样产出的区间天然不重叠、不断裂，且和帧时间戳对得上（§2.2 要求时间戳能对上视频实际进度）。
 */
function buildScenes (passes, durationMs) {
  const ordered = [...passes].sort((a, b) => a.firstMs - b.firstMs)
  const scenes = []
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i]
    const startMs = i === 0 ? 0 : Math.round((ordered[i - 1].lastMs + current.firstMs) / 2)
    const naturalEnd = i === ordered.length - 1 ? Math.max(startMs, durationMs) : Math.round((current.lastMs + ordered[i + 1].firstMs) / 2)
    const ceiling = durationMs > 0 ? Math.max(startMs + 1, durationMs) : Number.MAX_SAFE_INTEGER
    scenes.push({
      startMs,
      endMs: Math.min(Math.max(startMs + 1, naturalEnd), ceiling),
      frames: [...current.frameIndexes],
      visual: current.visual,
      onScreenText: [...current.onScreenText],
      actions: [...current.actions]
    })
  }
  return scenes
}

/**
 * 把一条 reframe 的描述并回它覆盖最多的那个场景（增量合并，不新增场景）。
 * reframe 的 visual 优先（更近、信息更多），首轮那句留在 firstPass；多次 reframe 打到同一段时
 * firstPass 只写一次（永远是首轮那句）—— 验收就是拿这两个字段对比。
 */
function applyReframe (scenes, window, result) {
  let target = null
  let bestOverlap = 0
  for (const scene of scenes) {
    const overlap = Math.min(scene.endMs, window.endMs) - Math.max(scene.startMs, window.startMs)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      target = scene
    }
  }
  if (target === null) return false
  const visual = result !== null && typeof result === 'object' && typeof result.visual === 'string' ? result.visual.trim() : ''
  if (visual.length > 0) {
    if (target.firstPass === undefined) target.firstPass = target.visual
    target.visual = visual
  }
  target.onScreenText = uniqueStrings(target.onScreenText, result === null || typeof result !== 'object' ? [] : result.onScreenText)
  target.actions = uniqueStrings(target.actions, result === null || typeof result !== 'object' ? [] : result.actions)
  return true
}

/** 收集上一轮的 needsReframe（vision 已经补成 []，这里再守一道）。 */
function collectReframes (passes) {
  const out = []
  for (const pass of passes) {
    for (const request of Array.isArray(pass.needsReframe) ? pass.needsReframe : []) out.push(request)
  }
  return out
}

/**
 * 三重闸门在每一轮门口统一判定：墙钟 / 额外帧总数（跨轮累计）/ 成本。
 * 返回的是**拒绝理由代码**，直接写进 reframes[].reason —— 被拒的请求必须留下记录，不许静默丢。
 */
function blockReason (clock, extraFrames, input, costNow) {
  if (clock.exceeded()) return 'wall-clock-exceeded'
  if (extraFrames >= input.maxExtraFrames) return 'frame-budget'
  if (input.maxCostUsd > 0 && costNow() >= input.maxCostUsd) return 'cost-budget'
  return null
}

/**
 * 一次调用的成本估算。model 必须传：estimateCostUsd 靠它查内置费率表，不传就恒返回 0。
 * 图片 token 用 vision 实测回来的 imageTokens（按归一化后的真实尺寸算的），除回每张的平均值给过去。
 */
function costOf (pricing, model, imageCount, imageTokens) {
  const perImage = imageCount > 0 ? Math.round(imageTokens / imageCount) : 0
  const rates = pricing !== null && typeof pricing === 'object' ? { ...pricing, imageTokensPerImage: perImage } : { imageTokensPerImage: perImage }
  return estimateCostUsd({ pricing: rates, model, imageCount, textTokensIn: 0, textTokensOut: 0 })
}

/** 毫秒 → mm:ss.s（帧标签与 failures 文案共用，人也要能对上视频进度）。 */
function timecode (ms) {
  const total = Math.max(0, intOf(ms))
  const minutes = Math.floor(total / 60000)
  const seconds = (total % 60000) / 1000
  const secText = seconds.toFixed(1)
  return (minutes < 10 ? '0' + minutes : String(minutes)) + ':' + (secText.length < 4 ? '0' + secText : secText)
}

/**
 * deps 的两层含义（契约 §13 + §5 的接缝约定）：
 *  · 生产用的必填项：llm / attachments / binaries / config / signal / log。
 *  · 测试与调优用的**接缝**（与契约 §5 的 runImpl 同一性质，不是业务参数）：
 *      runImpl    子进程接缝，默认 media/ffmpeg.js 的 run —— 测试靠它数 spawn 次数、造失败；
 *      transcribe 转写接缝，默认 media/audio.js 的 transcribe —— 真 whisper 慢且不确定，
 *                 内容链路用替身覆盖、无音轨链路仍走真的（两个都测得到）；
 *      sleep      重试退避接缝（vision 用它），默认真定时器 —— 测试里不能真等 500/1500ms；
 *      pricing / BlockAssembler 由 lib/index.js 注入宿主实现（config.pricing、真累加器）；
 *      now        时钟接缝，配合 maxWallClockMs 做超时用例。
 */
async function runPipeline (input, deps) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const timers = createTimers(now)
  const clock = deadline(input.maxWallClockMs, now)
  const log = typeof deps.log === 'function' ? deps.log : null
  const config = deps.config !== null && typeof deps.config === 'object' ? deps.config : {}
  const binaries = deps.binaries !== null && typeof deps.binaries === 'object' ? deps.binaries : resolveBinaries(config)
  const runImpl = typeof deps.runImpl === 'function' ? deps.runImpl : undefined
  const transcribeImpl = typeof deps.transcribe === 'function' ? deps.transcribe : transcribeAudio
  const marker = input.model
  const source = input.videoPath === '' ? '' : path.basename(input.videoPath)
  const failures = []
  const skipped = []
  const note = (entry) => {
    failures.push(entry)
    if (log !== null) log('[dsh-video] ' + entry.stage + ': ' + entry.reason)
  }
  const early = (overrides) => normalizeOutput(emptyResult({
    source,
    model: marker,
    concurrency: input.concurrency,
    failures,
    timings: timers.timings(),
    ...overrides
  }))

  if (input.videoPath === '') {
    note(failure('input', 'path-required', { detail: 'path 必填：本地视频文件路径' }))
    return early({})
  }

  let workDir = ''
  try {
    workDir = tmpWorkspace('dsh-video-understand-')
  } catch {
    workDir = ''
  }

  try {
    // ① probe：唯一一件「拿不到就没法继续」的事（拿不到也照样返回结构化结果）
    let meta
    try {
      meta = await timers.span('probeMs', () => probe(input.videoPath, { ffprobe: binaries.ffprobe, signal: deps.signal, runImpl }))
    } catch (error) {
      note(failure('probe', reasonOf(error, 'probe-failed'), { detail: messageOf(error) }))
      return early({})
    }
    const durationMs = Math.max(0, intOf(meta.durationMs))

    // ② frames：场景检测（全片唯一一次全解码）→ 规划 → 抽帧。三组混合采样在 frames.js 里。
    const frameDir = workDir === '' ? undefined : path.join(workDir, 'frames')
    let frames = []
    timers.start('framesMs')
    try {
      const sceneTimes = await detectScenes(input.videoPath, { ffmpeg: binaries.ffmpeg, signal: deps.signal, runImpl })
      const plan = planFrames({ durationMs, sceneTimes, maxFrames: input.maxFrames })
      frames = await extractFrames(input.videoPath, plan, {
        ffmpeg: binaries.ffmpeg,
        dir: frameDir,
        concurrency: input.concurrency,
        signal: deps.signal,
        runImpl
      })
    } catch (error) {
      note(failure('frames', reasonOf(error, 'frames-failed'), { detail: messageOf(error) }))
    } finally {
      timers.stop('framesMs')
    }
    const firstRound = loadFrames(frames)
    if (firstRound.length < frames.length) {
      note(failure('frames', 'frame-unreadable', { detail: '有 ' + (frames.length - firstRound.length) + ' 帧读不成 base64，已跳过' }))
    }

    // ③ audio：抽音轨 + whisper（分块并发 + 繁转简都在 audio.js 里）。绝不 throw，失败进 failures。
    let transcript = []
    timers.start('audioMs')
    try {
      const audio = await transcribeImpl(input.videoPath, {
        ffmpeg: binaries.ffmpeg,
        whisperBin: binaries.whisperBin,
        whisperDir: binaries.whisperDir,
        modelName: input.whisperModel,
        lang: input.lang,
        concurrency: input.concurrency,
        signal: deps.signal,
        meta,
        runImpl
      })
      transcript = Array.isArray(audio === null || typeof audio !== 'object' ? null : audio.segments) ? audio.segments : []
      const audioFailures = audio !== null && typeof audio === 'object' && Array.isArray(audio.failures) ? audio.failures : []
      for (const item of audioFailures) {
        const reason = item !== null && typeof item === 'object' && typeof item.reason === 'string' ? item.reason : 'whisper-failed'
        const detail = item !== null && typeof item === 'object' && typeof item.detail === 'string' ? item.detail : ''
        note(failure('audio', reason, { detail }))
      }
    } catch (error) {
      note(failure('audio', reasonOf(error, 'whisper-failed'), { detail: messageOf(error) }))
    } finally {
      timers.stop('audioMs')
    }

    // ④ batch：每批一次 analyzeBatchWithRetry，批间用真 Semaphore 限流（不是 Promise.all 一把梭）
    const visionDeps = {
      llm: deps.llm,
      attachments: deps.attachments,
      provider: input.provider,
      model: input.modelId,
      signal: deps.signal,
      BlockAssembler: deps.BlockAssembler,
      pricing: deps.pricing,
      ...(typeof deps.sleep === 'function' ? { sleep: deps.sleep } : {})
    }
    const semaphore = new Semaphore(input.concurrency)
    const usage = { imageCount: 0, imageTokens: 0 }
    const costNow = () => costOf(deps.pricing, input.model, usage.imageCount, usage.imageTokens)
    const account = (result, count) => {
      usage.imageCount += Math.max(0, Math.round(Number(count) || 0))
      const tokens = result !== null && typeof result === 'object' ? Number(result.imageTokens) : 0
      if (Number.isFinite(tokens) && tokens > 0) usage.imageTokens += tokens
    }

    const passes = []
    let batchCursor = 0
    if (firstRound.length === 0) {
      note(failure('frames', 'no-frames', { detail: '一帧都没抽到，视觉分析无从下手' }))
    } else if (clock.exceeded()) {
      skipped.push('视觉批次')
    } else {
      const analyzePass = async (batch) => {
        const slice = firstRound.slice(batch.from, batch.to)
        const windows = {
          index: batch.index,
          frames: slice.map(frame => ({ ms: frame.ms, data: frame.data, mediaType: frame.mediaType })),
          windowStartMs: slice[0].ms,
          windowEndMs: slice[slice.length - 1].ms,
          durationMs
        }
        try {
          const result = await analyzeBatchWithRetry(visionDeps, windows)
          account(result, slice.length)
          return {
            ok: true,
            pass: {
              ...result,
              firstMs: slice[0].ms,
              lastMs: slice[slice.length - 1].ms,
              frameIndexes: slice.map(frame => frame.index)
            }
          }
        } catch (error) {
          return { ok: false, index: batch.index, reason: reasonOf(error, 'model-failed'), detail: messageOf(error) }
        }
      }
      const batches = planBatches(firstRound.length, input.batchSize)
      batchCursor = batches.length
      timers.start('visionMs')
      try {
        const settled = await Promise.all(batches.map(batch => semaphore.run(() => analyzePass(batch))))
        for (const item of settled) {
          if (item.ok) passes.push(item.pass)
          else note(failure('batch', item.reason, { batch: item.index, detail: item.detail }))
        }
      } finally {
        timers.stop('visionMs')
      }
    }

    // ⑤ reframe：收集 needsReframe → 三重闸门 + 单轮窗口上限 + 签名去重 → 只把**新帧**送回模型。
    //    循环受 maxRounds 限制；maxRounds 0 时连一条记录都不写（关闭就是关闭，与 PROMPT §2.5.5 一致）。
    const reframes = []
    const reframeResults = []
    const seen = new Set()
    let extraFrames = 0
    timers.start('reframeMs')
    try {
      if (input.maxRounds > 0 && skipped.length === 0 && firstRound.length > 0) {
        let candidates = collectReframes(passes)
        for (let round = 1; round <= input.maxRounds && candidates.length > 0; round += 1) {
          const blocked = blockReason(clock, extraFrames, input, costNow)
          if (blocked !== null) {
            // 闸门挡住的请求同样要留下记录（accepted:false + 拒绝代码），不许静默丢
            for (const request of candidates) reframes.push(mkReframe(round, request, false, blocked, 0))
            if (blocked === 'wall-clock-exceeded') skipped.push('reframe 轮')
            candidates = []
            break
          }
          const jobs = []
          for (const request of candidates) {
            if (jobs.length >= input.maxReframeWindows) {
              reframes.push(mkReframe(round, request, false, 'window-limit', 0))
              continue
            }
            const verdict = validateWindow(request, {
              durationMs,
              limits: { ...REFRAME_LIMITS, maxWindowMs: input.maxWindowMs },
              seen
            })
            if (verdict.accepted !== true) {
              reframes.push(mkReframe(round, request, false, verdict.reason, 0))
              continue
            }
            // 签名在**接受时**就记下来：抽帧失败也算「这段看过了」，否则模型下一轮还会再要一次
            seen.add(windowSignature(request.startMs, request.endMs))
            const entry = mkReframe(round, request, true, '', 0)
            reframes.push(entry)
            jobs.push({ request, entry })
          }
          if (jobs.length === 0) {
            candidates = []
            break
          }
          const analyzeWindow = async (job, offset) => {
            const window = job.request
            const dir = workDir === '' ? undefined : path.join(workDir, 'win-' + round + '-' + offset)
            let extracted = []
            try {
              extracted = await extractWindow(input.videoPath, { startMs: window.startMs, endMs: window.endMs }, {
                ffmpeg: binaries.ffmpeg,
                ...(dir === undefined ? {} : { dir }),
                runImpl
              })
            } catch (error) {
              note(failure('reframe', reasonOf(error, 'extract-failed'), { detail: messageOf(error) }))
              return { ok: false }
            }
            const payload = loadFrames(extracted)
            job.entry.frames = payload.length
            extraFrames += payload.length
            if (payload.length === 0) return { ok: false }
            batchCursor += 1
            try {
              const result = await analyzeBatchWithRetry(visionDeps, {
                index: batchCursor,
                frames: payload.map(frame => ({ ms: frame.ms, data: frame.data, mediaType: frame.mediaType })),
                windowStartMs: window.startMs,
                windowEndMs: window.endMs,
                durationMs
              })
              account(result, payload.length)
              return { ok: true, window, result }
            } catch (error) {
              note(failure('reframe', reasonOf(error, 'model-failed'), { detail: messageOf(error) }))
              return { ok: false }
            }
          }
          const settled = await Promise.all(jobs.map((job, offset) => semaphore.run(() => analyzeWindow(job, offset))))
          candidates = []
          for (const item of settled) {
            if (item.ok !== true) continue
            reframeResults.push({ startMs: item.window.startMs, endMs: item.window.endMs, result: item.result })
            for (const request of Array.isArray(item.result.needsReframe) ? item.result.needsReframe : []) candidates.push(request)
          }
        }
        // 轮数用完还有没处理完的请求：记成 round-limit，别让它们消失（§2.5.3「不合法直接丢弃并记进 reframes」）
        for (const request of candidates) reframes.push(mkReframe(input.maxRounds + 1, request, false, 'round-limit', 0))
      }
    } finally {
      timers.stop('reframeMs')
    }

    // ⑥ merge：只带文字、不带图（§2.3），串行，永远在最后
    const scenes = buildScenes(passes, durationMs)
    for (const item of reframeResults) applyReframe(scenes, item, item.result)
    let summary = ''
    let answer = ''
    if (clock.exceeded()) {
      skipped.push('merge（汇总）')
    } else {
      timers.start('mergeMs')
      try {
        const merged = await mergeAnalysis(visionDeps, {
          question: input.question,
          scenes,
          transcript,
          reframes: reframeResults.map(item => ({ startMs: item.startMs, endMs: item.endMs, visual: item.result.visual })),
          meta: { durationMs }
        })
        summary = merged !== null && typeof merged === 'object' && typeof merged.summary === 'string' ? merged.summary : ''
        answer = merged !== null && typeof merged === 'object' && typeof merged.answer === 'string' ? merged.answer : ''
      } catch (error) {
        note(failure('merge', reasonOf(error, 'merge-failed'), { detail: messageOf(error) }))
      } finally {
        timers.stop('mergeMs')
      }
    }

    // ⑦ output：超时截断必须留一条可读的失败记录（PROMPT §2.7.7：不许跳过却假装做过）
    if (skipped.length > 0) {
      note(failure('timeout', 'wall-clock-exceeded', {
        detail: skipped.join(' / ') + ' 未执行（墙钟上限 ' + input.maxWallClockMs + 'ms）'
      }))
    }

    return normalizeOutput({
      source,
      durationMs,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio === true,
      model: input.model,
      // framesAnalyzed = 首轮抽到并准备送模型的帧数：超时**不减少**它（§5「帧数没有被动减少」）
      framesAnalyzed: firstRound.length,
      reframes,
      scenes,
      transcript,
      summary,
      // 没给 question 时 answer 就是 summary（§2.6）；给了但模型答不出才退回 summary
      answer: input.question === '' ? summary : (answer !== '' ? answer : summary),
      failures,
      timings: timers.timings(),
      concurrency: input.concurrency,
      estimatedCostUsd: costNow()
    })
  } finally {
    if (workDir !== '') {
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 临时目录删不掉不影响结果
      }
    }
  }
}

/**
 * reframes[] 的一条记录。
 * 为什么 reason 与 rejectReason 要分开（不合成一个字段）：§2.6 的 reason 是**模型给的理由**
 * （「看不清右下角的小字」），而拒绝码（duplicate / frame-budget / …）是我们内部的记账。
 * 塞进同一字段的话，下游统计「模型最常因为什么要特写」时会混进内部码，两边都读不准。
 * 所以：reason 永远是模型原文（被拒时也原样保留，可能为空串）；拒绝码只在 accepted=false
 * 时以 rejectReason 出现，accepted=true 时**连键都不写**（写 null 也会污染下游）。
 */
function mkReframe (round, request, accepted, rejectCode, frames) {
  const item = request !== null && typeof request === 'object' ? request : {}
  const entry = {
    round,
    startMs: Math.max(0, intOf(item.startMs)),
    endMs: Math.max(0, intOf(item.endMs)),
    reason: typeof item.reason === 'string' ? item.reason : '',
    kind: typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : 'detail',
    frames: Math.max(0, intOf(frames)),
    accepted: accepted === true
  }
  if (entry.accepted === false) entry.rejectReason = typeof rejectCode === 'string' ? rejectCode : ''
  return entry
}

/**
 * 工具入口。**永远 resolve**：任何未预期异常都变成 failures 里的一条 unexpected。
 * 契约 §13 说得很直白：模型全挂也只返回 scenes:[] + failures 非空，绝不把异常抛给 DSH。
 */
export async function runUnderstand (args, deps) {
  const safeArgs = args !== null && typeof args === 'object' ? args : {}
  const safeDeps = deps !== null && typeof deps === 'object' ? deps : {}
  const config = safeDeps.config !== null && typeof safeDeps.config === 'object' ? safeDeps.config : {}
  try {
    return normalizeOutput(await runPipeline(normalizeInput(safeArgs, config), safeDeps))
  } catch (error) {
    return normalizeOutput(emptyResult({
      source: typeof safeArgs.path === 'string' ? path.basename(safeArgs.path) : '',
      model: typeof safeArgs.model === 'string' ? safeArgs.model : '',
      failures: [failure('unexpected', reasonOf(error, 'unexpected'), { detail: messageOf(error) })]
    }))
  }
}

/** video_understand 的参数 spec（dsh 的 schema spec：必填是属性级 required，契约 §19.1）。 */
export const understandParameters = {
  path: { type: 'string', required: true, description: '本地视频文件路径（必填）。只读本机文件，不做下载。' },
  question: { type: 'string', description: '想问的问题；不给就做整体理解（answer 等于 summary）。' },
  detail: { type: 'string', enum: ['quick', 'standard', 'deep'], description: '档位：quick 先看一眼 / standard 默认 / deep 细节多。决定帧数、批大小、重采样轮数与成本上限。' },
  maxFrames: { type: 'number', description: '抽帧上限；不给按 detail 推导。<=0 或非数字按 1 处理（不会少于 1 帧）。' },
  lang: { type: 'string', description: '音频语言，默认 zh。不要用 auto：中文会被误判成粤语/日文。' },
  model: { type: 'string', description: '视觉模型 provider/model；不给按 detail 推导。模型必须吃图，否则明确失败而不是静默降级。' },
  adaptive: { type: 'boolean', description: '是否开启自适应重采样（模型可以要求看某一段的特写）；不给按 detail 推导。' },
  maxRounds: { type: 'number', description: '自适应重采样轮数上限；0 = 完全关闭（reframes 会是空数组）。' },
  maxExtraFrames: { type: 'number', description: '重采样额外帧总数上限（跨轮累计）。' },
  maxCostUsd: { type: 'number', description: '本次调用的成本上限（美元）；超了就停止重采样。' },
  maxReframeWindows: { type: 'number', description: '单轮最多接受几个重采样窗口。' },
  concurrency: { type: 'number', description: '并发度（视觉批次 / whisper 分块）；不给按 CPU 核数推导。' },
  maxWallClockMs: { type: 'number', description: '墙钟上限；超时返回已完成部分并在 failures 里写明哪几段没执行（帧数不会因此减少）。' }
}

/** video_understand 的输出 spec（§2.6 的 17 个键，一个不少；缺数据给 [] / 0）。 */
export const understandOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    durationMs: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    fps: { type: 'number', required: true },
    hasAudio: { type: 'boolean', required: true },
    model: { type: 'string', required: true },
    framesAnalyzed: { type: 'number', required: true },
    reframes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'number', required: true },
          startMs: { type: 'number', required: true },
          endMs: { type: 'number', required: true },
          reason: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          frames: { type: 'number', required: true },
          accepted: { type: 'boolean', required: true },
          rejectReason: { type: 'string' }
        }
      }
    },
    scenes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startMs: { type: 'number', required: true },
          endMs: { type: 'number', required: true },
          frames: { type: 'array', required: true, items: { type: 'number' } },
          visual: { type: 'string', required: true },
          onScreenText: { type: 'array', required: true, items: { type: 'string' } },
          actions: { type: 'array', required: true, items: { type: 'string' } },
          firstPass: { type: 'string' }
        }
      }
    },
    transcript: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startMs: { type: 'number', required: true },
          endMs: { type: 'number', required: true },
          text: { type: 'string', required: true }
        }
      }
    },
    summary: { type: 'string', required: true },
    answer: { type: 'string', required: true },
    failures: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          batch: { type: 'number' },
          stage: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          detail: { type: 'string' }
        }
      }
    },
    timings: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        probeMs: { type: 'number', required: true },
        framesMs: { type: 'number', required: true },
        audioMs: { type: 'number', required: true },
        visionMs: { type: 'number', required: true },
        reframeMs: { type: 'number', required: true },
        mergeMs: { type: 'number', required: true },
        totalMs: { type: 'number', required: true },
        wallClockMs: { type: 'number', required: true }
      }
    },
    concurrency: { type: 'number', required: true },
    estimatedCostUsd: { type: 'number', required: true }
  }
}

/** 把结果渲染成人能读的几行（defineTool 的 output.render 就是它，纯函数）。 */
function renderUnderstandResult (args, value) {
  const v = value !== null && typeof value === 'object' ? value : {}
  const lines = []
  const scenes = Array.isArray(v.scenes) ? v.scenes : []
  const transcript = Array.isArray(v.transcript) ? v.transcript : []
  const reframes = Array.isArray(v.reframes) ? v.reframes : []
  const failures = Array.isArray(v.failures) ? v.failures : []
  lines.push('视频：' + String(v.source === undefined ? '' : v.source) + ' · ' + timecode(v.durationMs) + ' · '
    + String(v.width === undefined ? 0 : v.width) + 'x' + String(v.height === undefined ? 0 : v.height) + ' · '
    + String(v.fps === undefined ? 0 : v.fps) + 'fps · ' + (v.hasAudio === true ? '有音轨' : '无音轨'))
  lines.push('模型：' + String(v.model === undefined ? '' : v.model) + ' · 首轮 ' + String(v.framesAnalyzed === undefined ? 0 : v.framesAnalyzed) + ' 帧 · 重采样 '
    + String(reframes.filter(item => item !== null && typeof item === 'object' && item.accepted === true).length) + ' 次 · 估算 $' + String(v.estimatedCostUsd === undefined ? 0 : v.estimatedCostUsd))
  if (typeof v.answer === 'string' && v.answer.length > 0) lines.push('回答：' + v.answer)
  if (typeof v.summary === 'string' && v.summary.length > 0) lines.push('总结：' + v.summary)
  for (const scene of scenes.slice(0, 20)) {
    if (scene === null || typeof scene !== 'object') continue
    lines.push('· ' + timecode(scene.startMs) + ' - ' + timecode(scene.endMs) + ' ' + String(scene.visual === undefined ? '' : scene.visual))
  }
  if (scenes.length > 20) lines.push('（还有 ' + (scenes.length - 20) + ' 段未展开）')
  if (transcript.length > 0) {
    lines.push('转录：' + transcript.slice(0, 10).map(item => String(item === null || typeof item !== 'object' ? '' : item.text)).join(' / '))
    if (transcript.length > 10) lines.push('（转录共 ' + transcript.length + ' 段）')
  }
  const refused = reframes.filter(item => item !== null && typeof item === 'object' && item.accepted === false)
  if (refused.length > 0) {
    lines.push('被拒的重采样请求：' + refused.map(item => String(item.reason)).join(' / '))
  }
  if (failures.length > 0) {
    lines.push('失败（' + failures.length + '）：' + failures.map(item => String(item === null || typeof item !== 'object' ? '' : (String(item.stage) + '/' + String(item.reason)))).join(' / '))
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export const understandCapability = defineCapability({
  id: 'video_understand',
  tool: {
    name: 'video_understand',
    description: '理解一个本地视频文件：画面（混合采样抽帧 + 视觉模型分批看）、声音（whisper 转录，带毫秒时间轴），'
      + '合成按时间排好的结构化结果（scenes / transcript / summary / answer）。'
      + '模型可以在看的过程中要求看某一段的特写（自适应重采样，受轮数/额外帧数/成本三重闸门限制），'
      + '因此对细节多的视频可以把 detail 设成 deep。永远返回结构化结果：模型或 whisper 挂掉时只是 failures 非空。',
    parameters: understandParameters,
    outputSchema: understandOutputSchema,
    renderResult: renderUnderstandResult
  },
  run: runUnderstand
})

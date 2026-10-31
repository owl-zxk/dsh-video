
// 集成测试：video_understand 的七步管线（fake 模型 + fake 附件 + **真 ffmpeg**）
//
// 为什么这里要真 ffmpeg：管线里最容易错位的是「帧时间戳 ↔ 场景区间 ↔ 模型看到的时间」这条链，
// 用假 ffmpeg 断不出来。模型与附件层则必须假：真网络在沙箱里既不可用也不该用，
// 而且只有 fake 才能精确制造「模型反复要同一段」「模型全挂」「模型要 blur」这些边界。
//
// 为什么素材是 e2e- 前缀：test-assets/ 是多组共用的目录，撞名会让别人的用例莫名其妙变红
// （契约 §17 记过一次事故）。素材由本文件按需现生成，不下载任何东西（契约 §16）。
//
// 断言一律打不变量（调用次数 / 顺序 / 区间 / accepted / frames），不打文案 —— 契约 §16 最后一条。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { run } from '../lib/media/ffmpeg.js'
import { TIMING_KEYS } from '../lib/util/perf.js'
import { resolveBinaries } from '../lib/util/paths.js'
import { understandCapability, runUnderstand } from '../lib/capabilities/understand.js'
import { capabilities } from '../lib/capabilities/index.js'
import { createRegistry, defineCapability } from '../lib/capabilities/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BINS = resolveBinaries()
const FF = BINS.ffmpeg
const SKIP = FF && fs.existsSync(FF) ? false : '缺 ffmpeg（' + String(FF) + '）'

/** 测试素材：12s / 320x180 / 25fps / 无音轨，三段硬切。12s 才能让 deep 档抽出 >10 帧（两批）。 */
const ASSET = path.join(ROOT, 'test-assets', 'e2e-understand12s.mp4')
const ASSET_MIN_BYTES = 20000

const sizeOf = (file) => { try { return fs.statSync(file).size } catch { return 0 } }

let assetPromise = null
/** 素材不存在/太小就现生成（用最小字节数当健康检查：半截文件不算「已经存在」）。 */
function ensureAsset () {
  if (assetPromise !== null) return assetPromise
  assetPromise = (async () => {
    if (sizeOf(ASSET) >= ASSET_MIN_BYTES) return ASSET
    fs.mkdirSync(path.dirname(ASSET), { recursive: true })
    const r = await run(FF, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'smptehdbars=size=320x180:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'color=c=0x204060:size=320x180:rate=25:duration=4',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      ASSET
    ], { timeoutMs: 180000 })
    if (!r.ok || sizeOf(ASSET) < ASSET_MIN_BYTES) {
      throw new Error('生成 e2e 素材失败：' + String(r.stderr ?? r.error ?? '').slice(-400))
    }
    return ASSET
  })()
  return assetPromise
}

/** 看起来像 base64 的假图片数据：只为证明「原始 base64 不许进 messages」。 */
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+bypBAAAAAElFTkSuQmCC'

/** §2.6 的 17 个键（顺序也要对：emptyResult 的定义顺序就是契约里的顺序）。 */
const RESULT_KEYS = [
  'source', 'durationMs', 'width', 'height', 'fps', 'hasAudio', 'model', 'framesAnalyzed',
  'reframes', 'scenes', 'transcript', 'summary', 'answer', 'failures', 'timings',
  'concurrency', 'estimatedCostUsd'
]

/** fake 附件层：把 wire 形状换成带 attachment 的块，并给出归一化后的尺寸（契约 §19.4）。 */
function makeAttachments ({ width = 1708, height = 961 } = {}) {
  const state = { admitCalls: 0 }
  let next = 0
  return {
    state,
    store: {
      async admitPromptContent (content) {
        state.admitCalls += 1
        return content.map(part => {
          if (part.type !== 'image') return { type: 'text', text: part.text }
          next += 1
          return { type: 'image', attachment: { attachmentId: 'sha256:e2e' + next, mediaType: part.mediaType, bytes: 4096, width, height } }
        })
      }
    }
  }
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

function textChunks (text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]
}

/**
 * fake 模型。
 * produce({ index, images, hasImages, state }) 返回**要回的那段文本**（或者 throw 来模拟网关失败）。
 * state 记录：总调用数、每次带的图片数、在飞峰值（用来证明并发真的走通了、且没超限）。
 */
/** '帧 2 · 00:04.0' 这类帧标签 → 毫秒。用来证明 reframe 轮送的是窗口内的新帧。 */
function labelToMs (text) {
  const found = /(\d\d):(\d\d\.\d)/.exec(String(text))
  if (found === null) return NaN
  return Number(found[1]) * 60000 + Math.round(Number(found[2]) * 1000)
}

function makeLlm ({ produce, modalities = ['text', 'image'], delayMs = 0 } = {}) {
  const state = { streamCalls: 0, inFlight: 0, peak: 0, images: [], labels: [], batchCalls: 0, mergeCalls: 0 }
  const llm = {
    async resolveModelInfo (provider, model) {
      return { provider, id: model, inputModalities: [...modalities] }
    },
    stream (options) {
      state.streamCalls += 1
      const content = Array.isArray(options.messages) && options.messages[0] ? options.messages[0].content : []
      const images = Array.isArray(content) ? content.filter(part => part.type === 'image').length : 0
      const hasImages = images > 0
      if (hasImages) state.batchCalls += 1
      else state.mergeCalls += 1
      state.images.push(images)
      // 每张图前面紧挨着一行「帧 N · 时间」（§2.2）：把它抽出来，就能断言这一轮送的是哪几帧
      state.labels.push(Array.isArray(content)
        ? content.filter(part => part.type === 'text' && /^帧 \d+ · /.test(part.text)).map(part => labelToMs(part.text))
        : [])
      state.inFlight += 1
      state.peak = Math.max(state.peak, state.inFlight)
      const index = state.streamCalls
      return (async function * () {
        try {
          const text = await produce({ index, images, hasImages, state, options })
          if (delayMs > 0) await sleep(delayMs)
          for (const chunk of textChunks(text)) yield chunk
        } finally {
          state.inFlight -= 1
        }
      })()
    }
  }
  return { llm, state }
}

function batchReply ({ visual = '画面', startMs = 0, endMs = 1000, needsReframe = [], onScreenText = [], actions = [] } = {}) {
  return JSON.stringify({ startMs, endMs, visual, onScreenText, actions, needsReframe })
}

const MERGE_REPLY = JSON.stringify({ summary: '总结：一个人在说话，画面停在一个牌子上。', answer: '第 1 秒开始说话。' })

/** 默认 fake 转写：真 whisper 在测试里既慢又不确定，转录这条链路的内容由注入替身覆盖。 */
function fakeTranscribe (segments = [{ startMs: 0, endMs: 800, text: '大家好' }]) {
  return async () => ({
    segments,
    failures: [],
    detected: { hasAudio: true, lang: 'zh', speechMs: 800, chunkCount: 1, t2s: { converted: 0 } }
  })
}

/** 数 ffmpeg 调用的 runImpl（契约 §5 唯一接缝；不许去 mock child_process）。 */
function countingRun () {
  const seen = []
  return {
    calls: seen,
    async runImpl (bin, args, opts) {
      seen.push([...args])
      return run(bin, args, opts)
    }
  }
}

/** 跑一次能力。args 之外的一切都可注入，方便逐条卡边界。 */
async function call (args, { llmBundle, attachments, transcribe, extra = {} } = {}) {
  const asset = await ensureAsset()
  const bundle = llmBundle ?? makeLlm({ produce: () => MERGE_REPLY })
  const store = attachments ?? makeAttachments()
  return runUnderstand(
    { path: asset, ...args },
    {
      llm: bundle.llm,
      attachments: store.store,
      config: {},
      transcribe: transcribe ?? fakeTranscribe(),
      sleep: async () => {},
      ...extra
    }
  )
}

test('完整结构：17 个键齐全且类型正确，scenes 非空，timings 8 键齐', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({ produce: () => batchReply({ visual: '两个人站在牌子前' }) })
  const out = await call({ detail: 'standard', maxFrames: 3 }, { llmBundle: { llm, state } })
  assert.equal(state.mergeCalls, 1, '汇总这一步真的跑过一次')

  assert.deepEqual(Object.keys(out), RESULT_KEYS, '17 个键，一个不多一个不少，顺序照契约')
  assert.equal(typeof out.source, 'string')
  assert.match(out.source, /^e2e-understand12s\.mp4$/, 'source 是文件名')
  for (const key of ['durationMs', 'width', 'height', 'fps', 'framesAnalyzed', 'concurrency']) {
    assert.equal(typeof out[key], 'number', key + ' 必须是数字')
    assert.ok(Number.isFinite(out[key]), key + ' 不能是 NaN')
  }
  assert.equal(out.hasAudio, false, '这个素材本来就没有音轨')
  assert.equal(out.model, 'deepseek-account/deepseek-flash')
  for (const key of ['reframes', 'scenes', 'transcript', 'failures']) assert.ok(Array.isArray(out[key]), key + ' 必须是数组')
  assert.equal(typeof out.summary, 'string')
  assert.equal(typeof out.estimatedCostUsd, 'number')
  assert.ok(out.durationMs > 10000 && out.durationMs <= 13000, '时长对得上素材：' + out.durationMs)
  assert.ok(out.framesAnalyzed >= 1 && out.framesAnalyzed <= 3, 'framesAnalyzed 受 maxFrames 约束：' + out.framesAnalyzed)
  assert.ok(out.scenes.length >= 1, 'scenes 必须非空')
  assert.equal(out.transcript.length, 1, '注入的转写段落要原样出现在 transcript 里')
  assert.equal(out.answer, out.summary, '没给 question 时 answer 等于 summary')
  assert.ok(out.estimatedCostUsd > 0, 'estimatedCostUsd 必须非 0（model 传进 estimateCostUsd 了）')
  assert.deepEqual(Object.keys(out.timings), TIMING_KEYS, 'timings 的 8 个键与顺序')
  for (const key of TIMING_KEYS) assert.ok(Number.isFinite(out.timings[key]) && out.timings[key] >= 0, key)
  // 「做过」一律用**调用计数**证明，不用 timings：perf.js 的 num() 是 Math.round，
  // 假模型一批可能 0ms 就跑完（先跑 llm.test 把 V8 热起来后更容易归 0）—— 那是合法的 0，
  // 拿它当「跑过」的证据就是一个 flaky 断言。毫秒只能证明「量到的是合法时长」。
  assert.ok(state.batchCalls >= 1, '视觉批次真的跑过（按调用计数断言）')
  assert.equal(state.mergeCalls, 1, '汇总真的跑过（按调用计数断言）')
  assert.equal(state.streamCalls, state.batchCalls + state.mergeCalls, '除了批次与汇总之外没有别的模型调用')
  assert.ok(out.timings.framesMs > 0, '真抽过帧：真 ffmpeg 几秒的活，framesMs 不会被 round 成 0')
  assert.ok(out.timings.visionMs >= 0, 'visionMs 是合法毫秒数（假模型可能 0ms 完成）')
  assert.ok(out.timings.mergeMs >= 0, 'mergeMs 是合法毫秒数（假模型可能 0ms 完成）')
  assert.ok(out.timings.wallClockMs >= out.timings.framesMs, 'wallClockMs 不小于任何分段')
  assert.equal(out.failures.length, 0, '这条正常路径不该有失败' + JSON.stringify(out.failures))
})

test('reframe 生效：accepted、frames>0、visual 比 firstPass 更具体、只送新帧、调用数 = 首轮批数 + 1', { skip: SKIP }, async () => {
  const FIRST_PASS = '首轮：远处墙上有个牌子，看不清写的什么'
  const CLOSEUP = '特写：牌子上写着「欢迎光临」四个大字，右下角还有一行小字「营业中」'
  const { llm, state } = makeLlm({
    produce: ({ images, state: inner }) => {
      if (images === 0) return MERGE_REPLY
      // 第一次视觉调用是首轮批次；之后的视觉调用都是 reframe 窗口
      if (inner.batchCalls === 1) return batchReply({ visual: FIRST_PASS, needsReframe: [{ startMs: 1000, endMs: 2600, reason: '看不清牌子上的小字', kind: 'detail' }] })
      return batchReply({ visual: CLOSEUP })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, question: '牌子上写了什么？' }, { llmBundle: { llm, state } })

  assert.equal(out.reframes.length, 1, '只该有一条 reframe 记录：' + JSON.stringify(out.reframes))
  const [reframe] = out.reframes
  assert.equal(reframe.accepted, true)
  assert.equal(reframe.round, 1)
  assert.equal(reframe.kind, 'detail')
  assert.ok(reframe.frames > 0, '窗口里必须真抽到帧：' + reframe.frames)
  assert.equal(reframe.reason, '看不清牌子上的小字', 'reason 永远是模型给的理由原文')
  assert.equal('rejectReason' in reframe, false, 'accepted=true 时连 rejectReason 键都不许有')
  assert.equal(state.batchCalls, 2, '视觉调用次数 = 首轮批数(1) + reframe 轮(1)')
  assert.equal(state.mergeCalls, 1, '汇总只跑一次')
  // 「只送新帧」按帧时间戳断言，不按张数：reframe 轮的每一帧都必须落在窗口内
  const firstRound = state.labels[0]
  const reframed = state.labels[1]
  assert.ok(reframed.length > 0, 'reframe 轮必须真的送了帧')
  for (const ms of reframed) assert.ok(ms >= 1000 && ms <= 2600, 'reframe 只许送窗口内的新帧：' + ms)
  for (const ms of reframed) assert.equal(firstRound.includes(ms), false, 'reframe 不许重发首轮帧：' + ms)

  const scene = out.scenes[0]
  assert.equal(scene.firstPass, FIRST_PASS, '首轮描述必须保留在 firstPass 里')
  assert.equal(scene.visual, CLOSEUP, 'reframe 描述优先')
  assert.ok(scene.visual.length > scene.firstPass.length, 'reframe 的 visual 应该更具体')
})

test('三重闸门 · maxRounds：到顶就停，不再发新的模型请求，请求记成 round-limit', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({
    produce: ({ images, index }) => {
      if (images === 0) return MERGE_REPLY
      // 每次都换一个新窗口要特写：只有轮数上限能挡住它
      return batchReply({ visual: '第 ' + index + ' 次看到的画面', needsReframe: [{ startMs: 1000 + index * 100, endMs: 1600 + index * 100, reason: '还想更清楚', kind: 'detail' }] })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, maxRounds: 1 }, { llmBundle: { llm, state } })

  assert.equal(state.batchCalls, 2, 'maxRounds=1 => 首轮 1 批 + 1 轮 reframe')
  assert.equal(state.mergeCalls, 1)
  assert.equal(out.reframes.filter(item => item.accepted).length, 1)
  const refused = out.reframes.filter(item => item.accepted === false)
  assert.equal(refused.length, 1, '轮数用完的请求也要记下来：' + JSON.stringify(out.reframes))
  assert.equal(refused[0].rejectReason, 'round-limit', '拒绝码只放 rejectReason')
  assert.equal(refused[0].reason, '还想更清楚', '被拒条目的 reason 仍是模型原文')
  assert.equal(refused[0].frames, 0)
})

test('三重闸门 · maxExtraFrames：累计用完就停，被拒的请求记成 frame-budget', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({
    produce: ({ images, index }) => {
      if (images === 0) return MERGE_REPLY
      return batchReply({ visual: '第 ' + index + ' 次的画面', needsReframe: [{ startMs: 1000 + index * 100, endMs: 1600 + index * 100, reason: '要特写', kind: 'detail' }] })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, maxRounds: 3, maxExtraFrames: 1 }, { llmBundle: { llm, state } })

  const accepted = out.reframes.filter(item => item.accepted === true)
  const refused = out.reframes.filter(item => item.accepted === false)
  assert.equal(accepted.length, 1, '只放进去一轮：' + JSON.stringify(out.reframes))
  assert.ok(accepted[0].frames >= 1)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].rejectReason, 'frame-budget')
  assert.equal(refused[0].reason, '要特写', '被拒条目的 reason 仍是模型原文')
  assert.equal(state.batchCalls, 2, '帧预算用完后不许再发模型请求')
})

test('三重闸门 · maxCostUsd：超了就停，被拒的请求记成 cost-budget', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({
    produce: ({ images }) => {
      if (images === 0) return MERGE_REPLY
      return batchReply({ visual: '画面', needsReframe: [{ startMs: 1000, endMs: 1600, reason: '要特写', kind: 'detail' }] })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, maxRounds: 2, maxCostUsd: 1e-9 }, { llmBundle: { llm, state } })

  assert.equal(state.batchCalls, 1, '成本一超就不许再发模型请求')
  assert.equal(state.mergeCalls, 1, 'merge 是文字调用，还是照常做的')
  const refused = out.reframes.filter(item => item.accepted === false)
  assert.equal(refused.length, 1, JSON.stringify(out.reframes))
  assert.equal(refused[0].rejectReason, 'cost-budget')
  assert.equal(refused[0].reason, '要特写', '被拒条目的 reason 仍是模型原文')
  assert.ok(out.estimatedCostUsd > 0)
})

test('签名去重：同一窗口第二次被拒（duplicate），额外帧数不增加', { skip: SKIP }, async () => {
  const WINDOW = { startMs: 1000, endMs: 2600, reason: '看不清小字', kind: 'text' }
  const { llm, state } = makeLlm({
    produce: ({ images, index }) => {
      if (images === 0) return MERGE_REPLY
      // 每一轮都要**同一个窗口**：只有签名去重能挡住它
      return batchReply({ visual: '第 ' + index + ' 次看到的画面', needsReframe: [WINDOW] })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, maxRounds: 2 }, { llmBundle: { llm, state } })

  assert.equal(state.batchCalls, 2, '第二轮被去重挡住：首轮 1 批 + 1 轮 reframe')
  const accepted = out.reframes.filter(item => item.accepted === true)
  const refused = out.reframes.filter(item => item.accepted === false)
  assert.equal(accepted.length, 1, JSON.stringify(out.reframes))
  assert.equal(refused.length, 1)
  assert.equal(refused[0].rejectReason, 'duplicate')
  assert.equal(refused[0].reason, '看不清小字', '被拒条目的 reason 仍是模型原文')
  assert.equal(refused[0].frames, 0, '被拒的请求一帧都不许抽')
  const extra = accepted.reduce((sum, item) => sum + item.frames, 0)
  assert.ok(extra >= 1 && extra <= state.images[1], '额外帧数只等于真正抽到并送出去的帧：' + extra)
})

test('blur 不重抽：kind=blur 被拒且一次窗口抽帧都没发生', { skip: SKIP }, async () => {
  const counter = countingRun()
  const { llm, state } = makeLlm({
    produce: ({ images }) => {
      if (images === 0) return MERGE_REPLY
      return batchReply({ visual: '画面整体是糊的', needsReframe: [{ startMs: 1000, endMs: 2600, reason: '本来就失焦', kind: 'blur' }] })
    }
  })
  const out = await call({ detail: 'standard', maxFrames: 3, maxRounds: 2 }, { llmBundle: { llm, state }, extra: { runImpl: counter.runImpl } })

  assert.equal(out.reframes.length, 1)
  assert.equal(out.reframes[0].accepted, false)
  assert.equal(out.reframes[0].rejectReason, 'kind-blur')
  assert.equal(out.reframes[0].reason, '本来就失焦', '被拒条目的 reason 仍是模型原文')
  assert.equal(out.reframes[0].frames, 0)
  assert.equal(state.batchCalls, 1, 'blur 不许触发任何新的模型调用')
  // extractWindow 是唯一带 -to 的 ffmpeg 调用：一次都不该出现（断言「没抽帧」而不是「看着没抽」）
  const windowCalls = counter.calls.filter(args => args.includes('-to'))
  assert.deepEqual(windowCalls, [], 'blur 请求不许启动窗口抽帧：' + JSON.stringify(windowCalls))
})

test('maxRounds: 0 完全关闭重采样：reframes 为空数组，调用数等于首轮批数', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({
    produce: ({ images }) => {
      if (images === 0) return MERGE_REPLY
      return batchReply({ visual: '画面', needsReframe: [{ startMs: 1000, endMs: 2600, reason: '要特写', kind: 'detail' }] })
    }
  })
  const on = await call({ detail: 'standard', maxFrames: 3, maxRounds: 0 }, { llmBundle: { llm, state } })
  assert.deepEqual(on.reframes, [], 'maxRounds=0 时 reframes 必须是空数组')
  assert.equal(state.batchCalls, 1, '调用次数等于首轮批数（1 批）')
  assert.equal(state.mergeCalls, 1)

  // adaptive:false 是同一个开关的另一种写法（§2.5.5）
  const offBundle = makeLlm({
    produce: ({ images }) => (images === 0 ? MERGE_REPLY : batchReply({ visual: '画面', needsReframe: [{ startMs: 1000, endMs: 2600, reason: '要特写', kind: 'detail' }] }))
  })
  const off = await call({ detail: 'standard', maxFrames: 3, adaptive: false }, { llmBundle: offBundle })
  assert.deepEqual(off.reframes, [])
  assert.equal(offBundle.state.batchCalls, 1)
})

test('超时不静默降级：返回部分结果、failures 写明超时、帧数没有被动减少、timings 未跑的段记 0', { skip: SKIP }, async () => {
  const normalBundle = makeLlm({ produce: () => batchReply({ visual: '画面' }) })
  const normal = await call({ detail: 'standard', maxFrames: 3, maxWallClockMs: 60000 }, { llmBundle: normalBundle })

  const timedBundle = makeLlm({ produce: () => batchReply({ visual: '画面' }) })
  const timed = await call({ detail: 'standard', maxFrames: 3, maxWallClockMs: 1 }, { llmBundle: timedBundle })

  assert.equal(timedBundle.state.streamCalls, 0, '墙钟已超，一个模型请求都不该再发')
  const timeoutFailures = timed.failures.filter(item => item.stage === 'timeout')
  assert.equal(timeoutFailures.length, 1, '必须有一条明确写着因超时截断：' + JSON.stringify(timed.failures))
  assert.equal(timeoutFailures[0].reason, 'wall-clock-exceeded')
  assert.match(timeoutFailures[0].detail, /未执行/)
  assert.equal(timed.framesAnalyzed, normal.framesAnalyzed, '超时不许减少帧数')
  assert.ok(timed.framesAnalyzed >= 1)
  assert.deepEqual(timed.scenes, [], '视觉批次被截断，scenes 只能是空数组')
  // 「没跑」同样用计数器证明：timings 里是 0 也可能只是毫秒被 round 掉了，证明不了阶段没执行
  assert.equal(timedBundle.state.batchCalls, 0, '视觉批次一次都没跑（按调用计数断言）')
  assert.equal(timedBundle.state.mergeCalls, 0, '汇总一次都没跑（按调用计数断言）')
  // 这一条 timings 断言可以留：reframe 段**从未 start**，timings() 对没进过 done 表的键直接给 0，
  // 与墙钟无关，不会像「跑过但 0ms」那样被 round 掉。它证明的是 perf 契约（没跑的段记 0）。
  assert.equal(timed.timings.reframeMs, 0, '没 start 过的段记 0（来自 done 表，不是墙钟）')
  assert.ok(timed.timings.framesMs > 0, '跑过的段要如实记（真 ffmpeg，不会被 round 成 0）')
  assert.deepEqual(Object.keys(timed.timings), TIMING_KEYS)
  assert.deepEqual(Object.keys(timed), RESULT_KEYS, '超时路径的键也一个不少')
})

test('降级：模型全失败时仍返回结构完整的结果，failures 非空且不抛', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({ produce: () => { throw new Error('网关 429：请求太多') } })
  const out = await call({ detail: 'standard', maxFrames: 3 }, { llmBundle: { llm, state } })

  assert.deepEqual(Object.keys(out), RESULT_KEYS)
  assert.deepEqual(out.scenes, [])
  assert.ok(out.failures.length >= 2, '批次失败 + 汇总失败都要记：' + JSON.stringify(out.failures))
  const batchFailure = out.failures.find(item => item.stage === 'batch')
  assert.ok(batchFailure !== undefined, '批次失败要带 batch 号：' + JSON.stringify(out.failures))
  assert.equal(typeof batchFailure.batch, 'number')
  assert.equal(state.batchCalls, 3, '视觉得到的是 1 批 × 3 次尝试（契约 §11 的重试）')
  assert.equal(out.answer, out.summary)
  for (const item of out.failures) assert.equal(typeof item.reason, 'string')
})

test('并发：批次真并发且峰值不超过 concurrency；scenes 区间升序、不重叠不断裂', { skip: SKIP }, async () => {
  const { llm, state } = makeLlm({
    delayMs: 20,
    produce: ({ index }) => batchReply({ visual: '第 ' + index + ' 批画面' })
  })
  // deep 档 batchSize=10：12 帧正好两批，才看得出并发
  const out = await call({ detail: 'deep', maxFrames: 12, concurrency: 2 }, { llmBundle: { llm, state } })

  assert.ok(out.framesAnalyzed > 10, '12 帧才会切成两批：' + out.framesAnalyzed)
  assert.equal(out.concurrency, 2)
  assert.equal(state.batchCalls, 2, '两批各一次调用')
  assert.equal(state.peak, 2, '必须真并发，且不许超过 concurrency：peak=' + state.peak)
  assert.equal(out.scenes.length, 2)
  assert.equal(out.scenes[0].startMs, 0, '首段必须从 0 开始')
  assert.equal(out.scenes.at(-1).endMs, out.durationMs, '末段必须到 durationMs 结束')
  for (let i = 1; i < out.scenes.length; i += 1) {
    assert.equal(out.scenes[i].startMs, out.scenes[i - 1].endMs, '区间必须首尾相接（不重叠、不断裂）')
    assert.ok(out.scenes[i].startMs > out.scenes[i - 1].startMs, 'startMs 必须升序')
  }
  for (const scene of out.scenes) {
    assert.ok(scene.endMs > scene.startMs)
    assert.ok(Array.isArray(scene.frames) && scene.frames.length > 0, '每段都要带帧号')
  }
})

test('maxFrames 非法（0 / 非数字）：入口夹到 >= 1，不崩也不冒泡', { skip: SKIP }, async () => {
  for (const maxFrames of [0, -5, 'abc', null]) {
    const { llm, state } = makeLlm({ produce: () => batchReply({ visual: '画面' }) })
    const out = await call({ detail: 'standard', maxFrames }, { llmBundle: { llm, state } })
    assert.ok(out.framesAnalyzed >= 1, 'maxFrames=' + String(maxFrames) + ' 必须夹到 >= 1，实际 ' + out.framesAnalyzed)
    assert.ok(out.scenes.length >= 1)
    assert.equal(out.failures.filter(item => item.stage === 'unexpected').length, 0, '不许冒泡异常')
  }
})

test('降级：路径不存在时也返回结构完整的结果（ffprobe 失败不外抛）', { skip: SKIP }, async () => {
  const { llm } = makeLlm({ produce: () => batchReply({ visual: '画面' }) })
  const out = await runUnderstand(
    { path: path.join(ROOT, 'test-assets', 'e2e-does-not-exist.mp4'), detail: 'quick' },
    { llm: llm, attachments: makeAttachments().store, config: {}, sleep: async () => {} }
  )
  assert.deepEqual(Object.keys(out), RESULT_KEYS, '失败路径的 17 个键也一个不少')
  assert.deepEqual(out.scenes, [])
  assert.deepEqual(out.reframes, [])
  assert.ok(out.failures.length >= 1, '必须记一条失败')
  assert.equal(out.failures[0].stage, 'probe')
  assert.equal(typeof out.failures[0].reason, 'string')
  assert.equal(out.durationMs, 0)
  assert.deepEqual(Object.keys(out.timings), TIMING_KEYS, '没跑到的段记 0，但键要在')
  assert.equal(out.timings.framesMs, 0)
  assert.equal(out.estimatedCostUsd, 0)
})

test('无音轨素材走真 transcribe：transcript 是空数组、failures 记 no-audio-track，不抛', { skip: SKIP }, async () => {
  const { llm } = makeLlm({ produce: () => batchReply({ visual: '画面' }) })
  const asset = await ensureAsset()
  const out = await runUnderstand(
    { path: asset, detail: 'quick', maxFrames: 2 },
    { llm: llm, attachments: makeAttachments().store, config: {}, sleep: async () => {} }
  )
  assert.deepEqual(Object.keys(out), RESULT_KEYS)
  assert.equal(out.hasAudio, false)
  assert.deepEqual(out.transcript, [])
  assert.ok(
    out.failures.some(item => item.stage === 'audio' && item.reason === 'no-audio-track'),
    '无音轨要如实记一条：' + JSON.stringify(out.failures)
  )
  // quick 档默认 maxRounds 0（§2.5.5），关掉时不许有任何重采样记录
  assert.deepEqual(out.reframes, [])
})

test('能力定义可注册：id / tool.name / 参数 / 输出 schema 都在，且是冻结的', { skip: SKIP }, async () => {
  assert.equal(understandCapability.id, 'video_understand')
  assert.equal(understandCapability.tool.name, 'video_understand')
  assert.equal(understandCapability.tool.parameters.path.required, true, 'path 是属性级必填（契约 §19.1）')
  assert.deepEqual(Object.keys(understandCapability.tool.outputSchema.properties), RESULT_KEYS)
  assert.equal(typeof understandCapability.tool.renderResult, 'function')
  assert.equal(Object.isFrozen(understandCapability), true)
  const rendered = understandCapability.tool.renderResult({}, {
    source: 'a.mp4', durationMs: 12000, framesAnalyzed: 2, model: 'deepseek/x', scenes: [], transcript: [], reframes: [], failures: []
  })
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
})

test('注册表：register 到 list/capabilities，id 或 tool.name 重复一律抛（不许静默覆盖）', () => {
  const registry = createRegistry()
  registry.register(understandCapability)
  assert.equal(registry.size, 1)
  assert.equal(registry.get('video_understand'), understandCapability)
  assert.deepEqual(registry.list(), [understandCapability])
  assert.deepEqual(registry.capabilities(), [understandCapability])
  assert.equal(registry.get('nope'), null)
  assert.deepEqual(capabilities, [understandCapability], 'capabilities/index.js 导出的是同一批能力')

  // 原始定义（未经 defineCapability）也能注册，形状会被校验
  const extra = registry.register({ id: 'video_edit', tool: { ...understandCapability.tool, name: 'video_edit' }, run: async () => ({}) })
  assert.equal(registry.size, 2)
  assert.equal(Object.isFrozen(extra), true)

  assert.throws(() => registry.register({ id: 'video_understand', tool: { ...understandCapability.tool, name: 'video_other' }, run: async () => ({}) }),
    error => error.code === 'CAPABILITY_DUPLICATE_ID')
  assert.throws(() => registry.register({ id: 'video_other', tool: { ...understandCapability.tool, name: 'video_understand' }, run: async () => ({}) }),
    error => error.code === 'CAPABILITY_DUPLICATE_TOOL')
  assert.throws(() => defineCapability({ id: 'Bad-Id', tool: understandCapability.tool, run: async () => ({}) }),
    error => error.code === 'CAPABILITY_INVALID_ID')
  assert.throws(() => defineCapability({ id: 'video_x', tool: { name: 'video_x', description: 'x', parameters: {} }, run: async () => ({}) }),
    error => error.code === 'CAPABILITY_INVALID_OUTPUT', 'defineTool 的 output 是必填项，注册期就该挡')
  assert.throws(() => defineCapability({ id: 'video_y', tool: understandCapability.tool }), error => error.code === 'CAPABILITY_INVALID_RUN')
})

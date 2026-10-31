
// 测试：媒体地基（paths / perf / ffmpeg / probe / frames / reframe）
//
// 为什么测试自己确保素材存在：test-assets/ 不进 git（D 组的 .gitignore），CI 上就是空的。
// 用例必须"跑一次就自动就绪"，不该要求先手工敲 node scripts/make-fixture.mjs。
// ensureFixtures 会跳过已有的（按最小字节数当健康检查），所以第一次之后没有额外开销。
//
// 为什么真 ffmpeg 用例在文件顶部一次性判定存在性：契约 §16 要求缺二进制就 skip，
// 而不是几十个用例各判一次；素材本身不重要，能在它上面验证的不变量才是重点。
//
// 断言一律打不变量（长度/单调/区间/调用次数），不打具体文案 —— 契约 §16 最后一条。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DSH_HOME, DEFAULT_BINARIES, DEFAULT_MODELS, resolveBinaries, requireBinaries,
  whisperModelPath, existingModel, tmpWorkspace, splitRoute,
} from '../lib/util/paths.js'
import { TIMING_KEYS, TimeoutError, createTimers, deadline } from '../lib/util/perf.js'
import { run, ffmpeg, ffprobeJSON } from '../lib/media/ffmpeg.js'
import { parseProbe, probe } from '../lib/media/probe.js'
import {
  detectScenes, planFrames, extractFrame, extractFrames, parseShowinfoPts, jpegQscale,
} from '../lib/media/frames.js'
import { REFRAME_LIMITS, validateWindow, windowSignature, extractWindow } from '../lib/media/reframe.js'
import { ensureFixtures, FIXTURE_DIR } from '../scripts/make-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// 契约 §0 的实测路径；缺了就跳过真解码用例（不是让 CI 红）
const FFMPEG_EXE = 'D:\\DSH\\dsh-home\\bili-whale\\bin\\ffmpeg.exe'
const HAS_FFMPEG = fs.existsSync(FFMPEG_EXE)
const SKIP_REAL = HAS_FFMPEG ? false : '缺 ffmpeg（' + FFMPEG_EXE + '）'
const BINS = resolveBinaries()
const FF = BINS.ffmpeg || FFMPEG_EXE

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const sizeOf = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const isJpeg = (f) => {
  try {
    const b = fs.readFileSync(f).subarray(0, 2)
    return b[0] === 0xff && b[1] === 0xd8
  } catch { return false }
}

let fixturesPromise = null
/** 合成素材（第一次调用时生成，之后复用）。 */
function fixtures() {
  if (!fixturesPromise) fixturesPromise = ensureFixtures({ ffmpeg: FF, dir: FIXTURE_DIR })
  return fixturesPromise
}

/** 数子进程调用次数的 runImpl —— 契约 §5 唯一的接缝，不许去 mock child_process。 */
function counting() {
  const c = { n: 0, calls: [] }
  c.runImpl = async (bin, args, opts) => {
    c.n++
    c.calls.push(Array.isArray(args) ? args.map(String) : [])
    return run(bin, args, opts)
  }
  return c
}

// ─────────────────────────── paths ───────────────────────────
// 2026-10-31 实测改正：本机 provider 是 deepseek-account、模型 id 是 deepseek-flash。
// 原来的 'deepseek/deepseek-v4.1-flash' 会 NO_ADAPTER（那个 provider 不存在）。
test('paths: DEFAULT_MODELS 三档都是 deepseek-account/deepseek-flash', () => {
  for (const detail of ['quick', 'standard', 'deep']) {
    assert.equal(DEFAULT_MODELS[detail], 'deepseek-account/deepseek-flash')
    assert.deepEqual(splitRoute(DEFAULT_MODELS[detail]), { provider: 'deepseek-account', model: 'deepseek-flash' })
  }
  assert.match(DSH_HOME, /dsh-home|\.dsh/i)
  assert.ok(DEFAULT_BINARIES.ffmpeg && DEFAULT_BINARIES.ffprobe && DEFAULT_BINARIES.whisperDir)
})

test('paths: splitRoute 拆分与缺省 provider', () => {
  assert.deepEqual(splitRoute('minimax/minimax-m3'), { provider: 'minimax', model: 'minimax-m3' })
  // 只按第一个斜杠拆：模型名自己可能带冒号变体
  assert.deepEqual(splitRoute('deepseek/deepseek-v4.1-flash:batch'), { provider: 'deepseek', model: 'deepseek-v4.1-flash:batch' })
  assert.deepEqual(splitRoute('deepseek-v4.1-flash'), { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(splitRoute('x/y', { provider: 'minimax' }), { provider: 'x', model: 'y' })
  assert.deepEqual(splitRoute('', { provider: 'minimax' }), { provider: 'minimax', model: '' })
})

test('paths: whisperModelPath 容忍前缀后缀，existingModel 按 prefer 与 small>base 退让', () => {
  const dir = tmp('dsh-paths-model-')
  assert.equal(whisperModelPath(dir, 'base'), path.join(dir, 'ggml-base.bin'))
  assert.equal(whisperModelPath(dir, 'ggml-base.bin'), path.join(dir, 'ggml-base.bin'))
  assert.equal(existingModel(dir), null) // 空目录不许编个假名字回去
  fs.writeFileSync(whisperModelPath(dir, 'base'), 'x')
  assert.equal(existingModel(dir), 'base')
  fs.writeFileSync(whisperModelPath(dir, 'small'), 'x')
  assert.equal(existingModel(dir), 'small')          // 默认 small 优先
  assert.equal(existingModel(dir, 'base'), 'base')   // prefer 优先
  assert.equal(existingModel(dir, 'medium'), 'small') // prefer 不存在 → 退回 small
})

test('paths: resolveBinaries 优先级 config > 环境变量 > 默认 > PATH', () => {
  const dir = tmp('dsh-paths-bin-')
  const mk = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, ''); return f }
  const cfgBin = mk('cfg-ffmpeg')
  const envBin = mk('env-ffmpeg')
  const keepEnv = { DSH_VIDEO_FFMPEG: process.env.DSH_VIDEO_FFMPEG, FFMPEG: process.env.FFMPEG }
  try {
    process.env.DSH_VIDEO_FFMPEG = envBin
    delete process.env.FFMPEG
    assert.equal(resolveBinaries({ ffmpeg: cfgBin }).ffmpeg, cfgBin)  // ① config
    assert.equal(resolveBinaries().ffmpeg, envBin)                    // ② 环境变量
    // 显式给了但不存在 → 往下一档退，不要死在一个笔误上
    assert.equal(resolveBinaries({ ffmpeg: path.join(dir, 'nope.exe') }).ffmpeg, envBin)
    delete process.env.DSH_VIDEO_FFMPEG
    if (fs.existsSync(DEFAULT_BINARIES.ffmpeg)) {
      assert.equal(resolveBinaries().ffmpeg, DEFAULT_BINARIES.ffmpeg) // ③ $DSH_HOME 默认
    }
  } finally {
    for (const [k, v] of Object.entries(keepEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('paths: requireBinaries 齐全时原样返回（本机）', () => {
  if (!HAS_FFMPEG) return
  const bins = requireBinaries()
  assert.equal(bins.ffmpeg, BINS.ffmpeg)
  assert.ok(fs.existsSync(bins.ffmpeg))
  assert.ok(fs.existsSync(bins.ffprobe))
})

test('paths: requireBinaries 一个都找不到时抛 BINARY_MISSING', async () => {
  // 本机的 $DSH_HOME 默认路径下 ffmpeg 是存在的 —— 只要它存在，requireBinaries 就永远走不到抛错那条路。
  // 所以要造一个"什么都没有"的环境：把 DSH_HOME 指向空目录后重新 import 一次模块实例
  // （ESM 的查询串能拿到新的实例），再掐掉 PATH 与环境变量。
  const keep = {
    DSH_HOME: process.env.DSH_HOME,
    PATH: process.env.PATH,
    DSH_VIDEO_FFMPEG: process.env.DSH_VIDEO_FFMPEG,
    FFMPEG: process.env.FFMPEG,
    DSH_VIDEO_FFPROBE: process.env.DSH_VIDEO_FFPROBE,
    FFPROBE: process.env.FFPROBE,
  }
  try {
    process.env.DSH_HOME = tmp('dsh-empty-home-')
    process.env.PATH = ''
    for (const k of ['DSH_VIDEO_FFMPEG', 'FFMPEG', 'DSH_VIDEO_FFPROBE', 'FFPROBE']) delete process.env[k]
    const fresh = await import('../lib/util/paths.js?empty-home')
    assert.equal(fresh.DEFAULT_BINARIES.ffmpeg.startsWith(process.env.DSH_HOME), true, '新实例的默认值必须跟着 DSH_HOME 走')
    let err = null
    try {
      fresh.requireBinaries()
    } catch (e) { err = e }
    assert.ok(err, '找不到 ffmpeg 时必须抛')
    assert.equal(err.code, 'BINARY_MISSING')
    assert.ok(Array.isArray(err.missing) && err.missing.length >= 1)
    // resolveBinaries 本身永不抛，只把候选交回来（好让报错信息里有东西可指）
    const cands = fresh.resolveBinaries()
    assert.ok(typeof cands.ffmpeg === 'string' && cands.ffmpeg.length > 0)
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('paths: tmpWorkspace 建出真实临时目录', () => {
  const d = tmpWorkspace('dsh-paths-tmp-')
  assert.ok(fs.statSync(d).isDirectory())
  fs.rmSync(d, { recursive: true, force: true })
})

// ─────────────────────────── perf ───────────────────────────
test('perf: timings 恒定 8 键（顺序照契约 §2）、未跑的段为 0', () => {
  const t = createTimers(() => 0)
  const timings = t.timings()
  assert.deepEqual(Object.keys(timings), ['probeMs', 'framesMs', 'audioMs', 'visionMs', 'reframeMs', 'mergeMs', 'totalMs', 'wallClockMs'])
  assert.deepEqual([...TIMING_KEYS], Object.keys(timings))
  for (const k of ['probeMs', 'framesMs', 'audioMs', 'visionMs', 'reframeMs', 'mergeMs']) {
    assert.equal(timings[k], 0, k + ' 没跑就该是 0')
  }
  assert.equal(Object.keys(timings).length, 8)
})

test('perf: span 计时（含 async）、同名累加、wallClockMs ≥ 每个分段', async () => {
  let clock = 1000
  const t = createTimers(() => clock)
  clock += 5
  t.start('probeMs')
  clock += 7
  assert.equal(t.stop('probeMs'), 7)
  clock += 3
  const r = await t.span('visionMs', async () => { clock += 30; return 'ok' })
  assert.equal(r, 'ok')
  clock += 2
  await t.span('visionMs', () => { clock += 20 }) // 同名再跑一轮 → 累加
  const timings = t.timings()
  assert.equal(timings.probeMs, 7)
  assert.equal(timings.visionMs, 50)
  assert.equal(timings.wallClockMs, clock - 1000)
  assert.equal(timings.totalMs, timings.wallClockMs)
  for (const k of ['probeMs', 'framesMs', 'audioMs', 'visionMs', 'reframeMs', 'mergeMs']) {
    assert.ok(timings[k] <= timings.wallClockMs, k + ' 不该超过墙钟')
  }
})

test('perf: deadline 判定与 TimeoutError.code', () => {
  let clock = 0
  const d = deadline(1000, () => clock)
  assert.equal(d.exceeded(), false)
  assert.equal(d.remainingMs(), 1000)
  clock = 400
  assert.equal(d.elapsedMs(), 400)
  assert.equal(d.remainingMs(), 600)
  d.assert() // 没超时不该抛
  clock = 1000
  assert.equal(d.exceeded(), true)
  assert.equal(d.remainingMs(), 0)
  assert.throws(() => d.assert(), (e) => e instanceof TimeoutError && e.code === 'WALL_CLOCK_EXCEEDED')
  const none = deadline(0, () => 999999) // 非正数 = 不设限
  assert.equal(none.exceeded(), false)
  assert.equal(none.remainingMs(), Infinity)
  none.assert()
})

// ─────────────────────────── ffmpeg.run ───────────────────────────
test('ffmpeg: run 永不 throw —— 可执行文件不存在 / 调用前已中止', async () => {
  const dir = tmp('dsh-ff-run-')
  const r = await run(path.join(dir, 'nope.exe'), ['-version'])
  assert.equal(r.ok, false)
  assert.equal(r.status, null)
  assert.equal(typeof r.stdout, 'string')
  assert.equal(typeof r.stderr, 'string')
  assert.equal(r.code, 'SPAWN_FAILED')

  const ac = new AbortController()
  ac.abort()
  const r2 = await run('no-such-binary-anywhere', ['-version'], { signal: ac.signal })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'ABORTED')

  // 参数不是数组也不许炸（永不 throw 的另一半）
  const r3 = await run('no-such-binary-anywhere', undefined)
  assert.equal(r3.ok, false)
})

test('ffmpeg: 真跑 -version；ffprobeJSON 对垃圾参数返回 null 而不是抛', { skip: SKIP_REAL }, async () => {
  const r = await run(FF, ['-version'])
  assert.equal(r.ok, true)
  assert.equal(r.status, 0)
  assert.match(String(r.stdout), /ffmpeg version/i)

  const bad = await ffprobeJSON(BINS.ffprobe, ['-print_format', 'json', path.join(FIXTURE_DIR, 'nope.mp4')])
  assert.equal(bad, null)
})

test('ffmpeg: 超时被杀 → code=TIMEOUT（不 throw、不挂住）', { skip: SKIP_REAL }, async () => {
  const started = Date.now()
  const r = await run(FF, [
    '-hide_banner', '-loglevel', 'error',
    // -re 让 lavfi 按原生帧率吐帧：不加的话 30s 合成画面在 100ms 内就跑完了（实测），
    // 那样测的就不是超时而是"恰好很快"
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=30',
    '-f', 'null', '-',
  ], { timeoutMs: 300 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TIMEOUT')
  assert.ok(Date.now() - started < 15000, '超时必须真的把进程收掉')
})

// ─────────────────────────── probe ───────────────────────────
const fakeProbe = (over = {}) => ({
  format: { duration: '8.000000', size: '123456', ...(over.format || {}) },
  streams: over.streams || [
    { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '25/1', r_frame_rate: '25/1' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1 },
  ],
})

test('probe: parseProbe 覆盖带音轨 / 无音轨 / 只有封面图 / 分数帧率', () => {
  const meta = parseProbe(fakeProbe())
  assert.deepEqual(meta, {
    durationMs: 8000, width: 640, height: 360, fps: 25, hasAudio: true,
    videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 1, sizeBytes: 123456,
  })

  // 无音轨是正常情况：hasAudio:false，绝不抛
  const silent = parseProbe(fakeProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 180, avg_frame_rate: '10/1' }] }))
  assert.equal(silent.hasAudio, false)
  assert.equal(silent.audioCodec, null)
  assert.equal(silent.sampleRate, 0)
  assert.equal(silent.channels, 0)

  // 'N/A' 之类的脏值不许变成 NaN
  const dirty = parseProbe(fakeProbe({ format: { duration: 'N/A', size: 'N/A' }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 'N/A', height: 'N/A', avg_frame_rate: '30000/1001' },
  ] }))
  assert.equal(dirty.durationMs, 0)
  assert.equal(dirty.width, 0)
  assert.equal(dirty.fps, 29.97)

  // 只有封面图 = 没有视频流（纯音频文件不该被当成视频去抽帧）
  assert.throws(
    () => parseProbe(fakeProbe({ streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }, { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } }] })),
    (e) => e.code === 'NO_VIDEO_STREAM',
  )
  assert.throws(() => parseProbe({ format: {}, streams: [] }), (e) => e.code === 'NO_VIDEO_STREAM')
})

test('probe: 8s/640x360 带音轨素材与无音轨素材', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const meta = await probe(F['media-basic8s.mp4'], { ffprobe: BINS.ffprobe })
  assert.ok(Math.abs(meta.durationMs - 8000) <= 200, 'duration≈8000，实际 ' + meta.durationMs)
  assert.equal(meta.width, 640)
  assert.equal(meta.height, 360)
  assert.equal(meta.hasAudio, true)
  assert.equal(meta.fps, 25)
  assert.ok(meta.sizeBytes > 0)
  assert.equal(meta.videoCodec, 'h264')

  const silent = await probe(F['media-silent8s.mp4'], { ffprobe: BINS.ffprobe }) // 无音轨不许抛
  assert.equal(silent.hasAudio, false)
  assert.equal(silent.audioCodec, null)
  assert.equal(silent.width, 640)

  await assert.rejects(() => probe(path.join(FIXTURE_DIR, 'nope.mp4'), { ffprobe: BINS.ffprobe }), (e) => e.code === 'PROBE_FAILED')
})
// ─────────────────────────── frames（纯函数） ───────────────────────────
test('frames: parseShowinfoPts 从 stderr 里取 pts_time（毫秒）', () => {
  const stderr = [
    '[Parsed_showinfo_1 @ 0000029421f46fc0] n:   1 pts:  12345 pts_time:0.48 duration:1 fmt:yuv420p',
    '[Parsed_showinfo_1 @ 0000029421f46fc0] n:   2 pts:  45678 pts_time:1.2345 duration:1 fmt:yuv420p',
  ].join('\n')
  assert.deepEqual(parseShowinfoPts(stderr), [480, 1235])
  assert.deepEqual(parseShowinfoPts(''), [])
  assert.deepEqual(parseShowinfoPts(null), [])
  assert.deepEqual(parseShowinfoPts('no timestamps here'), [])
})

test('frames: jpegQscale —— quality 越高 qscale 越低（2..31）', () => {
  const q85 = jpegQscale(85)
  assert.ok(q85 >= 2 && q85 <= 31)
  assert.ok(jpegQscale(95) < q85, '更高质量必须给更小的 qscale')
  assert.ok(jpegQscale(50) > q85)
  assert.equal(jpegQscale(100), 2)
  assert.equal(jpegQscale(0), 31)
  assert.ok(Number.isFinite(jpegQscale(NaN)))
})

/** planFrames 的一组不变量，所有场景共用这一份断言。 */
function assertPlanInvariants(plan, durationMs, maxFrames) {
  const label = 'duration=' + durationMs + ' maxFrames=' + maxFrames + ' -> ' + JSON.stringify(plan.map((p) => p.ms))
  assert.ok(Array.isArray(plan), label)
  assert.ok(plan.length <= maxFrames, 'length <= maxFrames：' + label)
  assert.ok(plan.length >= 1, label)
  assert.equal(plan[0].ms, 0, '首帧必须含 0：' + label)
  if (maxFrames >= 2 && durationMs >= 2) {
    assert.equal(plan[plan.length - 1].ms, durationMs - 1, '尾帧必须含 durationMs-1：' + label)
  }
  for (let i = 0; i < plan.length; i++) {
    assert.equal(plan[i].index, i, 'index 由下标决定：' + label)
    assert.ok(Number.isInteger(plan[i].ms), 'ms 是整数毫秒：' + label)
    assert.ok(plan[i].ms >= 0 && plan[i].ms <= durationMs, 'ms ∈ [0, durationMs]：' + label)
    if (i > 0) {
      assert.ok(plan[i].ms > plan[i - 1].ms, 'ms 严格递增：' + label)
      const gap = plan[i].ms - plan[i - 1].ms
      // 契约 §7 的新措辞：0.5s 容差只用于**去重**，不是最小间隔。
      // 短片（durationMs < 1000）首尾天然贴在一起，那是正常的 —— 绝不许为了让间隔"看起来达标"
      // 而插假帧，所以这里对短片直接不设最小间隔断言。
      if (durationMs >= 1000) {
        assert.ok(gap > 500, '去重容差 0.5s（gap=' + gap + '）：' + label)
      }
    }
  }
}

test('frames: planFrames 不变量（矩阵）', () => {
  const cases = [
    [8000, [], 6],
    [8000, [1000, 2000, 3000, 4000, 5000, 6000, 7000], 16],
    [1000, [400], 40],
    [120000, [500, 60000, 119999], 40],
    [300, [0, 100, 200], 6],   // 极短片：首尾贴在一起是允许的
    [0, [], 6],
    [45000, Array.from({ length: 60 }, (_, i) => i * 700), 10],
    [60000, [15000, 15000, 15000], 40],  // 重复场景点
    [8000, [-100, 9000, 4000], 8],       // 越界场景点必须被丢掉
  ]
  for (const [durationMs, sceneTimes, maxFrames] of cases) {
    assertPlanInvariants(planFrames({ durationMs, sceneTimes, maxFrames }), durationMs, maxFrames)
  }
})

test('frames: planFrames 极值 —— maxFrames=1 只给首帧、短片首尾紧贴不插假帧、durationMs=0', () => {
  // 一帧装不下首尾两个，取 0 合理（契约 §7：maxFrames 夹到 >= 1 由调用方负责）
  assert.deepEqual(planFrames({ durationMs: 8000, maxFrames: 1 }), [{ index: 0, ms: 0 }])
  // 400ms 的短片：首尾必须都在，间隔 399ms < 500ms 但**不许**插假帧凑间隔
  assert.deepEqual(planFrames({ durationMs: 400, maxFrames: 6 }), [{ index: 0, ms: 0 }, { index: 1, ms: 399 }])
  // durationMs = 0 → 单帧 [0]
  assert.deepEqual(planFrames({ durationMs: 0, maxFrames: 6 }), [{ index: 0, ms: 0 }])
  // 场景点全部越界/重复也不许影响"首尾必在"
  assert.deepEqual(planFrames({ durationMs: 400, sceneTimes: [-5, 9999, 399, 399], maxFrames: 4 }).map((p) => p.ms), [0, 399])
})

test('frames: planFrames 场景点优先于均匀帧', () => {
  // 均匀网格是 1000/2000/3000…；场景点 1300 与 4400 各自把邻近的均匀帧挤掉
  const plan = planFrames({ durationMs: 8000, sceneTimes: [1300, 4400], maxFrames: 8 })
  const ms = plan.map((p) => p.ms)
  assert.ok(ms.includes(1300), '场景点 1300 必须在：' + JSON.stringify(ms))
  assert.ok(ms.includes(4400), '场景点 4400 必须在：' + JSON.stringify(ms))
  assert.ok(!ms.includes(1000), '被 1300 挤掉的均匀帧不该出现：' + JSON.stringify(ms))
  assert.ok(!ms.includes(4000), '被 4400 挤掉的均匀帧不该出现：' + JSON.stringify(ms))
  assertPlanInvariants(plan, 8000, 8)

  // 纯均匀兜底也必须满足不变量
  const uniform = planFrames({ durationMs: 8000, maxFrames: 6 })
  assertPlanInvariants(uniform, 8000, 6)
  assert.ok(uniform.length >= 2)
})

test('frames: planFrames 截断时先丢尾巴上的场景点（文件头写明的取舍）', () => {
  const scenes = [1000, 3000, 5000, 7000, 9000, 11000, 13000]
  const plan = planFrames({ durationMs: 20000, sceneTimes: scenes, maxFrames: 5 })
  assertPlanInvariants(plan, 20000, 5)
  assert.equal(plan.length, 5)
  const ms = plan.map((p) => p.ms)
  // 首尾 + 前三个场景点把名额吃满；13000 那一段被截掉了，这是已知取舍
  assert.deepEqual(ms, [0, 1000, 3000, 5000, 19999])
  assert.ok(!ms.includes(13000))
  // 除首尾外，留下的点必须全部来自场景点（场景优先）
  for (const t of ms.slice(1, -1)) assert.ok(scenes.includes(t), t + ' 不是场景点')
})

test('frames: planFrames 对非法 maxFrames 抛 TypeError（宁可炸也不要静默少抽帧）', () => {
  for (const bad of [0, -1, NaN, undefined, 'x']) {
    assert.throws(() => planFrames({ durationMs: 8000, maxFrames: bad }), TypeError)
  }
  assert.throws(() => planFrames(), TypeError)
})

test('frames: extractFrames 并发受 concurrency 限流（同时在飞 <= 并发度）', async () => {
  // 这条用例不碰真 ffmpeg：注入一个假 run，让它自己把"输出文件"写出来。
  // 这样断言的是限流器本身（PROMPT §2.7.5 / §4 的"并发限流"行），不是解码行为。
  const dir = tmp('dsh-frames-gate-')
  const plan = planFrames({ durationMs: 6000, maxFrames: 6 })
  assert.ok(plan.length >= 4)
  let inFlight = 0
  let peak = 0
  let calls = 0
  const fakeRun = async (bin, args) => {
    calls++
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 15))
    const out = args[args.length - 1]
    try { fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0])) } catch { /* 目录不存在就当作失败帧 */ }
    inFlight--
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  const progress = []
  const got = await extractFrames('ignored-video.mp4', plan, {
    ffmpeg: 'fake-ffmpeg', dir, concurrency: 2, runImpl: fakeRun,
    onProgress: (p) => progress.push(p),
  })
  assert.equal(calls, plan.length)
  assert.equal(got.length, plan.length)
  assert.ok(peak <= 2, '同时在飞不该超过 concurrency=2，实际峰值 ' + peak)
  assert.ok(peak >= 2, '并发度 2 就该真的并行，峰值只有 ' + peak)
  assert.equal(progress.length, plan.length, '每帧都要回报一次进度')
  assert.equal(progress[progress.length - 1].done, plan.length)
  assert.equal(progress[0].total, plan.length)
})

// ─────────────────────────── frames（真 ffmpeg） ───────────────────────────
test('frames: detectScenes —— 多场景素材 ≥1 个升序毫秒，单一 testsrc2 返回 []', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const scenes = await detectScenes(F['media-scenes9s.mp4'], { ffmpeg: FF })
  assert.ok(Array.isArray(scenes) && scenes.length >= 1, '多场景素材必须有场景点：' + JSON.stringify(scenes))
  for (let i = 0; i < scenes.length; i++) {
    assert.ok(Number.isInteger(scenes[i]))
    if (i > 0) assert.ok(scenes[i] > scenes[i - 1], '必须升序：' + JSON.stringify(scenes))
  }
  assert.ok(scenes.every((t) => t >= 0 && t <= 9000), '毫秒且落在片子内：' + JSON.stringify(scenes))

  // 单一 testsrc2（连续运动、没有硬切）不该被判成场景切换
  const none = await detectScenes(F['media-basic8s.mp4'], { ffmpeg: FF })
  assert.deepEqual(none, [])

  // 失败路径：文件不存在 → [] 而不是抛
  const broken = await detectScenes(path.join(FIXTURE_DIR, 'nope.mp4'), { ffmpeg: FF, timeoutMs: 20000 })
  assert.deepEqual(broken, [])
})

test('frames: detectScenes 只全解码一次（子进程恰好 1 次）', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const c = counting()
  await detectScenes(F['media-scenes9s.mp4'], { ffmpeg: FF, runImpl: c.runImpl })
  assert.equal(c.n, 1, '场景检测必须只跑一遍全解码')
  assert.equal(c.calls.length, 1)
  assert.ok(c.calls[0].some((a) => a.includes('showinfo')), '必须走 showinfo 拿 pts_time')
  assert.ok(c.calls[0].some((a) => a.includes('scene')), '必须走 scene 阈值选择')
})

test('frames: extractFrames <40 走逐帧 seek —— 长度/索引/文件非空', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const video = F['media-basic8s.mp4']
  const meta = await probe(video, { ffprobe: BINS.ffprobe })
  const scenes = await detectScenes(video, { ffmpeg: FF })
  const plan = planFrames({ durationMs: meta.durationMs, sceneTimes: scenes, maxFrames: 16 })
  assert.ok(plan.length < 40, '这条用例要的是 <40 那条分支，plan=' + plan.length)

  const dir = tmp('dsh-frames-seek-')
  const got = await extractFrames(video, plan, { ffmpeg: FF, dir, concurrency: 4 })
  assert.equal(got.length, plan.length, '一帧都不许丢')
  assert.deepEqual(got.map((f) => f.index), plan.map((_, i) => i), 'index 必须是 0..n-1')
  assert.deepEqual(got.map((f) => f.ms), plan.map((p) => p.ms), 'ms 必须与 plan 一致')
  for (const f of got) {
    assert.ok(fs.existsSync(f.file), '文件必须存在：' + f.file)
    assert.ok(f.bytes > 0 && f.bytes <= 2097152, '单帧 ≤ 2 MiB：' + f.bytes)
    assert.ok(isJpeg(f.file), '必须是 JPEG')
    assert.ok(f.file.startsWith(dir), '必须落在调用方给的 dir 里')
  }
  for (let i = 1; i < got.length; i++) assert.ok(got[i].ms > got[i - 1].ms, 'ms 升序')
})

test('frames: 只解码一次 —— 子进程次数 === 帧数 + 1（含场景检测）', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const video = F['media-basic8s.mp4']
  const meta = await probe(video, { ffprobe: BINS.ffprobe })
  const scenes = await detectScenes(video, { ffmpeg: FF })
  const full = planFrames({ durationMs: meta.durationMs, sceneTimes: scenes, maxFrames: 16 })
  // 去掉尾帧（durationMs-1 落在最后一帧之后，会多花一次回退重试；单独用例覆盖）
  const plan = full.filter((p) => p.ms < meta.durationMs - 1)
  assert.ok(plan.length >= 6)

  const sceneRun = counting()
  await detectScenes(video, { ffmpeg: FF, runImpl: sceneRun.runImpl })
  const frameRun = counting()
  const got = await extractFrames(video, plan, { ffmpeg: FF, dir: tmp('dsh-frames-count-'), runImpl: frameRun.runImpl })

  assert.equal(got.length, plan.length)
  assert.equal(sceneRun.n, 1, '场景检测只跑一次')
  assert.equal(frameRun.n, plan.length, '每帧恰好一次 seek（不是每帧 × 遍数）：' + frameRun.n + ' vs ' + plan.length)
  assert.equal(sceneRun.n + frameRun.n, plan.length + 1, '整轮 ≈ 帧数 + 1')
  // 反向证明"没有全量解码"：所有抽帧调用都必须带 -ss 且在 -i 之前
  for (const args of frameRun.calls) {
    const iSs = args.indexOf('-ss')
    const iIn = args.indexOf('-i')
    assert.ok(iSs >= 0, '必须用 -ss 快速定位：' + args.join(' '))
    assert.ok(iSs < iIn, '-ss 必须在 -i 之前：' + args.join(' '))
  }
})

test('frames: extractFrames ≥40 走一次 fps 全量输出（子进程远少于帧数）', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const video = F['media-long45s.mp4']
  const meta = await probe(video, { ffprobe: BINS.ffprobe })
  const scenes = await detectScenes(video, { ffmpeg: FF })
  const plan = planFrames({ durationMs: meta.durationMs, sceneTimes: scenes, maxFrames: 40 })
  assert.ok(plan.length >= 40, '这条用例要的是 ≥40 那条分支，plan=' + plan.length)

  const c = counting()
  const got = await extractFrames(video, plan, { ffmpeg: FF, dir: tmp('dsh-frames-fps-'), runImpl: c.runImpl })
  assert.equal(got.length, plan.length, '一帧都不许丢')
  assert.deepEqual(got.map((f) => f.index), plan.map((_, i) => i))
  for (const f of got) assert.ok(fs.existsSync(f.file) && f.bytes > 0)

  const batchCalls = c.calls.filter((args) => args.some((a) => a.includes('fps=')))
  assert.equal(batchCalls.length, 1, '全量输出必须只跑一次')
  assert.ok(c.n < plan.length / 4, '子进程次数要远少于帧数：' + c.n + ' vs ' + plan.length)
})

test('frames: extractFrame 单帧 —— JPEG、长边 1708、≤2 MiB', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const dir = tmp('dsh-frames-one-')
  const out = path.join(dir, 'one.jpg')
  const one = await extractFrame(F['media-scenes9s.mp4'], 4500, { ffmpeg: FF, outFile: out })
  assert.ok(one && one.bytes > 0)
  assert.equal(one.file, out)
  assert.ok(fs.existsSync(out))
  assert.ok(isJpeg(out))
  assert.equal(one.width, 1708) // 640 宽被 scale=1708:-2 拉到长边 1708
  assert.equal(one.height, 960)
  assert.ok(one.bytes <= 2097152)

  const missing = await extractFrame(F['media-scenes9s.mp4'], 4500, { ffmpeg: FF })
  assert.equal(missing, null, '没有 outFile 就该返回 null 而不是抛')
})
// ─────────────────────────── reframe ───────────────────────────
test('reframe: REFRAME_LIMITS 与契约 §8 一致（特写长边 2730，不是 4096）', () => {
  assert.deepEqual({ ...REFRAME_LIMITS }, {
    minWindowMs: 300, maxWindowMs: 30000, maxReframeWindows: 3,
    closeupLongEdge: 2730, quality: 85, maxBytes: 2097152,
  })
})

test('reframe: validateWindow 六种拒绝理由 + 接受（reason 只许是契约里那六个）', () => {
  const ctx = { durationMs: 9000 }
  assert.deepEqual(validateWindow({ startMs: 3200, endMs: 4800, kind: 'detail' }, ctx), { accepted: true })
  assert.deepEqual(validateWindow({ startMs: 0, endMs: 9000, kind: 'text' }, ctx), { accepted: true })
  assert.deepEqual(validateWindow({ startMs: 1000, endMs: 1300, kind: 'motion' }, ctx), { accepted: true })
  assert.deepEqual(validateWindow({ startMs: 1000, endMs: 4000 }, ctx), { accepted: true }) // kind 缺省 = detail

  const allowed = new Set(['out-of-range', 'too-short', 'too-long', 'kind-blur', 'duplicate', 'unknown-kind'])
  const cases = [
    ['out-of-range', { startMs: 8000, endMs: 9500 }, 9000],      // 越过 durationMs
    ['out-of-range', { startMs: -100, endMs: 1000 }, 9000],
    ['out-of-range', { startMs: 4000, endMs: 4000 }, 9000],      // 空窗口
    ['out-of-range', { startMs: 5000, endMs: 4000 }, 9000],      // 反向
    ['too-short', { startMs: 3200, endMs: 3400 }, 9000],         // 200ms < 300ms
    ['too-long', { startMs: 0, endMs: 31000 }, 60000],           // 31s > 30s
    ['kind-blur', { startMs: 3200, endMs: 4800, kind: 'blur' }, 9000],
    ['unknown-kind', { startMs: 3200, endMs: 4800, kind: 'zoom' }, 9000],
  ]
  for (const [want, req, durationMs] of cases) {
    const r = validateWindow(req, { durationMs })
    assert.equal(r.accepted, false, JSON.stringify(req))
    assert.equal(r.reason, want, JSON.stringify(req))
    assert.ok(allowed.has(r.reason))
  }

  // 越界优先于 blur：越界的请求根本不该进入"要不要重抽"的判断
  assert.equal(validateWindow({ startMs: -5, endMs: 4000, kind: 'blur' }, ctx).reason, 'out-of-range')

  // durationMs 缺失/非法一律拒
  assert.equal(validateWindow({ startMs: 0, endMs: 1000 }, {}).reason, 'out-of-range')
  assert.equal(validateWindow({ startMs: 0, endMs: 1000 }, { durationMs: 0 }).reason, 'out-of-range')

  // seen 命中 → duplicate（窗口签名 = floor(start/1000):floor(end/1000)）
  assert.equal(windowSignature(3200, 4800), '3:4')
  const seen = new Set([windowSignature(3200, 4800)])
  assert.deepEqual(validateWindow({ startMs: 3400, endMs: 4900, kind: 'detail' }, { durationMs: 9000, seen }), { accepted: false, reason: 'duplicate' })

  // limits 可覆盖（预算按档位调的时候用得到）
  const tight = { ...REFRAME_LIMITS, maxWindowMs: 2000 }
  assert.equal(validateWindow({ startMs: 0, endMs: 3000 }, { durationMs: 9000, limits: tight }).reason, 'too-long')
})

test('reframe: validateWindow 是纯函数 —— 不改入参 seen', () => {
  const seen = new Set(['3:4', '0:9'])
  const before = [...seen].sort()
  const ctx = { durationMs: 20000, seen }
  validateWindow({ startMs: 3200, endMs: 4800, kind: 'detail' }, ctx)   // 命中 duplicate
  validateWindow({ startMs: 9000, endMs: 11000, kind: 'text' }, ctx)   // 通过
  validateWindow({ startMs: 9000, endMs: 11000, kind: 'blur' }, ctx)   // 被拒
  assert.deepEqual([...seen].sort(), before, 'seen 被改了')
  assert.equal(seen.size, 2)
})

test('reframe: extractWindow 500ms 短窗口至少 1 帧，ms 落在窗口内', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const dir = tmp('dsh-window-short-')
  const win = { startMs: 3000, endMs: 3500 }
  assert.deepEqual(validateWindow({ ...win, kind: 'detail' }, { durationMs: 9000 }), { accepted: true })
  const frames = await extractWindow(F['media-scenes9s.mp4'], win, { ffmpeg: FF, dir })
  assert.ok(frames.length >= 1, '短窗口不能空手而归：' + JSON.stringify(frames))
  for (const f of frames) {
    assert.ok(f.ms >= win.startMs && f.ms <= win.endMs, 'ms 必须落在窗口内：' + f.ms)
    assert.ok(fs.existsSync(f.file) && f.bytes > 0)
    assert.ok(f.bytes <= 2097152)
  }
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].ms > frames[i - 1].ms, '升序')
})

test('reframe: 一帧都抽不到时退回窗口中间那一帧（步长比窗口还大时必走）', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const dir = tmp('dsh-window-mid-')
  const win = { startMs: 3000, endMs: 3500 }
  const c = counting()
  // stepMs = 5000 > 窗口 500ms → fps 滤镜一个 tick 都到不了，ffmpeg 直接报空输出
  const frames = await extractWindow(F['media-scenes9s.mp4'], win, { ffmpeg: FF, dir, stepMs: 5000, runImpl: c.runImpl })
  assert.equal(frames.length, 1, '必须退回一张中间帧：' + JSON.stringify(frames))
  assert.equal(frames[0].ms, 3250, '中间帧 = (start+end)/2')
  assert.ok(fs.existsSync(frames[0].file) && frames[0].bytes > 0)
  assert.ok(c.n >= 2, '批次失败后必须再起一次 seek（实测 2 次）')
})

test('reframe: 30s 窗口帧数 ≤ 12（图片预算 maxImagesPerMessage=20），升序且在窗口内', { skip: SKIP_REAL }, async () => {
  const F = await fixtures()
  const dir = tmp('dsh-window-long-')
  const win = { startMs: 1000, endMs: 31000 }
  const frames = await extractWindow(F['media-long45s.mp4'], win, { ffmpeg: FF, dir, stepMs: 500 })
  assert.ok(frames.length >= 1)
  assert.ok(frames.length <= 12, '单个窗口最多 12 张：' + frames.length)
  for (const f of frames) assert.ok(f.ms >= win.startMs && f.ms <= win.endMs, 'ms 越界：' + f.ms)
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].ms > frames[i - 1].ms, '升序')
  for (const f of frames) assert.ok(fs.existsSync(f.file) && f.bytes > 0)
  // 全部帧都在 dir 里（批次临时目录必须已经清掉，不能留死路径）
  for (const f of frames) assert.ok(f.file.startsWith(dir), '帧文件必须落在 dir 里：' + f.file)
})
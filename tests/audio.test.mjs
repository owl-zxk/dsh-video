/**
 * lib/media/audio.js 的测试
 *
 * 为什么大部分用例注入 runImpl 而不跑真 whisper：
 *   whisper 是 CPU-bound，1 秒音频约 0.4 秒转录；把"解析 / 偏移 / 分块 / 降级"这些逻辑
 *   全押在真跑上，测试会慢到没人愿意跑，而且真跑的输出（幻觉出来的字）本身不稳定。
 *   所以逻辑用"假 runImpl + 真 JSON 文件"验证，只有一条端到端用例真跑。
 *
 * 为什么真跑用例缺二进制时 skip 而不是 fail：
 *   whisper 模型 141~465 MB，是用户机器上的可选项；缺了应该跳过，不该让整套测试红。
 *
 * 为什么真跑素材最多 5 秒：更长只会把测试时间按比例拖长，验证不出任何新东西。
 *
 * 为什么这里自己写 realRun：
 *   本模块默认的 run 来自 lib/media/ffmpeg.js（并行开发里另一个人的文件，落地时间不确定）。
 *   要验证"真的 spawn 了 ffmpeg / whisper"，测试里就得有一个遵守契约 §5 形状的真实 runner。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { planChunks, extractWav, detectSpeech, transcribeChunk, transcribe } from '../lib/media/audio.js'
import { resolveBinaries } from '../lib/util/paths.js'
import { ensureLoaded, hasTraditional, toSimplified } from '../lib/util/t2s.js'

// 断言素材是**真跑出来的转录**（用户素材 BV1DubxzVEPB 前 20 秒，whisper small，-l zh），
// 不是自己编的句子：编的句子会漏掉实际出现的字（個 / 給 / 貓 / 鎮 / 鐵 / 會 / 兒）。
const REAL_TC_1 = '花四個月時間給貓咪小鎮做的地鐵站和地鐵今天終於通車了'
const REAL_TC_2 = '一會兒不做將帶領他的貓貓們成為首批乘客'
const REAL_SC_1 = '花四个月时间给猫咪小镇做的地铁站和地铁今天终于通车了'
const REAL_SC_2 = '一会儿不做将带领他的猫猫们成为首批乘客'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ASSETS = path.join(ROOT, 'test-assets')
const DUMMY = path.join(ASSETS, 'dummy')
// 只在测试里用的"词表目录"，故意不存在：验证 t2s / transcribe 的 fail-open
const NO_DICT_DIR = path.join(ASSETS, '不存在的词表目录')
// 二进制一律走产品自己的解析（config > 环境变量 > PATH > $DSH_HOME 推导），
// 测试里不再猜任何绝对路径：换台机器只要 ffmpeg/whisper 在 PATH 里，真用例就照跑。
const BIN = resolveBinaries({})
const FFMPEG = process.env.DSH_VIDEO_FFMPEG || process.env.FFMPEG || BIN.ffmpeg || ''
const WHISPER_BIN = process.env.DSH_VIDEO_WHISPER_BIN || BIN.whisperBin || ''
const WHISPER_DIR = process.env.DSH_VIDEO_WHISPER_DIR || BIN.whisperDir || ''
const MODEL = WHISPER_DIR
  ? ['ggml-base.bin', 'ggml-small.bin'].map((n) => path.join(WHISPER_DIR, n)).find((p) => fs.existsSync(p)) ?? null
  : null
const hasFfmpeg = !!FFMPEG && fs.existsSync(FFMPEG)
const hasWhisper = !!WHISPER_BIN && fs.existsSync(WHISPER_BIN) && !!MODEL

// 契约 §5 的 run：绝不 throw，超时/中止走 code
//
// 注意 stdio 用的是**临时文件**而不是管道：本机 DSH 沙箱下子进程管道会直接 spawn EPERM
// （只有 stdio: 'inherit' / 'ignore' / 文件描述符可用）。落盘两边都能跑，语义也一样 ——
// 这只是测试用的 runner；生产路径走 lib/media/ffmpeg.js 的 run。
function realRun(bin, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000
  return new Promise((resolve) => {
    let settled = false
    let child = null
    let dir = null
    let outFd = null
    let errFd = null
    const collect = () => {
      const read = (f) => {
        try {
          return fs.readFileSync(f, 'utf8')
        } catch {
          return ''
        }
      }
      return { stdout: read(path.join(dir, 'o.txt')), stderr: read(path.join(dir, 'e.txt')) }
    }
    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        try {
          if (fd !== null) fs.closeSync(fd)
        } catch {
          // 已关闭
        }
      }
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // 删不掉不影响断言
        }
      }
    }
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
        opts.signal.removeEventListener('abort', onAbort)
      }
      cleanup()
      resolve(r)
    }
    const kill = (code) => {
      try {
        child?.kill()
      } catch {
        // 已经退出了
      }
      setTimeout(() => done({ ok: false, status: null, ...collect(), code }), 50)
    }
    const onAbort = () => kill('ABORTED')
    const timer = setTimeout(() => kill('TIMEOUT'), timeoutMs)
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audio-test-'))
      outFd = fs.openSync(path.join(dir, 'o.txt'), 'w')
      errFd = fs.openSync(path.join(dir, 'e.txt'), 'w')
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] })
    } catch (e) {
      done({ ok: false, status: null, stdout: '', stderr: String(e?.message ?? e), code: 'SPAWN_FAILED' })
      return
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
        return
      }
      opts.signal.addEventListener('abort', onAbort)
    }
    child.on('error', (e) => done({ ok: false, status: null, ...collect(), stderr: String(e?.message ?? e), code: 'SPAWN_FAILED' }))
    child.on('close', (status) => done({ ok: status === 0, status, ...collect() }))
  })
}

async function makeFixture(file, args) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file
  const r = await realRun(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file])
  assert.equal(r.ok, true, '生成测试素材失败：' + String(r.stderr).slice(-300))
  return file
}

let noAudioFile = null
let gapFile = null
let toneFile = null
if (hasFfmpeg) {
  fs.mkdirSync(ASSETS, { recursive: true })
  // 纯画面（无音轨）：验收第 3 条要的就是它
  noAudioFile = await makeFixture(path.join(ASSETS, 'noaudio.mp4'), [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'
  ])
  // 1.2s 有声 + 1.6s 静音 + 1.2s 有声：给 detectSpeech 一个真的静音缺口
  gapFile = await makeFixture(path.join(ASSETS, 'gap.wav'), [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2:r=16000',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2:r=16000',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'
  ])
  // 真 whisper 素材：5 秒（上限），再长只是白花时间
  toneFile = await makeFixture(path.join(ASSETS, 'tone5.wav'), [
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'
  ])
}

// 假的 whisper-cli.exe / 模型 / 输入 wav：只为让"文件存在性检查"通过，永远不被执行
fs.mkdirSync(DUMMY, { recursive: true })
const DUMMY_BIN = path.join(DUMMY, 'whisper-cli.exe')
const DUMMY_DIR = DUMMY
const DUMMY_MODEL = path.join(DUMMY, 'ggml-dummy.bin')
const DUMMY_WAV_A = path.join(DUMMY, 'c000.wav')
const DUMMY_WAV_B = path.join(DUMMY, 'c001.wav')
for (const f of [DUMMY_BIN, DUMMY_MODEL, DUMMY_WAV_A, DUMMY_WAV_B]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '')
}

function argAfter(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const FAIL = { __fail: true }
const BAD_JSON = { __bad: true }

// 假 runImpl：whisper 调用写 JSON 文件，ffmpeg 调用把输出文件"碰"出来（真 ffmpeg 会写）
function makeFakeRun(overrides = {}) {
  const calls = []
  const runImpl = async (bin, args) => {
    calls.push({ bin, args: [...args] })
    if (args.some((a) => String(a).startsWith('silencedetect='))) {
      return { ok: true, status: 0, stdout: '', stderr: String(overrides.silence ?? '') }
    }
    if (args.includes('-oj')) {
      const of = argAfter(args, '-of')
      const json = typeof overrides.whisper === 'function' ? overrides.whisper({ bin, args, calls }) : { transcription: [] }
      if (json === FAIL) return { ok: false, status: 1, stdout: '', stderr: 'whisper 挂了' }
      if (json === BAD_JSON) {
        fs.writeFileSync(of + '.json', '{ 这不是 JSON')
        return { ok: true, status: 0, stdout: '', stderr: '' }
      }
      fs.writeFileSync(of + '.json', JSON.stringify(json))
      return { ok: true, status: 0, stdout: '', stderr: '' }
    }
    if (overrides.ffmpeg && overrides.ffmpeg({ args }) === FAIL) {
      return { ok: false, status: 1, stdout: '', stderr: String(overrides.ffmpegStderr ?? 'ffmpeg 挂了') }
    }
    const out = args[args.length - 1]
    if (out && out !== '-') fs.writeFileSync(out, '')
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  return { runImpl, calls }
}

function assertAscending(segments) {
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].startMs >= segments[i - 1].startMs, '片段必须按 startMs 升序')
  }
}

function assertWellFormed(segments) {
  for (const s of segments) {
    assert.equal(typeof s.startMs, 'number')
    assert.equal(typeof s.endMs, 'number')
    assert.ok(s.endMs > s.startMs, '每段必须 endMs > startMs')
    assert.ok(s.text.length > 0, '每段文字非空')
  }
  assertAscending(segments)
}

function assertChunkInvariants(chunks, spans, maxChunkMs = 30000) {
  for (const c of chunks) {
    assert.ok(c.endMs > c.startMs, '块必须非空')
    assert.ok(c.endMs - c.startMs <= maxChunkMs, '块时长必须 ≤ maxChunkMs')
  }
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].startMs >= chunks[i - 1].endMs, '块按时间升序且不重叠')
  }
  // 覆盖：每一处有声位置都必须落在某一块里
  for (const span of spans) {
    for (let ms = span.startMs; ms < span.endMs; ms += 50) {
      assert.ok(chunks.some((c) => c.startMs <= ms && ms < c.endMs), '有声位置 ' + ms + 'ms 没被任何块覆盖')
    }
  }
}

test('planChunks：空输入返回空数组', () => {
  assert.deepEqual(planChunks([]), [])
  assert.deepEqual(planChunks(), [])
  assert.deepEqual(planChunks([{ startMs: 0, endMs: 0 }]), [])
})

test('planChunks：单段 90s → 每块 ≤30000ms、升序、不重叠、覆盖整段', () => {
  const spans = [{ startMs: 0, endMs: 90000 }]
  const chunks = planChunks(spans)
  assert.ok(chunks.length >= 3)
  assertChunkInvariants(chunks, spans)
  assert.equal(chunks[0].startMs, 0)
  assert.equal(chunks[chunks.length - 1].endMs, 90000)
})

test('planChunks：切点落在有声段边界（静音处），不切进段内', () => {
  const spans = [
    { startMs: 0, endMs: 20000 },
    { startMs: 25000, endMs: 45000 },
    { startMs: 50000, endMs: 71000 }
  ]
  const chunks = planChunks(spans)
  assert.ok(chunks.length >= 3)
  assertChunkInvariants(chunks, spans)
  const edges = new Set([0, ...spans.map((s) => s.startMs), ...spans.map((s) => s.endMs)])
  for (const c of chunks) assert.ok(edges.has(c.startMs), '块起点 ' + c.startMs + ' 必须落在静音处')
})

test('planChunks：maxChunkMs 可覆盖，乱序 / 重叠输入先归一化', () => {
  const chunks = planChunks(
    [{ startMs: 5000, endMs: 12000 }, { startMs: 0, endMs: 6000 }, { startMs: 9000, endMs: 10000 }],
    { maxChunkMs: 8000 }
  )
  assert.deepEqual(chunks, [{ startMs: 0, endMs: 8000 }, { startMs: 8000, endMs: 12000 }])
})

test('transcribeChunk：解析假 whisper JSON，偏移加回 chunk 起点', async () => {
  const { runImpl } = makeFakeRun({
    whisper: () => ({
      result: { language: 'zh' },
      transcription: [
        { offsets: { from: 0, to: 1200 }, text: '第一句' },
        { offsets: { from: 1200, to: 2600 }, text: '  第二句  ' },
        { offsets: { from: 2600, to: 2600 }, text: '退化段（丢弃）' },
        { offsets: { from: 3000, to: 4000 }, text: '   ' }
      ]
    })
  })
  const base = { whisperBin: DUMMY_BIN, model: DUMMY_MODEL, lang: 'zh', threads: 2, runImpl }
  const first = await transcribeChunk(DUMMY_WAV_A, { ...base, offsetMs: 0 })
  // 只有前两段合格：空文字与 from == to 的退化段必须被丢掉
  assert.deepEqual(first.map((s) => s.startMs), [0, 1200])
  assert.deepEqual(first.map((s) => s.text), ['第一句', '第二句'])
  assertWellFormed(first)

  const second = await transcribeChunk(DUMMY_WAV_B, { ...base, offsetMs: 20000 })
  assert.ok(second.length > 0, '第二块必须解析出片段')
  assert.equal(second[0].startMs, 20000, '第二块时间轴必须加回 offsetMs')
  for (const s of second) assert.ok(s.startMs >= 20000, '第二块任何片段都不许早于 20000ms')
  assert.deepEqual(second.map((s) => s.startMs), [20000, 21200])
  assertWellFormed(second)
})

test('transcribeChunk：语言必须显式传给 whisper，auto 才省略 -l', async () => {
  const zh = makeFakeRun({ whisper: () => ({ transcription: [] }) })
  await transcribeChunk(DUMMY_WAV_A, { whisperBin: DUMMY_BIN, model: DUMMY_MODEL, lang: 'zh', runImpl: zh.runImpl })
  const zhArgs = zh.calls.find((c) => c.args.includes('-oj')).args
  assert.deepEqual([zhArgs[zhArgs.indexOf('-l')], zhArgs[zhArgs.indexOf('-l') + 1]], ['-l', 'zh'])
  assert.ok(zhArgs.includes('-t'), '必须带线程数 -t')
  assert.ok(zhArgs.includes('--no-prints'), '必须带 --no-prints')
  assert.ok(zhArgs.includes('-oj'), '必须带 -oj 才会出 JSON')

  const auto = makeFakeRun({ whisper: () => ({ transcription: [] }) })
  await transcribeChunk(DUMMY_WAV_A, { whisperBin: DUMMY_BIN, model: DUMMY_MODEL, lang: 'auto', runImpl: auto.runImpl })
  const autoArgs = auto.calls.find((c) => c.args.includes('-oj')).args
  assert.equal(autoArgs.includes('-l'), false, 'lang=auto 时必须省略 -l')
})

test('transcribe：分块转录后按 offsets 拼回，每块加回自己的起始偏移', async () => {
  const { runImpl, calls } = makeFakeRun({
    silence: [
      '[Parsed_silencedetect_0 @ 0000] silence_start: 20.000',
      '[Parsed_silencedetect_0 @ 0000] silence_end: 25.000 | silence_duration: 5.0',
      '[Parsed_silencedetect_0 @ 0000] silence_start: 45.000',
      '[Parsed_silencedetect_0 @ 0000] silence_end: 50.000 | silence_duration: 5.0'
    ].join('\n'),
    whisper: ({ args }) => {
      const wav = path.basename(argAfter(args, '-f'))
      const i = Number(String(wav).replace(/\D/g, '')) || 0
      return { result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: '块' + i }] }
    }
  })
  const r = await transcribe('fake-video.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 60000 },
    concurrency: 2,
    runImpl
  })
  // 有声段 = [0,20s] / [25s,45s] / [50s,60s] → 三块：0 / 25000 / 50000 起
  assert.deepEqual(r.failures, [])
  assert.deepEqual(r.segments.map((s) => s.startMs), [0, 25000, 50000])
  assert.deepEqual(r.segments.map((s) => s.text), ['块0', '块1', '块2'])
  assertWellFormed(r.segments)
  assert.equal(r.detected.hasAudio, true)
  assert.equal(r.detected.chunkCount, 3)
  assert.equal(r.detected.speechMs, 50000)
  assert.equal(r.detected.lang, 'zh')
  // 并发真的开了：三块 = 三次 whisper 进程，且都是独立 wav
  const whisperCalls = calls.filter((c) => c.args.includes('-oj'))
  assert.equal(whisperCalls.length, 3)
})

test('transcribe：无音轨不 throw，返回空 segments + 结构化 failures', async (t) => {
  const meta = { hasAudio: false, durationMs: 2000 }
  const r1 = await transcribe('anything.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta,
    runImpl: async () => {
      throw new Error('probe 说没音轨，就不该 spawn 任何进程')
    }
  })
  assert.deepEqual(r1.segments, [])
  assert.ok(r1.failures.length > 0)
  assert.equal(r1.failures[0].stage, 'audio')
  assert.equal(r1.failures[0].reason, 'no-audio-track')
  assert.equal(r1.detected.hasAudio, false)

  if (!hasFfmpeg) return t.skip('缺 ffmpeg，跳过真 ffmpeg 的无音轨用例')
  // 真 ffmpeg 跑：输出里没有任何流 → 也得归成 no-audio-track，而不是抛
  const r2 = await transcribe(noAudioFile, {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 2000 },
    runImpl: realRun
  })
  assert.deepEqual(r2.segments, [])
  assert.ok(r2.failures.length > 0)
  assert.equal(r2.failures[0].stage, 'audio')
  assert.equal(r2.failures[0].reason, 'no-audio-track')
})

test('transcribe：whisper 缺可执行文件 / 缺模型 → failures 写清缺哪个文件，不 throw', async () => {
  const rBin = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: path.join(DUMMY, '不存在的 whisper-cli.exe'),
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 1000 }
  })
  assert.deepEqual(rBin.segments, [])
  assert.equal(rBin.failures[0].reason, 'whisper-missing')
  assert.ok(String(rBin.failures[0].missing).includes('whisper-cli'))

  const rModel = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: path.join(DUMMY, '空目录'),
    modelName: 'small',
    meta: { hasAudio: true, durationMs: 1000 }
  })
  assert.deepEqual(rModel.segments, [])
  assert.equal(rModel.failures[0].reason, 'whisper-model-missing')
  assert.ok(String(rModel.failures[0].missing).includes('ggml-small.bin'))
})

test('transcribe：whisper 进程失败 / JSON 坏掉 / run 自己抛 → 都进 failures，不 throw', async () => {
  const base = {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 6000 }
  }
  const bad = makeFakeRun({ whisper: () => FAIL })
  const rFail = await transcribe('v.mp4', { ...base, runImpl: bad.runImpl })
  assert.deepEqual(rFail.segments, [])
  assert.equal(rFail.failures[0].reason, 'whisper-failed')
  assert.equal(rFail.failures[0].stage, 'audio')

  const badJson = makeFakeRun({ whisper: () => BAD_JSON })
  const rJson = await transcribe('v.mp4', { ...base, runImpl: badJson.runImpl })
  assert.deepEqual(rJson.segments, [])
  assert.equal(rJson.failures[0].reason, 'whisper-json-invalid')

  const badFf = makeFakeRun({ ffmpeg: () => FAIL })
  const rFf = await transcribe('v.mp4', { ...base, runImpl: badFf.runImpl })
  assert.deepEqual(rFf.segments, [])
  assert.equal(rFf.failures[0].reason, 'extract-failed')

  const rThrow = await transcribe('v.mp4', {
    ...base,
    runImpl: async () => {
      throw new Error('注入的 run 抛了')
    }
  })
  assert.deepEqual(rThrow.segments, [])
  assert.ok(rThrow.failures.length > 0)
  assert.equal(rThrow.failures[0].stage, 'audio')
})

test('transcribe：单块失败不影响其它块，只记 failures', async () => {
  const { runImpl } = makeFakeRun({
    silence: ['silence_start: 20.000', 'silence_end: 25.000 | silence_duration: 5.0'].join('\n'),
    whisper: ({ args }) => {
      const wav = path.basename(argAfter(args, '-f'))
      if (String(wav).includes('001')) return FAIL
      return { result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 800 }, text: '活下来的块' }] }
    }
  })
  const r = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 45000 },
    runImpl
  })
  // 有声段 = [0,20s] / [25s,45s] → 两块，第二块故意失败
  assert.equal(r.detected.chunkCount, 2)
  assert.equal(r.segments.length, 1)
  assert.equal(r.segments[0].text, '活下来的块')
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].chunkIndex, 1)
})

test('detectSpeech：解析真 silencedetect 输出，取静音的补集', async (t) => {
  const fake = makeFakeRun({
    silence: [
      '[Parsed_silencedetect_0 @ 00000156] silence_start: 1.199909',
      '[Parsed_silencedetect_0 @ 00000156] silence_end: 2.800113 | silence_duration: 1.600204'
    ].join('\n')
  })
  const spans = await detectSpeech('v.mp4', { ffmpeg: FFMPEG, durationMs: 4000, runImpl: fake.runImpl })
  assert.deepEqual(spans, [{ startMs: 0, endMs: 1200 }, { startMs: 2800, endMs: 4000 }])

  // 一行静音都没有（全片有声）→ 整段当一个有声段，不是空数组
  const silent = makeFakeRun({ silence: '' })
  const whole = await detectSpeech('v.mp4', { ffmpeg: FFMPEG, durationMs: 4000, runImpl: silent.runImpl })
  assert.deepEqual(whole, [{ startMs: 0, endMs: 4000 }])

  if (!hasFfmpeg) return t.skip('缺 ffmpeg，跳过真 silencedetect 用例')
  const real = await detectSpeech(gapFile, { ffmpeg: FFMPEG, durationMs: 4000, runImpl: realRun })
  assert.ok(real.length >= 1)
  for (const s of real) assert.ok(s.endMs > s.startMs)
  assert.equal(real[0].startMs, 0)
})

test('extractWav：有音轨产出 wav，无音轨返回 null 而不抛', async (t) => {
  if (!hasFfmpeg) return t.skip('缺 ffmpeg')
  const out = path.join(ASSETS, 'out-extract.wav')
  const ok = await extractWav(toneFile, { ffmpeg: FFMPEG, outFile: out, runImpl: realRun })
  assert.equal(ok, out)
  assert.ok(fs.statSync(out).size > 0)
  const none = await extractWav(noAudioFile, { ffmpeg: FFMPEG, outFile: path.join(ASSETS, 'out-none.wav'), runImpl: realRun })
  assert.equal(none, null)
})

test('默认 run：不注入 runImpl 时走 lib/media/ffmpeg.js 的 run', async (t) => {
  // 契约 §5 指定的子进程接缝就在那个文件里；它没落地（或没装 ffmpeg）时这条只能 skip，
  // 落地了就必须真的接上 —— 否则 audio.js 在集成时是"静默失效"的（全部走 failures）。
  const ffmpegModule = path.join(ROOT, 'lib', 'media', 'ffmpeg.js')
  if (!fs.existsSync(ffmpegModule)) return t.skip('lib/media/ffmpeg.js 还没落地')
  if (!hasFfmpeg) return t.skip('缺 ffmpeg')
  const out = path.join(ASSETS, 'out-default-run.wav')
  const file = await extractWav(toneFile, { ffmpeg: FFMPEG, outFile: out })
  assert.equal(file, out, '默认 run 必须真的跑出 wav（说明接上了 ffmpeg.js）')
  assert.ok(fs.statSync(out).size > 0)
  fs.rmSync(out, { force: true })
})

test('t2s：真实转录的繁体句子 → 简体', () => {
  const info = ensureLoaded()
  assert.equal(info.ready, true, 'assets/opencc 两份词表必须都在')
  assert.ok(info.chars > 1000 && info.phrases > 100)
  assert.equal(toSimplified(REAL_TC_1), REAL_SC_1)
  assert.equal(toSimplified(REAL_TC_2), REAL_SC_2)
  assert.equal(hasTraditional(REAL_TC_1), true)
  assert.equal(hasTraditional(REAL_TC_2), true)
  assert.equal(hasTraditional(REAL_SC_1), false, '已经是简体就不该判成需要转换')
})

test('t2s：转换幂等，空串 / 非中文原样返回', () => {
  const once = toSimplified(REAL_TC_1)
  assert.equal(toSimplified(once), once, '重复转必须不变（幂等）')
  assert.equal(toSimplified(''), '')
  assert.equal(toSimplified(null), '')
  assert.equal(toSimplified(undefined), '')
  assert.equal(toSimplified('hello 世界 123 🐱'), 'hello 世界 123 🐱')
  assert.equal(hasTraditional(''), false)
  // 代理对（表情）不能被按 code unit 切坏
  assert.equal(toSimplified('🐱貓🐱'), '🐱猫🐱')
})

test('t2s：词表缺失 fail-open —— 原样返回，不抛', () => {
  const info = ensureLoaded({ dir: NO_DICT_DIR })
  assert.equal(info.ready, false)
  assert.equal(info.phrases, 0)
  assert.equal(toSimplified(REAL_TC_1, { dir: NO_DICT_DIR }), REAL_TC_1, '没词表就原样返回繁体')
  assert.equal(hasTraditional(REAL_TC_1, { dir: NO_DICT_DIR }), false, '没词表就当作不需要转换')
  // 默认词表不受影响（缓存按目录分族）
  assert.equal(toSimplified(REAL_TC_1), REAL_SC_1)
})

test('transcribe：默认把繁体段转成简体，detected.t2s.converted 记段数', async () => {
  const { runImpl } = makeFakeRun({
    whisper: () => ({
      result: { language: 'zh' },
      transcription: [
        { offsets: { from: 0, to: 5920 }, text: REAL_TC_1 },
        { offsets: { from: 5920, to: 10080 }, text: REAL_SC_1 }
      ]
    })
  })
  const r = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 10080 },
    runImpl
  })
  assert.deepEqual(r.failures, [])
  assert.deepEqual(r.segments.map((s) => s.text), [REAL_SC_1, REAL_SC_1])
  assert.equal(r.detected.t2s.converted, 1, '只有第一段真的是繁体，converted 只数它')
  // 转的是 text，offsets 一个都不许动
  assert.deepEqual(r.segments.map((s) => [s.startMs, s.endMs]), [[0, 5920], [5920, 10080]])
})

test('transcribe：toSimplified:false 时 text 原样（不动繁体）', async () => {
  const { runImpl } = makeFakeRun({
    whisper: () => ({ result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 5920 }, text: REAL_TC_1 }] })
  })
  const r = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 5920 },
    toSimplified: false,
    runImpl
  })
  assert.deepEqual(r.segments.map((s) => s.text), [REAL_TC_1])
  assert.equal(r.detected.t2s.converted, 0)
})

test('transcribe：词表目录不存在 → fail-open，原文返回且不记 failure', async () => {
  const { runImpl } = makeFakeRun({
    whisper: () => ({ result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 5920 }, text: REAL_TC_1 }] })
  })
  const r = await transcribe('v.mp4', {
    ffmpeg: FFMPEG,
    whisperBin: DUMMY_BIN,
    whisperDir: DUMMY_DIR,
    modelName: 'dummy',
    meta: { hasAudio: true, durationMs: 5920 },
    t2sDir: NO_DICT_DIR,
    runImpl
  })
  assert.deepEqual(r.failures, [], '词表缺失是质量问题，不是 failure')
  assert.deepEqual(r.segments.map((s) => s.text), [REAL_TC_1])
  assert.equal(r.detected.t2s.converted, 0)
})

test('真 whisper 端到端：5 秒素材跑通抽轨 → 转录 → 拼回', async (t) => {
  if (!hasFfmpeg || !hasWhisper) return t.skip('缺 ffmpeg / whisper-cli / ggml 模型')
  const r = await transcribe(toneFile, {
    ffmpeg: FFMPEG,
    whisperBin: WHISPER_BIN,
    whisperDir: WHISPER_DIR,
    modelName: MODEL,
    lang: 'zh',
    meta: { hasAudio: true, durationMs: 5000 },
    concurrency: 2,
    threads: 2,
    runImpl: realRun
  })
  assert.deepEqual(r.failures, [])
  assert.equal(r.detected.hasAudio, true)
  assert.equal(typeof r.detected.lang, 'string')
  assert.ok(r.detected.chunkCount >= 1)
  assertWellFormed(r.segments)
  for (const s of r.segments) assert.ok(s.endMs <= 5000, '时间轴不能超出素材时长')
})

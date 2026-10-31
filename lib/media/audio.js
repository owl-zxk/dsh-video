/**
 * 音轨抽取 + whisper 转录（带毫秒时间轴）
 *
 * 为什么不调 dsh-voice-call 的 transcribe 工具（PROMPT §0 的三个坑）：
 *   ① 它只取 whisper JSON 的 transcription[0].text —— 长视频只拿到开头一句；
 *   ② 它的 whisper 路径是插件侧配置、不是 volatile 字段，改完必须重启 DSH 才生效；
 *   ③ 它不传语言，中文靠自动检测会偶发误判成粤语 / 日文。
 *   所以这里自己抽 16k 单声道 wav、自己 spawn whisper-cli -oj、自己把 transcription[] 全拼回来。
 *
 * 为什么要分块并发：whisper 是 CPU-bound，一个进程只吃一个核；按 ≤30s 切块、每块一个进程并发跑，
 * 是"白拿"的加速项（不损失准确率）。但**切块必须落在静音处**：硬切会把一个词切成两半，
 * 两边各转出半个词。所以先 silencedetect 找静音 → 取补集得到有声段 → planChunks 只在段边界处切。
 *
 * 为什么 offsets 要加回 chunk 起点：每块是独立的 wav（-ss 定位后单独抽），whisper 吐的 offsets
 * 只相对该 wav。不加回 offsetMs，第 N 块的时间轴会全挤到 0 附近 —— 而且错得很隐蔽
 * （看起来"有字有时间"，只是全错）。transcribeChunk 的 offsetMs 参数就是干这个的。
 *
 * 为什么 transcribe() 绝不 throw：它是 video_understand 管线里的一段，整条链路的约定是
 * "模型 / 二进制挂了也只返回结构化结果 + failures"。无音轨是**正常情况**（很多视频就是纯画面），
 * 更不该当成异常。
 *
 * 为什么默认 run 是懒加载 ./ffmpeg.js：契约 §5 规定子进程走 lib/media/ffmpeg.js 的 run。
 *   那个文件属 A 组，并行开发期可能还不存在；静态 import 会让本模块根本加载不起来
 *   （连只测纯函数的用例都跑不了）。所以第一次真要用时才 import：拿到就用，拿不到就走
 *   结构化 failures。测试一律注入 runImpl，不走这条默认路径。
 *
 * 为什么要做繁转简：whisper 对本项目用户素材输出的**就是繁体**（BV1DubxzVEPB 前 20 秒实测
 *   「花四個月時間給貓咪小鎮做的地鐵站…」）。用 --prompt 诱导简体试过四种写法全无效、还会诱发幻觉，
 *   只能在输出侧转码 —— 契约 §9.1 因此要求接 lib/util/t2s.js。转的只有 text，offsets 一个都不动；
 *   词表缺失时 fail-open：原样返回繁体、不抛、不记 failure、converted 记 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasTraditional, toSimplified } from '../util/t2s.js'

const WAV_RATE = 16000
const DEFAULT_MAX_CHUNK_MS = 30000
const DEFAULT_NOISE_DB = -30
const DEFAULT_MIN_SILENCE_MS = 500
const DEFAULT_WHISPER_TIMEOUT_MS = 1800000
const DEFAULT_EXTRACT_TIMEOUT_MS = 900000
const DEFAULT_SILENCE_TIMEOUT_MS = 600000
const DETAIL_MAX = 400

// 静音检测输出的两行（实测格式）：
//   [Parsed_silencedetect_0 @ ...] silence_start: 1.999909
//   [Parsed_silencedetect_0 @ ...] silence_end: 4.000113 | silence_duration: 2.000204
const SILENCE_RE = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g

let defaultRunPromise = null

// 第一次要用真子进程时才去拿契约 §5 的 run；拿不到不抛，交给调用方记 failures
function loadDefaultRun() {
  if (!defaultRunPromise) {
    defaultRunPromise = import('./ffmpeg.js')
      .then((m) => (typeof m.run === 'function' ? m.run : null))
      .catch(() => null)
  }
  return defaultRunPromise
}

function isPositiveInt(n) {
  return Number.isFinite(n) && n > 0
}

function existsFile(p) {
  if (!p) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function seconds(ms) {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3)
}

function tail(s) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ')
  return t.length > DETAIL_MAX ? t.slice(-DETAIL_MAX) : t
}

function runFailed(code, detail) {
  return { ok: false, status: null, stdout: '', stderr: String(detail ?? ''), code }
}

// 统一走这一层：注入的 runImpl 可能 throw（契约说 run 永不 throw，但注入的东西不一定守规矩）
async function callRun(ctx, bin, args, opts) {
  const impl = typeof ctx?.runImpl === 'function' ? ctx.runImpl : await loadDefaultRun()
  if (!impl) return runFailed('RUN_UNAVAILABLE', 'lib/media/ffmpeg.js 的 run 不可用')
  try {
    const r = await impl(bin, args, opts)
    if (!r || typeof r !== 'object') return runFailed('RUN_BAD_RESULT', '子进程封装没有返回结果对象')
    return {
      ok: r.ok === true,
      status: Number.isInteger(r.status) ? r.status : null,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      ...(r.code ? { code: String(r.code) } : {})
    }
  } catch (e) {
    return runFailed('RUN_THREW', e?.message ?? e)
  }
}

// 抽音轨：-vn 只留音频，16k 单声道 pcm_s16le —— whisper 的原生输入
async function extractWavRange(video, opts) {
  const {
    ffmpeg: bin,
    outFile,
    timeoutMs = DEFAULT_EXTRACT_TIMEOUT_MS,
    startMs = 0,
    durationMs = 0,
    runImpl,
    signal
  } = opts ?? {}
  if (!bin || !video || !outFile) {
    return { ok: false, file: null, stderr: '缺 ffmpeg / video / outFile', code: 'BAD_ARGS' }
  }
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
  } catch {
    // 目录建不出来就让 ffmpeg 自己报错，这里不预先抛
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  // -ss 放 -i 之前 = 快速定位（跳过前面的解码）；每块独立 wav 靠它定位
  if (isPositiveInt(startMs)) args.push('-ss', seconds(startMs))
  args.push('-i', video)
  if (isPositiveInt(durationMs)) args.push('-t', seconds(durationMs))
  args.push('-vn', '-ac', '1', '-ar', String(WAV_RATE), '-c:a', 'pcm_s16le', outFile)
  const r = await callRun({ runImpl }, bin, args, { timeoutMs, signal })
  if (!r.ok) return { ok: false, file: null, stderr: r.stderr, code: r.code ?? 'EXTRACT_FAILED' }
  if (!existsFile(outFile)) {
    return { ok: false, file: null, stderr: r.stderr || 'ffmpeg 没产出 wav', code: 'NO_OUTPUT' }
  }
  return { ok: true, file: outFile, stderr: r.stderr, code: null }
}

export async function extractWav(video, opts = {}) {
  const r = await extractWavRange(video, opts)
  return r.ok ? r.file : null
}

// 解析 silencedetect 的两行日志；未闭合的 silence_start 记 endMs: null（静到片尾）
function parseSilences(text) {
  const out = []
  const src = String(text ?? '')
  let open = null
  SILENCE_RE.lastIndex = 0
  let m = SILENCE_RE.exec(src)
  while (m !== null) {
    const ms = Math.max(0, Math.round(Number(m[2]) * 1000))
    if (m[1] === 'start') {
      open = ms
    } else if (open !== null) {
      if (ms > open) out.push({ startMs: open, endMs: ms })
      open = null
    }
    m = SILENCE_RE.exec(src)
  }
  if (open !== null) out.push({ startMs: open, endMs: null })
  return out
}

// 有声段 = [0, durationMs] 减去静音段
function speechSpansFrom(silences, durationMs) {
  const total = isPositiveInt(durationMs) ? Math.round(durationMs) : 0
  const gaps = []
  for (const s of silences) {
    const from = Math.max(0, Math.round(s.startMs))
    const to = s.endMs === null ? total : Math.max(0, Math.round(s.endMs))
    if (to > from) gaps.push({ startMs: from, endMs: to })
  }
  gaps.sort((a, b) => a.startMs - b.startMs)
  const spans = []
  let cursor = 0
  for (const g of gaps) {
    if (g.startMs > cursor) spans.push({ startMs: cursor, endMs: g.startMs })
    if (g.endMs > cursor) cursor = g.endMs
  }
  const end = total > 0 ? total : cursor
  if (end > cursor) spans.push({ startMs: cursor, endMs: end })
  return spans.filter((s) => s.endMs > s.startMs)
}

export async function detectSpeech(video, opts = {}) {
  const {
    ffmpeg: bin,
    durationMs = 0,
    noiseDb = DEFAULT_NOISE_DB,
    minSilenceMs = DEFAULT_MIN_SILENCE_MS,
    timeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
    runImpl,
    signal
  } = opts
  const whole = [{ startMs: 0, endMs: isPositiveInt(durationMs) ? Math.round(durationMs) : 0 }]
  if (!bin || !video) return whole
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-i',
    video,
    '-vn',
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${Math.max(0, Number(minSilenceMs) || 0) / 1000}`,
    '-f',
    'null',
    '-'
  ]
  const r = await callRun({ runImpl }, bin, args, { timeoutMs, signal })
  if (!r.ok && !r.stderr) return whole
  const silences = parseSilences(r.stderr)
  // 全片都有声音时 silencedetect 一行都不打印 —— 那不是"没有有声段"，是"整段都有声"
  if (!silences.length) return whole
  const spans = speechSpansFrom(silences, durationMs)
  return spans.length ? spans : whole
}

// 排序 + 丢掉退化区间 + 合并重叠 / 相接的段
function normalizeSpans(spans) {
  const list = []
  for (const s of Array.isArray(spans) ? spans : []) {
    const startMs = Math.max(0, Math.round(Number(s?.startMs)))
    const endMs = Math.round(Number(s?.endMs))
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    if (endMs > startMs) list.push({ startMs, endMs })
  }
  list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged = []
  for (const s of list) {
    const last = merged[merged.length - 1]
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs)
    else merged.push({ ...s })
  }
  return merged
}

/**
 * 规划分块（纯函数）。
 * 只在**有声段边界**处切 —— 那些边界就是静音位置，所以切点天然落在静音里，不会切半个词。
 * 单段本身比 maxChunkMs 还长时只能按 maxChunkMs 均分（段内没有静音可用，这是唯一的下策）。
 */
export function planChunks(speechSpans, opts = {}) {
  const want = Number(opts?.maxChunkMs)
  const max = isPositiveInt(want) ? Math.floor(want) : DEFAULT_MAX_CHUNK_MS
  const spans = normalizeSpans(speechSpans)
  if (!spans.length) return []
  const pieces = []
  for (const s of spans) {
    let from = s.startMs
    while (from < s.endMs) {
      const to = Math.min(from + max, s.endMs)
      pieces.push({ startMs: from, endMs: to })
      from = to
    }
  }
  // 相邻片段能塞进同一块就合并（跨静音的合并只会多解一点点静音，换来更少的 whisper 进程）
  const chunks = []
  for (const p of pieces) {
    const last = chunks[chunks.length - 1]
    if (last && p.endMs - last.startMs <= max) last.endMs = p.endMs
    else chunks.push({ ...p })
  }
  return chunks
}

// 线程数：默认 CPU 物理核数的一半，最少 1（whisper 的 -t 是它自己内部的线程池）
function resolveThreads(threads) {
  if (isPositiveInt(threads)) return Math.max(1, Math.floor(threads))
  const cores = Array.isArray(os.cpus()) && os.cpus().length ? os.cpus().length : 2
  return Math.max(1, Math.floor(cores / 2))
}

// 模型：可以给 'small' / 'ggml-small.bin' / 绝对路径；给名字就去 whisperDir 里找，找不到退回 small > base
function resolveModel(whisperDir, modelName) {
  const name = String(modelName ?? '').trim()
  if (name && existsFile(name)) return name
  const dir = String(whisperDir ?? '').trim()
  if (!dir) return null
  const candidates = []
  if (name) candidates.push(path.join(dir, name.endsWith('.bin') ? name : `ggml-${name}.bin`))
  candidates.push(path.join(dir, 'ggml-small.bin'), path.join(dir, 'ggml-base.bin'))
  return candidates.find(existsFile) ?? null
}

const REASON_BY_CODE = {
  WHISPER_MISSING: 'whisper-missing',
  MODEL_MISSING: 'whisper-model-missing',
  NO_WAV: 'extract-failed',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  NO_JSON: 'whisper-failed',
  BAD_JSON: 'whisper-json-invalid',
  NO_OUTPUT: 'extract-failed',
  BAD_ARGS: 'bad-args',
  RUN_UNAVAILABLE: 'run-unavailable',
  RUN_THREW: 'run-failed',
  RUN_BAD_RESULT: 'run-failed'
}

function reasonFor(code, fallback = 'whisper-failed') {
  return REASON_BY_CODE[String(code ?? '')] ?? fallback
}

// ffmpeg 对没有音轨的输入只会说"输出里没有任何流" —— 这不是错误，是这个视频本来就没有声音
function reasonFromStderr(stderr, fallback) {
  const s = String(stderr ?? '')
  if (/does not contain any stream|matches no streams|no such filter: 'silencedetect'/i.test(s)) return 'no-audio-track'
  return fallback
}

async function transcribeOne(wav, opts) {
  const {
    whisperBin,
    model,
    lang = 'zh',
    offsetMs = 0,
    threads,
    timeoutMs = DEFAULT_WHISPER_TIMEOUT_MS,
    runImpl,
    signal
  } = opts ?? {}
  if (!whisperBin || !wav) return { segments: [], language: null, error: { code: 'BAD_ARGS', detail: '缺 whisperBin / wav' } }
  if (!existsFile(whisperBin)) return { segments: [], language: null, error: { code: 'WHISPER_MISSING', detail: whisperBin } }
  if (!model || !existsFile(model)) return { segments: [], language: null, error: { code: 'MODEL_MISSING', detail: String(model ?? '') } }
  if (!existsFile(wav)) return { segments: [], language: null, error: { code: 'NO_WAV', detail: wav } }
  const outBase = wav.slice(0, wav.length - path.extname(wav).length) + '.asr'
  const args = ['-m', model, '-f', wav, '-oj', '-of', outBase, '--no-prints', '-t', String(resolveThreads(threads))]
  // 语言必须显式给：全靠自动检测时中文会偶发误判成粤语 / 日文。只有 lang === 'auto' 才省略 -l
  if (lang && String(lang) !== 'auto') args.push('-l', String(lang))
  const r = await callRun({ runImpl }, whisperBin, args, { timeoutMs, signal })
  const jsonFile = outBase + '.json'
  if (!existsFile(jsonFile)) {
    return { segments: [], language: null, error: { code: r.code ?? 'NO_JSON', detail: r.stderr || 'whisper 没产出 JSON' } }
  }
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  } catch (e) {
    return { segments: [], language: null, error: { code: 'BAD_JSON', detail: e?.message ?? e } }
  }
  const offset = isPositiveInt(offsetMs) ? Math.round(offsetMs) : 0
  const segments = []
  for (const s of Array.isArray(parsed?.transcription) ? parsed.transcription : []) {
    const text = String(s?.text ?? '').trim()
    if (!text) continue
    const startMs = Math.max(0, Math.round(Number(s?.offsets?.from ?? 0))) + offset
    const endMs = Math.max(0, Math.round(Number(s?.offsets?.to ?? 0))) + offset
    // 契约要求 endMs > startMs；退化段（from == to）直接丢，不伪造时长
    if (!(endMs > startMs)) continue
    segments.push({ startMs, endMs, text })
  }
  segments.sort((a, b) => a.startMs - b.startMs)
  const language = String(parsed?.result?.language ?? '').trim() || null
  return { segments, language, error: null }
}

export async function transcribeChunk(wav, opts = {}) {
  const r = await transcribeOne(wav, opts)
  return r.segments
}

// 并发限流：不走 Promise.all 一把梭，whisper 每个进程已经吃满半个 CPU
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  if (!items.length) return out
  const width = Math.min(items.length, Math.max(1, Math.floor(Number(limit) || 1)))
  let next = 0
  const workers = []
  for (let w = 0; w < width; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next
          next += 1
          if (i >= items.length) return
          out[i] = await fn(items[i], i)
        }
      })()
    )
  }
  await Promise.all(workers)
  return out
}

/**
 * 视频 → 带毫秒时间轴的文字。
 * 绝不 throw：无音轨 / whisper 缺失 / 单块失败，都只进 failures，segments 里给能拿到的那部分。
 * detected 是"我实际测到了什么"，形状由契约 §9 钉死：
 *   { hasAudio, lang, speechMs, chunkCount, t2s: { converted } }
 * t2s.converted 是"真的被繁转简过的段数"（已经是简体的段不计数）。
 * toSimplified / t2sDir 是给测试注入用的接缝（跟 runImpl 一个性质）：t2sDir 能把词表目录
 * 指到一个不存在的路径，验证"词表缺失时 fail-open"。
 */
export async function transcribe(video, opts = {}) {
  const {
    ffmpeg: bin,
    whisperBin,
    whisperDir,
    modelName,
    lang = 'zh',
    concurrency = 2,
    threads,
    timeoutMs = DEFAULT_WHISPER_TIMEOUT_MS,
    signal,
    meta,
    runImpl,
    maxChunkMs = DEFAULT_MAX_CHUNK_MS,
    toSimplified: simplify = true,
    t2sDir
  } = opts
  const failures = []
  const detected = { hasAudio: false, lang: null, speechMs: 0, chunkCount: 0, t2s: { converted: 0 } }
  const result = (segments) => ({ segments, failures, detected })

  // 无音轨是正常情况：probe 已经说了没有，就别再去 spawn 任何东西
  if (meta && meta.hasAudio === false) {
    failures.push({ stage: 'audio', reason: 'no-audio-track' })
    return result([])
  }
  const model = resolveModel(whisperDir, modelName)
  if (!whisperBin || !existsFile(whisperBin)) {
    failures.push({ stage: 'audio', reason: 'whisper-missing', missing: whisperBin ? String(whisperBin) : 'whisper-cli' })
    return result([])
  }
  if (!model) {
    const want = String(modelName ?? 'small')
    failures.push({
      stage: 'audio',
      reason: 'whisper-model-missing',
      missing: whisperDir ? path.join(String(whisperDir), want.endsWith('.bin') ? want : `ggml-${want}.bin`) : `ggml-${want}.bin`
    })
    return result([])
  }

  const durationMs = isPositiveInt(meta?.durationMs) ? Math.round(meta.durationMs) : 0
  // 没有时长就没法做静音补集，也就没法分块 —— 整片当一个 chunk（offset 0）
  let speech = []
  if (durationMs > 0) speech = await detectSpeech(video, { ffmpeg: bin, durationMs, runImpl, signal })
  let chunks = planChunks(speech, { maxChunkMs })
  if (!chunks.length) chunks = [{ startMs: 0, endMs: durationMs }]
  detected.speechMs = speech.reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0)
  detected.chunkCount = chunks.length

  let tmp = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-asr-'))
  } catch {
    tmp = null
  }
  const workDir = tmp ?? os.tmpdir()

  try {
    const parts = await mapLimit(chunks, concurrency, async (chunk, i) => {
      const outFile = path.join(workDir, `c${String(i).padStart(3, '0')}.wav`)
      const len = chunk.endMs - chunk.startMs
      const wav = await extractWavRange(video, {
        ffmpeg: bin,
        outFile,
        startMs: chunk.startMs,
        durationMs: len,
        runImpl,
        signal
      })
      if (!wav.ok) {
        return {
          segments: [],
          extracted: false,
          language: null,
          failure: {
            stage: 'audio',
            reason: reasonFromStderr(wav.stderr, 'extract-failed'),
            chunkIndex: i,
            startMs: chunk.startMs,
            detail: tail(wav.stderr)
          }
        }
      }
      const t = await transcribeOne(wav.file, {
        whisperBin,
        model,
        lang,
        offsetMs: chunk.startMs,
        threads,
        timeoutMs,
        runImpl,
        signal
      })
      if (t.error) {
        return {
          segments: [],
          extracted: true,
          language: t.language,
          failure: {
            stage: 'audio',
            reason: reasonFor(t.error.code, 'whisper-failed'),
            chunkIndex: i,
            startMs: chunk.startMs,
            detail: tail(t.error.detail)
          }
        }
      }
      return { segments: t.segments, extracted: true, language: t.language, failure: null }
    })

    const segments = []
    for (const part of parts) {
      if (part.failure) failures.push(part.failure)
      else segments.push(...part.segments)
      if (!detected.lang && part.language) detected.lang = part.language
      if (part.extracted) detected.hasAudio = true
    }
    segments.sort((a, b) => a.startMs - b.startMs)
    // 繁转简只动 text，绝不动 offsets；只转确实带繁体的段（hasTraditional 为假就跳过，省一次全表扫描）
    if (simplify) {
      let converted = 0
      for (const seg of segments) {
        if (!hasTraditional(seg.text, { dir: t2sDir })) continue
        const text = toSimplified(seg.text, { dir: t2sDir })
        if (text !== seg.text) {
          seg.text = text
          converted += 1
        }
      }
      detected.t2s = { converted }
    }
    return result(segments)
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        // 临时目录删不掉不影响结果
      }
    }
  }
}

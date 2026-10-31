// 抽帧：混合采样（场景点 ∪ 均匀兜底 ∪ 首尾帧）+ 两条抽帧路径
//
// 为什么不能均匀抽帧、也不能"每帧一次全解码"（PROMPT §2.1、§2.7.4）：
//   均匀抽帧会漏掉关键画面；而为了拿时间戳把片子解码 N 遍，会让 40 帧的抽帧变成
//   40 次全片解码。所以本文件的策略是：
//     · 场景切换点：**全片只做一次**全解码，-vf select='gt(scene,0.3)',showinfo，
//       从 **stderr** 里解析 pts_time（showinfo 走日志，不走 stdout）。
//       注意这条命令**不能**用 ffmpeg() 助手，那个助手强制 -loglevel error，
//       正好把 showinfo 的输出吞掉 —— 这是踩过的坑。
//     · 其余每一帧：-ss 放在 -i **之前**（快速 seek，只解码那一帧附近）。
//     · 帧多了（≥40）就反过来：一次 -vf fps=1/interval 全量输出再按时间戳挑，
//       省掉 40 次进程启动（Windows 上每次 50–100 ms，纯开销）。
//
// planFrames 为什么是纯函数：它是准确性的核心（哪一毫秒值得看），
//   必须能在测试里用几百个组合穷举不变量，不能碰文件系统、不能跑子进程。
//
// 采样与截断的取舍（写在代码里，因为这是**故意**丢东西）：
//   场景点优先于均匀帧 —— 截断时先保场景点，剩下的名额才给均匀帧。
//   因此**当场景点本身就超过 maxFrames 时，尾巴上的场景点会被截掉**（按时间升序取，
//   所以掉的是靠后的那段）。这是可接受的：靠后的场景点仍然会落在尾帧与均匀帧的
//   覆盖里，而把名额让给"前段更密的场景变化"对理解开头更有价值。
//   另一个取舍：ms 用的是**请求的时间**，不是 ffmpeg 实际吐帧的时间 —— 两者差
//   不超过半个网格步长，而模型对时间轴的一致性要求（PROMPT §2.2）比毫秒级精确更重要。
//
// JPEG 质量为什么不是直接把 quality 交给 -q:v：ffmpeg 的 -q:v 是 qscale（2 最好、31 最烂），
//   跟 libjpeg 的 quality 是**反的**。直接把 85 塞给 -q:v 会得到一坨糊图，所以这里做换算。
import fs from 'node:fs'
import path from 'node:path'
import { run } from './ffmpeg.js'
import { resolveBinaries, tmpWorkspace } from '../util/paths.js'

/** 首轮抽帧的长边上限（DeepSeek 16:9 的实际发送尺寸 1708×961，PROMPT §0）。 */
const LONG_EDGE = 1708
/** JPEG 质量（契约 §2）。 */
const QUALITY = 85
/** 单帧字节上限（DeepSeek imageMaxBytes 默认 2 MiB）。 */
const MAX_BYTES = 2097152
/** 去重容差：同一段画面相差 0.5s 以内算重复（契约 §2 / §7）。 */
const DEDUPE_MS = 500
/** 帧数到这儿就该改用"一次 fps 全量输出"（PROMPT §2.7.4 的 < 40 分界）。 */
const SEEK_MAX_FRAMES = 40
const MAX_CAPTURE_HINT = 600000
/** 尾帧回退量：请求点在最后一帧之后时，第二次尝试往回退这么多（见 extractFrame 注释）。 */
const TAIL_BACKOFF_MS = 500

const sizeOf = (f) => {
  try { return fs.statSync(f).size } catch { return 0 }
}

/**
 * libjpeg 质量 → ffmpeg qscale。qscale 2 最好 / 31 最烂，与 quality 相反。
 * @param {number} quality 1..100
 */
export function jpegQscale(quality) {
  const q = Number(quality)
  if (!Number.isFinite(q)) return 6
  const v = Math.round(31 - (Math.min(100, Math.max(1, q)) / 100) * 29)
  return Math.min(31, Math.max(2, v))
}

/** 从 showinfo 的 stderr 里取 pts_time（毫秒，按输出顺序）。纯函数。 */
export function parseShowinfoPts(stderr) {
  const out = []
  for (const m of String(stderr ?? '').matchAll(/pts_time:\s*(-?[0-9]+(?:\.[0-9]+)?)/g)) {
    const sec = Number(m[1])
    if (Number.isFinite(sec)) out.push(Math.max(0, Math.round(sec * 1000)))
  }
  return out
}

/** 读 JPEG 的 SOF 段拿真实宽高（不额外起 ffprobe 进程：那会让调用次数翻倍）。 */
function readJpegSize(file) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
    let i = 2
    while (i + 9 < n) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      if (len <= 0) return null
      i += 2 + len
    }
    return null
  } catch {
    return null
  } finally {
    if (fd != null) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
}

/** 最小并发限流器。不依赖 lib/llm/budget.js 的 Semaphore（那是 C 组的文件，可能还没落地）。 */
function limiter(n) {
  const max = Math.max(1, Math.floor(Number(n) || 1))
  let active = 0
  const waiters = []
  const pump = () => {
    while (active < max && waiters.length) {
      const job = waiters.shift()
      active++
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { active--; pump() })
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    waiters.push({ fn, resolve, reject })
    pump()
  })
}

/**
 * 场景切换点（毫秒，升序）。全片**唯一一次**全解码就发生在这里。
 * 失败（ffmpeg 不在、文件坏、超时）一律返回 []：场景点缺失只是精度下降，
 * 均匀兜底还在，不该让整条管线崩（契约 §7 明确"失败 → []"）。
 * @param {string} video
 * @param {{ ffmpeg?: string, threshold?: number, timeoutMs?: number, runImpl?: Function }} [opts]
 * @returns {Promise<number[]>}
 */
export async function detectScenes(video, opts = {}) {
  const { ffmpeg: bin, threshold = 0.3, timeoutMs = MAX_CAPTURE_HINT, runImpl = run } = opts || {}
  const exe = bin || resolveBinaries().ffmpeg
  const filter = `select='gt(scene,${Number(threshold) || 0.3})',showinfo`
  const r = await runImpl(exe, [
    '-hide_banner', '-loglevel', 'info',
    '-i', video,
    '-vf', filter,
    '-f', 'null', '-',
  ], { timeoutMs })
  if (!r?.ok) return []
  const pts = parseShowinfoPts(r.stderr)
  // showinfo 本身按时间顺序吐，但守一道：升序 + 去重（同一时间戳重复出现过一次）
  const uniq = [...new Set(pts)].sort((a, b) => a - b)
  return uniq
}

/**
 * 纯函数：混合采样规划。不碰文件系统、不跑子进程。
 * @param {{ durationMs: number, sceneTimes?: number[], maxFrames: number }} input
 * @returns {Array<{ index: number, ms: number }>}
 */
export function planFrames(input) {
  const { durationMs, sceneTimes = [], maxFrames } = input || {}
  const limit = Math.floor(Number(maxFrames))
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError('planFrames 需要正整数 maxFrames')
  }
  const dur = Math.max(0, Math.round(Number(durationMs) || 0))
  const firstMs = 0
  const lastMs = Math.max(0, dur - 1)

  const chosen = []
  const fits = (ms) => chosen.every((c) => Math.abs(c - ms) > DEDUPE_MS)

  // ① 首尾帧必取（去重容差对它们让路：极短片子 0 与 dur-1 本来就贴在一起）
  chosen.push(firstMs)
  if (limit > 1 && lastMs > firstMs) chosen.push(lastMs)

  // ② 场景点优先
  const scenes = (Array.isArray(sceneTimes) ? sceneTimes : [])
    .map((t) => Math.round(Number(t)))
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= dur)
    .sort((a, b) => a - b)
  for (const ms of scenes) {
    if (chosen.length >= limit) break
    if (fits(ms)) chosen.push(ms)
  }

  // ③ 均匀兜底：每 max(1, duration/maxFrames) 秒 1 帧（秒级下限，避免短视频挤出密集网格）
  const stepMs = Math.max(1000, dur / limit)
  if (stepMs > 0) {
    for (let t = stepMs; t <= dur; t += stepMs) {
      if (chosen.length >= limit) break
      const ms = Math.round(t)
      if (fits(ms)) chosen.push(ms)
    }
  }

  return chosen
    .sort((a, b) => a - b)
    .map((ms, index) => ({ index, ms }))
}

/**
 * 抽单帧（-ss 在 -i 之前 = 快速 seek）。失败/超字节重试一次，仍不行返回 null。
 * @param {string} video
 * @param {number} ms
 * @param {{ ffmpeg?: string, outFile: string, longEdge?: number, quality?: number,
 *   maxBytes?: number, timeoutMs?: number, runImpl?: Function }} opts
 * @returns {Promise<{ file: string, bytes: number, width: number, height: number } | null>}
 */
export async function extractFrame(video, ms, opts = {}) {
  const {
    ffmpeg: bin, outFile, longEdge = LONG_EDGE, quality = QUALITY,
    maxBytes = MAX_BYTES, timeoutMs = 60000, runImpl = run,
  } = opts || {}
  if (!outFile) return null
  const exe = bin || resolveBinaries().ffmpeg
  const want = Math.max(0, Math.round(Number(ms) || 0))
  const scale = `scale=${Math.max(2, Math.round(Number(longEdge) || LONG_EDGE))}:-2:flags=fast_bilinear`
  let q = jpegQscale(quality)

  for (let attempt = 0; attempt < 2; attempt++) {
    // 第二次故意往回退 500ms：ms = durationMs-1（尾帧）这类"请求点在最后一帧之后"的时刻，
    // -ss 精确 seek 找不到任何帧，ffmpeg 会以 mjpeg 的报错退出、一个字节都不写 ——
    // 实测 8s/25fps 的尾帧只在 7.96 存在，7.999 是空的。少 0.5s 可以接受，少一帧不行。
    const at = (attempt === 0 ? want : Math.max(0, want - TAIL_BACKOFF_MS)) / 1000
    try { fs.unlinkSync(outFile) } catch { /* 上一轮没留下文件 */ }
    const r = await runImpl(exe, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', at.toFixed(3),
      '-i', video,
      '-frames:v', '1',
      '-vf', scale,
      '-q:v', String(q),
      '-f', 'image2', outFile,
    ], { timeoutMs })
    const bytes = sizeOf(outFile)
    if (r?.ok && bytes > 0) {
      if (bytes <= maxBytes) {
        const dim = readJpegSize(outFile)
        return { file: outFile, bytes, width: dim?.width ?? 0, height: dim?.height ?? 0 }
      }
      // 超了 2 MiB：降质量重编（qscale 越大质量越低）
      q = Math.min(31, q + 6)
    }
  }
  try { fs.unlinkSync(outFile) } catch { /* 本来就没生成 */ }
  return null
}

/** 一次 fps 全量输出的网格步长：取相邻间隔的中位数，别被个别密集的场景点带偏。 */
function gridStep(times) {
  const deltas = []
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1]
    if (d > 0) deltas.push(d)
  }
  if (!deltas.length) return 1000
  deltas.sort((a, b) => a - b)
  let step = Math.round(deltas[Math.floor(deltas.length / 2)])
  step = Math.max(100, step)
  // 估计输出帧数别爆：网格比计划帧数密 8 倍以上就放松步长（宁可多 seek 几次，别写上千张图）
  const span = Math.max(0, times[times.length - 1] - times[0])
  const budget = times.length * 8 + 100
  if (span / step > budget) step = Math.max(step, Math.ceil(span / budget))
  return step
}

/**
 * 批量抽帧。帧数 < 40 走逐帧 seek（快、少解码）；≥ 40 走一次 fps 全量输出后按时间戳挑
 * （省进程启动；代价是那次全量解码，PROMPT §2.7.4 的取舍）。
 * @param {string} video
 * @param {Array<{ ms: number }>} plan
 * @param {{ ffmpeg?: string, dir?: string, longEdge?: number, quality?: number, maxBytes?: number,
 *   concurrency?: number, onProgress?: Function, timeoutMs?: number, runImpl?: Function }} [opts]
 * @returns {Promise<Array<{ index: number, ms: number, file: string, bytes: number }>>}
 *   index = **plan 里的位置**（个别帧失败只是少一项，其余帧的时间轴映射不错位）
 */
export async function extractFrames(video, plan, opts = {}) {
  const {
    ffmpeg: bin, dir, longEdge = LONG_EDGE, quality = QUALITY, maxBytes = MAX_BYTES,
    concurrency = 4, onProgress, timeoutMs, runImpl = run,
  } = opts || {}
  const exe = bin || resolveBinaries().ffmpeg
  const list = Array.isArray(plan) ? plan : []
  if (!list.length) return []
  const outDir = dir || tmpWorkspace('dsh-video-frames-')
  fs.mkdirSync(outDir, { recursive: true })
  const total = list.length
  const fileFor = (i) => path.join(outDir, `frame_${String(i).padStart(4, '0')}.jpg`)

  const report = (done, index) => {
    if (typeof onProgress !== 'function') return
    try { onProgress({ done, total, index }) } catch { /* 进度回调自己炸了不该影响抽帧 */ }
  }

  const bySeek = async () => {
    const gate = limiter(concurrency)
    const out = []
    let done = 0
    await Promise.all(list.map((item, index) => gate(async () => {
      const ms = Math.max(0, Math.round(Number(item?.ms) || 0))
      const one = await extractFrame(video, ms, {
        ffmpeg: exe, outFile: fileFor(index), longEdge, quality, maxBytes,
        timeoutMs: timeoutMs ?? 60000, runImpl,
      })
      done++
      report(done, index)
      if (one) out.push({ index, ms, file: one.file, bytes: one.bytes })
    })))
    return out.sort((a, b) => a.index - b.index)
  }

  if (total < SEEK_MAX_FRAMES) return bySeek()

  // ≥ 40 帧：一次全量输出。showinfo 让我们拿到每张图**真实**的 pts，
  // 比用 index*step 猜更准（fps 滤镜在首尾会丢/补帧）。
  const times = list.map((item) => Math.max(0, Math.round(Number(item?.ms) || 0)))
  const step = gridStep(times)
  const rate = Number((1000 / step).toFixed(6))
  const batchDir = path.join(outDir, 'batch')
  fs.mkdirSync(batchDir, { recursive: true })
  const pattern = path.join(batchDir, 'b_%05d.jpg')
  const res = await runImpl(exe, [
    '-hide_banner', '-loglevel', 'info', '-y',
    '-i', video,
    '-vf', `fps=${rate},scale=${Math.max(2, Math.round(Number(longEdge) || LONG_EDGE))}:-2:flags=fast_bilinear,showinfo`,
    '-q:v', String(jpegQscale(quality)),
    '-f', 'image2', pattern,
  ], { timeoutMs: timeoutMs ?? MAX_CAPTURE_HINT })

  let files = []
  try {
    files = fs.readdirSync(batchDir).filter((f) => f.endsWith('.jpg')).sort()
  } catch { files = [] }

  if (!res?.ok || !files.length) {
    // 一次全量输出不可用（编解码器不支持 / 输出目录权限 / 片子坏）→ 退回逐帧 seek，
    // 慢但能用。绝不因为"快路径失败"就少给帧。
    try { fs.rmSync(batchDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return bySeek()
  }

  let pts = parseShowinfoPts(res.stderr)
  if (pts.length !== files.length) {
    // 解析不到（loglevel 被改过）→ 用网格反推，不至于整段失败
    pts = files.map((_, i) => i * step)
  }
  const used = new Set()
  const out = []
  const tol = Math.max(1, Math.round(step / 2))
  let done = 0
  for (let index = 0; index < total; index++) {
    const ms = times[index]
    let best = -1
    let bestDiff = Infinity
    for (let i = 0; i < files.length; i++) {
      const d = Math.abs(pts[i] - ms)
      if (d < bestDiff) { bestDiff = d; best = i }
    }
    const target = fileFor(index)
    let picked = null
    if (best >= 0 && bestDiff <= tol && !used.has(best)) {
      used.add(best)
      try {
        fs.copyFileSync(path.join(batchDir, files[best]), target)
        picked = { file: target, bytes: sizeOf(target) }
      } catch { picked = null }
    }
    if (!picked || picked.bytes <= 0 || picked.bytes > maxBytes) {
      // 网格里没有足够近的帧（典型是尾帧 durationMs-1）/ 超 2 MiB → 用 seek 精确补一张
      try { fs.unlinkSync(target) } catch { /* 没生成 */ }
      const one = await extractFrame(video, ms, {
        ffmpeg: exe, outFile: target, longEdge, quality, maxBytes, runImpl,
        timeoutMs: timeoutMs ?? 60000,
      })
      picked = one ? { file: one.file, bytes: one.bytes } : null
    }
    done++
    report(done, index)
    if (picked) out.push({ index, ms, file: picked.file, bytes: picked.bytes })
  }
  try { fs.rmSync(batchDir, { recursive: true, force: true }) } catch { /* 临时文件删不掉不影响结果 */ }
  return out
}
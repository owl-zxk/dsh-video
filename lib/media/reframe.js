// 自适应重采样：窗口校验闸门 + 特写重抽
//
// 这个文件解决的是"模型自己决定看哪里"那一环（PROMPT §2.5）。它只做两件事：
//   ① validateWindow —— 把模型提的窗口请求按闸门筛掉（越界/过短/过长/blur/重复/未知 kind）；
//   ② extractWindow  —— 对通过的窗口在**窗口内**密集重抽，供下一轮只把新帧送回模型。
//
// 为什么闸门要先于抽帧、而且必须是纯函数：
//   模型会反复要同一段（"我看不清右下角的小字"）。不拦住就是死循环 + 烧钱（PROMPT §2.5.3）。
//   校验不碰文件系统、不改入参 seen —— 这样"校验通过了吗"可以在测试里穷举，
//   而 seen 的写入时机留在调用方（哪一轮接受的、要不要回滚），语义清晰。
//
// 为什么特写长边是 2730 而不是 4096（契约 §8 / §19.4）：
//   图片在送到模型前会被压**两次** —— 附件层把超过 4,194,304 像素的图降采样（16:9 下
//   上限约 2730×1536），提供方适配器再按 14px patch 压到 16:9 的 1708×961。
//   所以抽 4096 长边的图，到模型眼前和 2730 的**一模一样**，只是白花解码与磁盘 IO。
//   反过来，对 1280×720 这种低分辨率源，scale 不会放大，首轮抽出来的就已经是原生分辨率 ——
//   于是 reframe 的真收益是**时间密度**（窗口内 0.5s 一帧，看到首轮两帧之间那一刻），
//   不是空间分辨率。想真正看清局部小字要靠 crop，v0.1 明确不做（契约 §19.4），
//   所以本文件也没有任何 crop 参数，别在别处偷偷加。
//
// 为什么单个窗口的帧数还要再卡到 12 张：imageLimits.maxImagesPerMessage = 20，
//   超了直接抛 TOO_MANY_IMAGES。30s 窗口 @0.5s 会抽出 60 张，必须自动放松步长。
import fs from 'node:fs'
import path from 'node:path'
import { run } from './ffmpeg.js'
import { extractFrame, jpegQscale, parseShowinfoPts } from './frames.js'
import { resolveBinaries, tmpWorkspace } from '../util/paths.js'

/** 契约 §8 的闸门默认值，一处定义。 */
export const REFRAME_LIMITS = Object.freeze({
  minWindowMs: 300,
  maxWindowMs: 30000,
  maxReframeWindows: 3,
  closeupLongEdge: 2730,
  quality: 85,
  maxBytes: 2097152,
})

/** 一次请求里的图片数硬上限（适配器 20，留余量给同一批的其它内容）。 */
const MAX_WINDOW_FRAMES = 12
/** 窗口内最密采样间隔：再密就是重复画面，纯粹浪费 token。 */
const MIN_STEP_MS = 100

/** 值得重抽的 kind；blur 单独给固定 reason（内容本身糊了，重抽也没用）。 */
const REFRAME_KINDS = Object.freeze(['detail', 'text', 'motion'])

/**
 * 窗口签名：契约 §8 规定 = floor(start/1000) + ':' + floor(end/1000)。
 * 秒级取整是**故意**粗的 —— 它要拦住的是"换个几十毫秒再来一次"，不是精确去重。
 * （导出它只是方便调用方维护 seen；契约没列这条导出，但形状不变。）
 */
export function windowSignature(startMs, endMs) {
  return `${Math.floor(Number(startMs) / 1000)}:${Math.floor(Number(endMs) / 1000)}`
}

/**
 * 纯函数窗口校验。不改 seen、不抽帧。
 * 判定顺序（越界的请求先死，避免"越界 + blur"给出两种 reason 的不确定性）：
 *   越界 → 过短 → 过长 → kind=blur → 未知 kind → 重复。
 * @param {{ startMs: number, endMs: number, reason?: string, kind?: string }} req
 * @param {{ durationMs: number, limits?: object, seen?: Set<string> }} ctx
 * @returns {{ accepted: true } | { accepted: false, reason: string }}
 */
export function validateWindow(req, ctx = {}) {
  const lim = { ...REFRAME_LIMITS, ...(ctx?.limits || {}) }
  const dur = Number(ctx?.durationMs)
  const start = Number(req?.startMs)
  const end = Number(req?.endMs)
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(start) || !Number.isFinite(end)) {
    return { accepted: false, reason: 'out-of-range' }
  }
  if (start < 0 || end > dur || end <= start) return { accepted: false, reason: 'out-of-range' }
  const len = end - start
  if (len < lim.minWindowMs) return { accepted: false, reason: 'too-short' }
  if (len > lim.maxWindowMs) return { accepted: false, reason: 'too-long' }

  const kind = String(req?.kind ?? 'detail').trim().toLowerCase() || 'detail'
  if (kind === 'blur') return { accepted: false, reason: 'kind-blur' }
  if (!REFRAME_KINDS.includes(kind)) return { accepted: false, reason: 'unknown-kind' }

  const seen = ctx?.seen
  if (seen && typeof seen.has === 'function' && seen.has(windowSignature(start, end))) {
    return { accepted: false, reason: 'duplicate' }
  }
  return { accepted: true }
}

/**
 * 特写重抽一个窗口内的帧（升序）。
 * -ss/-to 放在 -i **之前** = 快速定位，比 -vf select 快得多（PROMPT §2.5.2）。
 * 一帧都抽不到（窗口太短、fps 滤镜一个 tick 都没到、ffmpeg 直接报 "Output file ... does not contain any stream"）
 * 必须退回抽窗口中间那一帧 —— 短窗口（300–500 ms）会稳定走到这条路，不能空手而归。
 * @param {string} video
 * @param {{ startMs: number, endMs: number }} win
 * @param {{ ffmpeg?: string, dir?: string, stepMs?: number, longEdge?: number, quality?: number,
 *   maxBytes?: number, timeoutMs?: number, runImpl?: Function }} [opts]
 * @returns {Promise<Array<{ ms: number, file: string, bytes: number }>>}
 */
export async function extractWindow(video, win, opts = {}) {
  const {
    ffmpeg: bin, dir, stepMs = 500,
    longEdge = REFRAME_LIMITS.closeupLongEdge,
    quality = REFRAME_LIMITS.quality,
    maxBytes = REFRAME_LIMITS.maxBytes,
    timeoutMs = 120000, runImpl = run,
  } = opts || {}
  const exe = bin || resolveBinaries().ffmpeg
  const startMs = Math.max(0, Math.round(Number(win?.startMs) || 0))
  const endMs = Math.max(startMs, Math.round(Number(win?.endMs) || 0))
  const span = endMs - startMs
  if (span <= 0) return []

  const outDir = dir || tmpWorkspace('dsh-video-window-')
  fs.mkdirSync(outDir, { recursive: true })

  // 帧数上限倒推进步长：既尊重调用方要的密度，又不让单个窗口的图数超过 12
  const wanted = Math.max(MIN_STEP_MS, Math.round(Number(stepMs) || 500))
  const capStep = Math.ceil(span / MAX_WINDOW_FRAMES)
  const step = Math.max(wanted, capStep)

  const batchDir = path.join(outDir, 'batch')
  fs.mkdirSync(batchDir, { recursive: true })
  const res = await runImpl(exe, [
    '-hide_banner', '-loglevel', 'info', '-y',
    '-ss', (startMs / 1000).toFixed(3),
    '-to', (endMs / 1000).toFixed(3),
    '-i', video,
    '-vf', `fps=${Number((1000 / step).toFixed(6))},scale=${Math.max(2, Math.round(Number(longEdge) || REFRAME_LIMITS.closeupLongEdge))}:-2:flags=fast_bilinear,showinfo`,
    '-q:v', String(jpegQscale(quality)),
    '-f', 'image2', path.join(batchDir, 'w_%05d.jpg'),
  ], { timeoutMs })

  let files = []
  try {
    files = fs.readdirSync(batchDir).filter((f) => f.endsWith('.jpg')).sort()
  } catch { files = [] }

  const frames = []
  if (res?.ok && files.length) {
    let pts = parseShowinfoPts(res.stderr)
    // -ss 在 -i 之前 → showinfo 的 pts_time 是**相对 seek 点**的（实测 0/0.5/1.0）
    if (pts.length !== files.length) pts = files.map((_, i) => i * step)
    for (let i = 0; i < files.length && frames.length < MAX_WINDOW_FRAMES; i++) {
      const ms = Math.min(endMs, Math.max(startMs, startMs + pts[i]))
      const file = path.join(batchDir, files[i])
      const bytes = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
      if (bytes > 0 && bytes <= maxBytes) frames.push({ ms, file, bytes })
    }
  }
  if (frames.length) {
    // 先把批次文件搬到稳定名字，再删批次目录 —— 反过来做，重命名会撞上"源已消失"，
    // 返回的 file 就是一条指向已经不存在目录的死路径（实测踩过）。
    const moved = frames
      .sort((a, b) => a.ms - b.ms)
      .map((f) => ({ ms: f.ms, file: renameInto(f.file, path.join(outDir, `w_${String(f.ms).padStart(6, '0')}.jpg`)), bytes: f.bytes }))
    try { fs.rmSync(batchDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return moved
  }
  try { fs.rmSync(batchDir, { recursive: true, force: true }) } catch { /* 忽略 */ }

  // 兜底：一帧都没抽到 → 抽窗口中间那一帧（-ss mid -frames:v 1）
  const midMs = Math.round((startMs + endMs) / 2)
  const one = await extractFrame(video, midMs, {
    ffmpeg: exe, outFile: path.join(outDir, 'mid.jpg'), longEdge, quality, maxBytes, runImpl,
  })
  return one ? [{ ms: midMs, file: one.file, bytes: one.bytes }] : []
}

/** 把临时批次文件搬到稳定文件名（批次目录会被删掉，路径不能留在结果里）。 */
function renameInto(from, to) {
  try {
    fs.renameSync(from, to)
    return to
  } catch {
    try {
      fs.copyFileSync(from, to)
      return to
    } catch {
      return from
    }
  }
}
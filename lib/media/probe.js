// ffprobe → Meta。只做一件事：把 ffprobe 的 JSON 变成契约 §6 那个固定形状。
//
// 为什么 parseProbe 要单独导出成纯函数：ffprobe 的 JSON 形状随版本/容器变化
//   （duration 有时在 format、有时只在 stream；avg_frame_rate 是 '25/1' 这种分数；
//   有些字段是 'N/A' 字符串而不是数字）。把这些坑放进纯函数，测试就能拿真实 JSON
//   片段直接断言，不用为了一个边界情况去造一个畸形视频。
//
// 为什么"无音轨"是正常情况：静音视频、纯画面录屏、GIF 转 MP4 都没有音轨。
//   契约 §6 明确 hasAudio:false 且**绝不抛**；只有"没有视频流"才算错误（NO_VIDEO_STREAM，
//   例如用户把 mp3 丢进来）。
//
// 为什么跳过 attached_pic：mp3/m4a 的封面图也是一条 codec_type=video 的流，
//   不跳过的话一个纯音频文件会变成"有视频、宽高等于封面尺寸"，下游会去抽帧抽出一张专辑封面。
import { ffprobeJSON } from './ffmpeg.js'
import { resolveBinaries } from '../util/paths.js'

const toNum = (v) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

/** '30000/1001' → 29.97；'25' → 25；'0/0' → 0 */
function parseRate(rate) {
  const s = String(rate ?? '').trim()
  if (!s || s === 'N/A') return 0
  const i = s.indexOf('/')
  if (i < 0) return Math.round(toNum(s) * 1000) / 1000
  const num = toNum(s.slice(0, i))
  const den = toNum(s.slice(i + 1))
  if (!den) return 0
  return Math.round((num / den) * 1000) / 1000
}

/** 真正的视频流：codec_type=video 且不是封面图。 */
function videoStream(json) {
  const list = Array.isArray(json?.streams) ? json.streams : []
  return list.find((s) => s?.codec_type === 'video' && s?.disposition?.attached_pic !== 1) ?? null
}

/**
 * 纯函数：ffprobe JSON → Meta（契约 §6）。
 * @param {any} json
 * @returns {{ durationMs: number, width: number, height: number, fps: number, hasAudio: boolean,
 *   videoCodec: string|null, audioCodec: string|null, sampleRate: number, channels: number, sizeBytes: number }}
 */
export function parseProbe(json) {
  const v = videoStream(json)
  if (!v) {
    const err = new Error('没有视频流（是不是把纯音频文件传进来了？）')
    err.code = 'NO_VIDEO_STREAM'
    throw err
  }
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const audio = streams.find((s) => s?.codec_type === 'audio') ?? null
  const fmt = json?.format ?? {}

  // duration 优先 format（容器总时长），退回视频流自己的 duration
  let sec = toNum(fmt.duration)
  if (!sec) sec = toNum(v.duration)
  if (!sec) sec = toNum(fmt.duration_ts)
  const durationMs = Math.max(0, Math.round(sec * 1000))

  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate)

  return {
    durationMs,
    width: Math.max(0, Math.round(toNum(v.width))),
    height: Math.max(0, Math.round(toNum(v.height))),
    fps,
    hasAudio: !!audio,
    videoCodec: v.codec_name ? String(v.codec_name) : null,
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
    sampleRate: Math.max(0, Math.round(toNum(audio?.sample_rate))),
    channels: Math.max(0, Math.round(toNum(audio?.channels))),
    sizeBytes: Math.max(0, Math.round(toNum(fmt.size))),
  }
}

/**
 * 读容器/流元信息。无视频流 → throw（code='NO_VIDEO_STREAM'）；无音轨 → hasAudio:false。
 * @param {string} file
 * @param {{ ffprobe?: string, timeoutMs?: number, signal?: AbortSignal, runImpl?: Function }} [opts]
 */
export async function probe(file, opts = {}) {
  const { ffprobe: bin, timeoutMs = 30000, signal, runImpl } = opts || {}
  const ffprobeBin = bin || resolveBinaries().ffprobe
  const json = await ffprobeJSON(ffprobeBin, [
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeoutMs, signal, runImpl })
  if (!json) {
    const err = new Error(`ffprobe 读不出元信息：${file}`)
    err.code = 'PROBE_FAILED'
    throw err
  }
  return parseProbe(json)
}

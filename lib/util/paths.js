// 二进制 / 模型路径解析 —— 这里有一张默认值表，其它模块一律不许再拼绝对路径
//
// 为什么单开一个文件、还要拆成 resolve/require 两个函数：
//   ① 早期文档把 whisper 写成一个固定的用户主目录路径，但实际部署里它常和 $DSH_HOME 分叉
//      （宿主半边用 DSH_HOME，旧工具链各自拼 $HOME/.dsh）→ 两边一旦分叉就读不到模型。
//      所以这里只解析一次、全程靠推导，**不写死任何绝对路径**。
//   ② 找不到二进制不许在模块顶层抛：插件 import 阶段崩掉，DSH 启动就挂。于是
//      resolveBinaries() 永不抛（找不到也返回"候选"，好让报错信息里有东西可指），
//      requireBinaries() 才抛，且带 code='BINARY_MISSING'，上层能据此降级成 failures。
//   ③ 契约 §1 禁止在 lib/ 里写死绝对路径，所以绝对路径只允许出现在本文件的默认值表里。
//
// 解析优先级（每个二进制都一样）：显式 config > 环境变量 > PATH > $DSH_HOME 默认。
// 两级遍历：先按优先级找"真实存在"的，一个都不存在时才退回"最高优先级候选"（仅用于报错展示）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，与 dsh-bili-whale/tools/lib/paths.mjs 保持一致）。 */
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：环境变量优先，否则 %USERPROFILE%\\.dsh。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

const WIN = process.platform === 'win32'
const exe = (name) => (WIN ? `${name}.exe` : name)

const isFile = (f) => {
  try { return !!f && fs.statSync(f).isFile() } catch { return false }
}

const isDir = (d) => {
  try { return !!d && fs.statSync(d).isDirectory() } catch { return false }
}

/** PATH 里找可执行文件（Windows 不认 PATHEXT 之外的细节，这里只按名字拼）。 */
function onPath(name) {
  const target = exe(name)
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const f = path.join(d, target)
    if (isFile(f)) return f
  }
  return null
}

/**
 * 候选表求值：thunk 惰性求值，避免每次都去扫一遍 PATH。
 * 第一轮只看真实存在的；都不存在时第二轮退回最高优先级候选（可能不存在）。
 */
function take(thunks, check = isFile) {
  const values = []
  for (const t of thunks) {
    let v = null
    try { v = t() } catch { v = null }
    values.push(v && String(v).trim() ? String(v).trim() : null)
  }
  return values.find((v) => v && check(v)) ?? values.find(Boolean) ?? null
}

const WHISPER_DIR = path.join(DSH_HOME, 'voice', 'whisper')

/**
 * 默认值表 —— **全部由 DSH_HOME 推导，没有一处硬编码绝对路径**。
 *
 * 这两个位置（$DSH_HOME/bili-whale/bin、$DSH_HOME/voice/whisper）是常见部署的**便利回退**，
 * 不是假设：resolveBinaries 的解析顺序里，显式 config 与环境变量都排在它们前面，PATH 并列查找。
 * 换一台机器、换了目录结构，只要 ffmpeg/whisper 在 PATH 里或配了环境变量，一样能用。
 */
export const DEFAULT_BINARIES = Object.freeze({
  ffmpeg: path.join(DSH_HOME, 'bili-whale', 'bin', exe('ffmpeg')),
  ffprobe: path.join(DSH_HOME, 'bili-whale', 'bin', exe('ffprobe')),
  whisperBin: path.join(WHISPER_DIR, 'bin', 'Release', exe('whisper-cli')),
  whisperDir: WHISPER_DIR,
})

/**
 * 三档 detail 都默认同一个模型（契约 §2）。provider 由 splitRoute 拆。
 *
 * ⚠️ 2026-10-31 实测改正（PROMPT.md §0 的写法在这台机器上跑不通）：
 *   本机 provider 叫 **deepseek-account**（profile 的 agent-default-model 就是它），
 *   而适配器自带目录里的模型 id 是 **deepseek-flash**（name: DeepSeek-V4.1-Flash，
 *   inputModalities: ["text","image"]，见 dsh-llm-deepseek/lib/index.js:19-25）。
 *   写 'deepseek/deepseek-v4.1-flash' 会得到 NO_ADAPTER —— 那个 provider 根本不存在。
 *   已实测：deepseek-account/deepseek-flash 能出画面描述。
 * 换机器/换账号时要改这里，或者直接用 config.model 覆盖（推荐后者）。
 */
export const DEFAULT_MODELS = Object.freeze({
  quick: 'deepseek-account/deepseek-flash',
  standard: 'deepseek-account/deepseek-flash',
  deep: 'deepseek-account/deepseek-flash',
})

/**
 * 解析二进制/模型目录。**永不抛**：找不到就给候选路径（调用方靠 requireBinaries 判死）。
 * @param {{ ffmpeg?: string, ffprobe?: string, whisperBin?: string, whisperDir?: string }} [config]
 * @returns {{ ffmpeg: string|null, ffprobe: string|null, whisperBin: string|null, whisperDir: string|null }}
 */
export function resolveBinaries(config = {}) {
  const c = config || {}
  const whisperDir = take([
    () => c.whisperDir,
    () => process.env.DSH_VIDEO_WHISPER_DIR,
    () => DEFAULT_BINARIES.whisperDir,
  ], isDir)
  const ffmpeg = take([
    () => c.ffmpeg,
    () => process.env.DSH_VIDEO_FFMPEG,
    () => process.env.FFMPEG,
    // PATH 排在推导出的默认位置之前：用户系统里装好了 ffmpeg，就不该被我们猜的那个目录盖掉
    () => onPath('ffmpeg'),
    () => DEFAULT_BINARIES.ffmpeg,
  ])
  const ffprobe = take([
    () => c.ffprobe,
    () => process.env.DSH_VIDEO_FFPROBE,
    () => process.env.FFPROBE,
    () => onPath('ffprobe'),
    () => DEFAULT_BINARIES.ffprobe,
  ])
  // whisper-cli 的历史名字是 main（旧构建），两个都试；目录跟着 whisperDir 走。
  const whisperBin = take([
    () => c.whisperBin,
    () => process.env.DSH_VIDEO_WHISPER_BIN,
    // 同样把 PATH 提前：whisper-cli 装进系统 PATH 的人不该被 $DSH_HOME 里的旧构建顶掉
    () => onPath('whisper-cli'),
    () => onPath('main'),
    () => (whisperDir ? path.join(whisperDir, 'bin', 'Release', exe('whisper-cli')) : null),
    () => (whisperDir ? path.join(whisperDir, 'bin', 'Release', exe('main')) : null),
    () => (whisperDir ? path.join(whisperDir, exe('whisper-cli')) : null),
  ])
  return { ffmpeg, ffprobe, whisperBin, whisperDir }
}

/**
 * 同 resolveBinaries，但 ffmpeg / ffprobe 缺失时抛错。
 * 只卡这两个：whisper 缺失是"没有转录"，属于可降级情况，不该让整个工具挂掉。
 * @returns {{ ffmpeg: string, ffprobe: string, whisperBin: string|null, whisperDir: string|null }}
 */
export function requireBinaries(config = {}) {
  const bins = resolveBinaries(config)
  const missing = []
  if (!isFile(bins.ffmpeg)) missing.push(`ffmpeg → ${bins.ffmpeg ?? '（未解析到候选）'}`)
  if (!isFile(bins.ffprobe)) missing.push(`ffprobe → ${bins.ffprobe ?? '（未解析到候选）'}`)
  if (!missing.length) return bins
  const err = new Error([
    '找不到 ffmpeg / ffprobe（抽帧与元信息需要它们）。任选一种解决：',
    '  ① 装一个：winget install ffmpeg（或 scoop install ffmpeg）',
    '  ② 环境变量指定：DSH_VIDEO_FFMPEG / DSH_VIDEO_FFPROBE（其次 FFMPEG / FFPROBE）',
    `  ③ 放到默认位置：${DEFAULT_BINARIES.ffmpeg}`,
    '当前解析结果：',
    ...missing.map((m) => `  · ${m}`),
  ].join('\n'))
  err.code = 'BINARY_MISSING'
  err.missing = missing
  throw err
}

/** <dir>/ggml-<name>.bin；顺手容忍传进来的名字已经带 ggml- 前缀或 .bin 后缀。 */
export function whisperModelPath(dir, name) {
  const n = String(name || 'base').replace(/^ggml-/, '').replace(/\.bin$/i, '')
  const d = dir || DEFAULT_BINARIES.whisperDir
  return path.join(d, `ggml-${n}.bin`)
}

/**
 * 真实存在的模型名：prefer 优先，退回 small > base（契约 §3）。
 * 一个都没有时返回 null —— 不编一个假名字回去，上层要据此把转录记为 failures。
 * @returns {string|null}
 */
export function existingModel(dir, prefer) {
  const d = dir || DEFAULT_BINARIES.whisperDir
  const want = prefer ? String(prefer).replace(/^ggml-/, '').replace(/\.bin$/i, '') : null
  if (want && isFile(whisperModelPath(d, want))) return want
  for (const n of ['small', 'base']) {
    if (isFile(whisperModelPath(d, n))) return n
  }
  return null
}

/** fs.mkdtempSync 建临时目录；prefix 里的路径分隔符一律替换掉（mkdtemp 会把它们当路径）。 */
export function tmpWorkspace(prefix = 'dsh-video-') {
  const safe = String(prefix || 'dsh-video-').replace(/[\\/:*?"<>|]/g, '-')
  return fs.mkdtempSync(path.join(os.tmpdir(), safe))
}

/**
 * 'deepseek/deepseek-v4.1-flash' → { provider:'deepseek', model:'deepseek-v4.1-flash' }
 * 没有斜杠时 provider 取 config.provider，再缺省 'deepseek'；只按**第一个**斜杠拆，
 * 因为模型名本身可能带斜杠（如 provider/model:batch 变体）。
 * @param {string} model
 * @param {{ provider?: string }} [config]
 */
export function splitRoute(model, config = {}) {
  const raw = String(model ?? '').trim()
  const fallback = String(config?.provider ?? '').trim() || 'deepseek'
  if (!raw) return { provider: fallback, model: '' }
  const i = raw.indexOf('/')
  if (i < 0) return { provider: fallback, model: raw }
  const provider = raw.slice(0, i).trim() || fallback
  return { provider, model: raw.slice(i + 1).trim() }
}

// 设置项的读写与合并 —— **纯逻辑**，磁盘和 env 都可注入，所以不用碰真实文件就能测。
//
// 为什么单独一个文件而不是塞进 lib/index.js：
//   入口的职责是「装配」，而这里全是「优先级、白名单、类型校验、原子写」这种有分支的规则。
//   塞进入口就没法单测了，而这里恰恰是最需要单测的地方（写坏了会静默改掉用户配置）。
//
// 优先级（高 → 低），这是本文件唯一需要记住的东西：
//   dsh-video.config.json  >  环境变量 DSH_VIDEO_*  >  profile 里的 cordis config  >  内置默认
//   把文件放最高，是因为「设置界面改完要立刻生效」——用户点了保存，下一次调用就必须用新值。
//
// 二进制路径的 env 由 lib/util/paths.js 的 resolveBinaries 自己处理（它内部顺序就是
//   config > env > $DSH_HOME 默认 > PATH），这里**不重复实现**，否则两处顺序会打架。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DSH_HOME, DEFAULT_MODELS, resolveBinaries } from './util/paths.js'

/** 配置文件位置：$DSH_HOME/dsh-video.config.json（与 bili-whale 的 config 同目录、同风格）。 */
export const CONFIG_FILE = path.join(DSH_HOME, 'dsh-video.config.json')

export const DEFAULT_DETAIL = 'standard'
export const DEFAULT_MAX_WALL_CLOCK_MS = 300000

/**
 * 可编辑字段的白名单 —— **唯一的真相**。
 * 客户端那个表格也从这里取（GET 会把它带回去），所以加字段只改这一处。
 * kind: 'string' | 'path' | 'enum' | 'int'
 */
export const EDITABLE = Object.freeze({
  model: { kind: 'string', env: 'DSH_VIDEO_MODEL', label: '视觉模型', hint: '形如 provider/model。必须吃图，否则会在送图前明确报 MODEL_NOT_VISION。' },
  detail: { kind: 'enum', env: 'DSH_VIDEO_DETAIL', values: ['quick', 'standard', 'deep'], label: '默认档位', hint: '工具调用时可以单独覆盖；这里只是「不给 detail 时」的默认。' },
  concurrency: { kind: 'int', env: 'DSH_VIDEO_CONCURRENCY', min: 1, max: 32, label: '并发度', hint: '视觉批次 / whisper 分块同时在飞的请求上限。不给按 CPU 核数推导。' },
  maxWallClockMs: { kind: 'int', env: 'DSH_VIDEO_MAX_WALL_CLOCK_MS', min: 1000, max: 3600000, label: '墙钟上限（毫秒）', hint: '只管模型调用阶段。抽帧与转写不受它约束（抽帧影响帧数，不许降）。' },
  lang: { kind: 'string', env: 'DSH_VIDEO_LANG', label: '音频语言', hint: '默认 zh。不要用 auto：中文会被误判成粤语/日文。' },
  ffmpeg: { kind: 'path', env: 'DSH_VIDEO_FFMPEG', label: 'ffmpeg 路径', hint: '留空则按 DSH_VIDEO_FFMPEG > FFMPEG > $DSH_HOME 默认 > PATH 解析。' },
  ffprobe: { kind: 'path', env: 'DSH_VIDEO_FFPROBE', label: 'ffprobe 路径', hint: '留空则按环境变量 > $DSH_HOME 默认 > PATH 解析。' },
  whisperBin: { kind: 'path', env: 'DSH_VIDEO_WHISPER_BIN', label: 'whisper-cli 路径', hint: '留空则跟着 whisperDir 推导。缺失只是没有转录，不影响画面分析。' },
  whisperDir: { kind: 'path', env: 'DSH_VIDEO_WHISPER_DIR', label: 'whisper 模型目录', hint: '放 ggml-*.bin 的目录。quick 档找 base，其余找 small。' },
})

/** 模型候选（下拉用）。note 会显示在 hint 里，是实测结论不是营销词。 */
export const MODEL_CANDIDATES = Object.freeze([
  Object.freeze({
    value: 'deepseek-account/deepseek-flash',
    label: 'DeepSeek-V4.1-Flash（推荐）',
    note: '官方路由。实测视觉阶段快 6.8 倍、幻觉更少，且宿主有完整 image token 计算器所以成本能算准。',
  }),
  Object.freeze({
    value: 'minimax-cn/MiniMax-M3',
    label: 'MiniMax-M3',
    note: '画面文字召回更高，但慢约 1.9 倍、偶发编造（COVACS / 地堡回洗的渐溪 之类），且无 token 计算器 → 成本不可算。',
  }),
])

/** 默认 io（测试注入替身；生产就是 node:fs 本身）。 */
export function createIo (overrides = {}) {
  return {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
    ...overrides,
  }
}

/**
 * 读配置文件。**永不抛**：不存在 / 坏 JSON / 不是对象 都退回 {}，并把原因带出来。
 * 为什么不抛：一个手改坏的文件不该让整个插件加载失败——设置界面自己会把这个 error 显示出来。
 * @returns {{ config: object, error: string|null }}
 */
export function readConfigFile (file = CONFIG_FILE, io = createIo()) {
  let text
  try {
    if (!io.existsSync(file)) return { config: {}, error: null }
    text = io.readFileSync(file, 'utf8')
  } catch (err) {
    return { config: {}, error: '读取失败：' + String(err?.message ?? err) }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, error: '配置文件顶层必须是对象' }
    }
    return { config: parsed, error: null }
  } catch (err) {
    return { config: {}, error: 'JSON 解析失败：' + String(err?.message ?? err) }
  }
}

/**
 * 校验一份「待写入的补丁」。
 * 规则（照 brief）：
 *   · 未知字段 **丢弃**（不是报错——客户端多送一个字段不该让保存失败）
 *   · 类型/范围不对 **返回 error**（不能静默吞，否则用户以为存上了）
 *   · 空字符串 = 清除该字段（回到 env / 默认），所以映射成 null，由 mergeConfig 删除
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function validatePatch (incoming) {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ok: false, error: '请求体必须是对象' }
  }
  const patch = {}
  const problems = []
  for (const [key, raw] of Object.entries(incoming)) {
    const field = EDITABLE[key]
    if (field === undefined) continue                      // 未知字段：丢弃，不报错
    if (raw === null || raw === undefined) { patch[key] = null; continue }
    // 空串统一表示「清除」——必须在按类型分支**之前**判断。
    // 否则输入框被清空时，concurrency 会先被 Number('') 变成 0，然后撞上 min 校验，
    // 用户看到的是"并发度必须在 1–32 之间"，而他只是想把这一项清掉。
    if (typeof raw === 'string' && raw.trim() === '') { patch[key] = null; continue }
    if (field.kind === 'int') {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(num)) { problems.push(key + ' 必须是数字，收到 ' + JSON.stringify(raw)); continue }
      const int = Math.floor(num)
      if (int < field.min || int > field.max) {
        problems.push(key + ' 必须在 ' + field.min + '–' + field.max + ' 之间，收到 ' + int)
        continue
      }
      patch[key] = int
      continue
    }
    if (typeof raw !== 'string') { problems.push(key + ' 必须是字符串，收到 ' + JSON.stringify(raw)); continue }
    const text = raw.trim()
    if (text === '') { patch[key] = null; continue }        // 空 = 清除
    if (field.kind === 'enum') {
      if (!field.values.includes(text)) {
        problems.push(key + ' 只能是 ' + field.values.join(' / ') + '，收到 ' + JSON.stringify(text))
        continue
      }
      patch[key] = text
      continue
    }
    patch[key] = text
  }
  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  return { ok: true, patch }
}

/** 合并补丁：patch 里为 null 的键表示「删掉」。返回新对象，不改入参。 */
export function mergeConfig (current, patch) {
  const next = { ...(current !== null && typeof current === 'object' ? current : {}) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

/** 环境变量覆盖：只在**文件里没有该项**时才生效（文件优先级更高）。 */
export function envOverrides (fromFile, env = process.env) {
  const out = {}
  for (const [key, field] of Object.entries(EDITABLE)) {
    if (fromFile !== null && typeof fromFile === 'object' && Object.prototype.hasOwnProperty.call(fromFile, key)) continue
    const raw = env?.[field.env]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const text = String(raw).trim()
    if (field.kind === 'int') {
      const num = Number(text)
      if (Number.isFinite(num)) out[key] = Math.floor(num)
      continue
    }
    if (field.kind === 'enum' && !field.values.includes(text)) continue
    out[key] = text
  }
  return out
}

/**
 * 算出「此刻真正生效的配置」。
 * 顺序：base（cordis config）→ 文件覆盖 → 环境变量补齐 → 字段级清洗。
 * @returns {{ config: object, fileConfig: object, fileError: string|null, configPath: string }}
 */
export function loadEffective ({ file = CONFIG_FILE, env = process.env, base = {}, io = createIo() } = {}) {
  const { config: fileConfig, error: fileError } = readConfigFile(file, io)
  const merged = { ...(base !== null && typeof base === 'object' ? base : {}), ...fileConfig }
  const fromEnv = envOverrides(merged, env)
  const config = { ...merged }
  for (const [key, value] of Object.entries(fromEnv)) config[key] = value
  return { config: sanitize(config), fileConfig, fileError, configPath: file }
}

/**
 * 字段级清洗（类型不对就当没给）。与 lib/index.js 里那份 normalizeConfig 的取向一致：
 * 能力层只该看到「一个可信的对象」，坏值在这里就被丢掉，不要让它跑到管线里。
 */
export function sanitize (config) {
  const out = {}
  const src = config !== null && typeof config === 'object' ? config : {}
  for (const [key, field] of Object.entries(EDITABLE)) {
    const value = src[key]
    if (field.kind === 'int') {
      if (Number.isFinite(value) && value >= field.min && value <= field.max) out[key] = Math.floor(value)
    } else if (field.kind === 'enum') {
      if (typeof value === 'string' && field.values.includes(value)) out[key] = value
    } else if (typeof value === 'string' && value.trim() !== '') {
      out[key] = value.trim()
    }
  }
  if (src.pricing !== null && typeof src.pricing === 'object' && !Array.isArray(src.pricing)) out.pricing = { ...src.pricing }
  return out
}

/** 并发度推导：与 understand.js 里的 defaultConcurrency 保持一致（这里只用于展示）。 */
export function deriveConcurrency (cpus = os.cpus().length) {
  return Math.min(4, Math.max(2, cpus - 2))
}

/**
 * 给 GET 用的「解析后结果」：把回落算出来，让界面能显示实际生效值而不是一堆空。
 * @param {object} config 已经 sanitize 过的生效配置
 * @param {{ cpus?: number, binaries?: object }} [opts]
 */
export function resolveDisplay (config, { cpus, binaries } = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const detail = cfg.detail ?? DEFAULT_DETAIL
  const resolved = {
    model: cfg.model ?? DEFAULT_MODELS[detail] ?? DEFAULT_MODELS[DEFAULT_DETAIL],
    detail,
    concurrency: cfg.concurrency ?? deriveConcurrency(typeof cpus === 'number' ? cpus : os.cpus().length),
    maxWallClockMs: cfg.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
    lang: cfg.lang ?? 'zh',
  }
  const bins = binaries ?? resolveBinaries(cfg)
  resolved.ffmpeg = bins.ffmpeg ?? null
  resolved.ffprobe = bins.ffprobe ?? null
  resolved.whisperBin = bins.whisperBin ?? null
  resolved.whisperDir = bins.whisperDir ?? null
  return resolved
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 * 为什么必须原子：设置界面是 POST 一次写整份；直接 writeFileSync 在写到一半崩掉时
 * 会留下半截 JSON —— 下一次读取就变成「配置丢了」，而且用户以为保存成功过。
 */
export function writeConfigAtomic (file, config, io = createIo()) {
  const dir = path.dirname(file)
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  io.mkdirSync(dir, { recursive: true })
  io.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  try {
    io.renameSync(tmp, file)
  } catch (err) {
    try { io.writeFileSync(tmp, '', 'utf8') } catch { /* 清理失败不重要 */ }
    throw err
  }
  return file
}

/**
 * 保存一份补丁：读现有文件 → 校验 → 合并 → 原子写 → 返回新配置。
 * @returns {{ ok: true, config: object, configPath: string } | { ok: false, error: string, status: number }}
 */
export function savePatch ({ incoming, file = CONFIG_FILE, io = createIo() } = {}) {
  const verdict = validatePatch(incoming)
  if (!verdict.ok) return { ok: false, error: verdict.error, status: 400 }
  const current = readConfigFile(file, io)
  if (current.error !== null) return { ok: false, error: '现有配置文件有问题，先修好再保存：' + current.error, status: 409 }
  const next = mergeConfig(current.config, verdict.patch)
  try {
    writeConfigAtomic(file, next, io)
  } catch (err) {
    return { ok: false, error: '写入失败：' + String(err?.message ?? err), status: 500 }
  }
  return { ok: true, config: next, configPath: file }
}

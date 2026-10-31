// 插件入口 —— **只做装配**（PROMPT §1）
//
// 为什么这里一行业务逻辑都不许有：入口是「加一项能力时唯一不用改的文件」。
// 一旦开始在这里写管线，第二项能力就得复制一遍，事故也会全部集中在这一个文件里。
// 所以它只干四件事：解析 config → 建 registry → 把每项能力转成工具定义 → 注册到 ctx.tools。
//
// ── 为什么这里一个 '@deepseek-ai/*' 静态 import 都没有（2026-10-31 实测改的）────────────
// 曾经的写法是 import z from schemastery + defineTool from dsh-tools + BlockAssembler from dsh-llm。
// 装上之后 DSH 日志里是：
//     dsh-video (dsh-video): failed to import: ERR_MODULE_NOT_FOUND:
//     Cannot find package '@deepseek-ai/schemastery'
//     imported from <插件目录>\lib\index.js
// 原因：宿主给插件的 ESM 解析插桩（dsh-app-boot 的 findInterceptionLayer / linkedPaths）
// **没有覆盖到 junction 指向的 workspace 路径**。本机两个 junction 插件
// （dsh-lanpangzi / dsh-bili-whale）之所以能用，是因为它们根本不需要那几个包。
// 所以：装配层零 '@deepseek-ai/*' 静态依赖，是「这个插件能被加载」的前提，不是风格偏好。
//
// 三个替代（都不是降级，是等价物）：
//   · schemastery  → 顶层 await 动态 import，拿得到就有 Config schema，拿不到就是 undefined。
//                    cordis 允许插件不导出 Config，config 仍会原样传进 apply()，
//                    校验交给下面的 normalizeConfig（它本来就在做类型过滤）。
//   · defineTool   → ctx.tools.register() 只要求 { name, output: { schema, render } }
//                    （见 dsh-tools/lib/index.js 的 register 实现），defineTool 只是
//                    「属性级 required → 标准 JSON Schema」的编译器，这里自己转一份。
//   · BlockAssembler → vision.js 支持不注入时退回本地累加器，不传即可。

import { capabilities } from './capabilities/index.js'
import { createRegistry } from './capabilities/registry.js'
import { resolveBinaries } from './util/paths.js'
import { CONFIG_FILE, MODEL_CANDIDATES, createIo, loadEffective, resolveDisplay, savePatch } from './settings-api.js'
import { createVideoService } from './service.js'

/** Cordis 插件名（也是 profile 里那一行的 id）。 */
export const name = 'dsh-video'

/** 尽力拿 schemastery：拿不到不影响加载，只是少了 Config schema。 */
let schemaLib = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  schemaLib = mod.default ?? mod
} catch {
  schemaLib = null
}

/** 插件配置的字段与描述（契约 §3 的形状，全部 optional）。 */
const CONFIG_FIELDS = {
  ffmpeg: 'ffmpeg 可执行文件路径。不给则按 DSH_VIDEO_FFMPEG > FFMPEG > $DSH_HOME 默认 > PATH 解析',
  ffprobe: 'ffprobe 可执行文件路径。不给则按 DSH_VIDEO_FFPROBE > FFPROBE > $DSH_HOME 默认 > PATH 解析',
  whisperBin: 'whisper-cli 可执行文件路径。缺失只是没有转录（进 failures），不影响画面分析',
  whisperDir: 'whisper 模型目录（放 ggml-*.bin）；quick 档找 base，其余找 small',
  provider: '默认 provider。model 里带斜杠时以斜杠前为准，缺省 deepseek',
  model: '默认视觉模型 provider/model。必须吃图，否则明确失败而不是静默降级',
  concurrency: '并发度（视觉批次 / whisper 分块）。不给按 CPU 核数推导',
  maxWallClockMs: '模型调用阶段的墙钟上限（毫秒），默认 300000。超时返回已完成部分并在 failures 里说明'
}

function buildConfigSchema () {
  if (schemaLib === null || typeof schemaLib.object !== 'function') return undefined
  try {
    const shape = {}
    for (const [key, description] of Object.entries(CONFIG_FIELDS)) {
      shape[key] = key === 'concurrency' || key === 'maxWallClockMs'
        ? schemaLib.number().description(description)
        : schemaLib.string().description(description)
    }
    shape.lang = schemaLib.string().default('zh').description('音频语言。不要用 auto：中文会被误判成粤语/日文')
    shape.pricing = schemaLib.object({
      inputPerMillion: schemaLib.number().description('输入价（美元/百万 token）'),
      outputPerMillion: schemaLib.number().description('输出价（美元/百万 token）')
    }).description('费率覆盖。不给就用 lib/llm/budget.js 的内置费率表；逐字段回落，半张价格表不会把成本算成一半')
    return schemaLib.object(shape)
  } catch {
    return undefined
  }
}

export const Config = buildConfigSchema()

export const inject = ['tools', 'llm', 'attachments']
/* ────────────────────── 即时生效的配置 + 设置界面用的 HTTP 层 ────────────────────── */
//
// 为什么要「每次 execute 现取」而不是 apply 时解析一次：
//   设置界面保存后只写一个 JSON 文件，宿主不会因此重载插件。如果 config 在 apply 时就冻结，
//   用户改完模型 / 档位 / 并发之后，下一次调用用的还是旧值 —— 界面说"已保存"但没效果，
//   那比没有界面更糟。所以 config 必须现读；只有二进制路径允许缓存（它只 stat 文件，
//   而且用户改路径是低频事件，用字段拼接当缓存键就能失效）。

const SETTINGS_IO = createIo()

/** 二进制缓存：键是四个路径字段，任一变化就重算。 */
let binaryCache = { key: null, value: null }
function binariesFor (config) {
  const key = [config.ffmpeg, config.ffprobe, config.whisperBin, config.whisperDir].join('\u0000')
  if (binaryCache.key !== key) binaryCache = { key, value: resolveBinaries(config) }
  return binaryCache.value
}

/** 此刻真正生效的配置：文件 > 环境变量 > profile 里的 plugin config > 内置默认。 */
function liveConfig (baseConfig) {
  return loadEffective({ file: CONFIG_FILE, env: process.env, base: baseConfig, io: SETTINGS_IO }).config
}

function json (res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody (req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 回环快速通道（照 dsh-bili-whale 的栅栏思路，不自己发明信任判定）。 */
function isLoopbackReq (req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const head = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return head === '127.0.0.1' || head === 'localhost' || head === '[::1]' || head === '::1'
}

function isTrustedReq (req, ctx) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch { /* 栅栏不可用 → 下面按不可信处理 */ }
  return false
}

/** 读写都要过栅栏；写操作尤其不能 fail-open。 */
function rejected (req, res, ctx) {
  if (isTrustedReq(req, ctx)) return false
  json(res, 403, { ok: false, error: '不受信任的访问来源' })
  return true
}

/**
 * 注册 /dsh-video/api/config（读写合成一个 handler）。
 *
 * **必须幂等**：cordis 的 HMR 是 Fiber._reload —— 旧 fiber 还没 dispose 时新的 apply 就会跑，
 * 于是同一路径被注册两次，而宿主对重复的 (kind, path) **直接 throw**：
 *     webserver: duplicate exact route "/dsh-video/api/config"
 * 那条错误在宿主日志里是 [error] 级，每次改代码重载都会刷一条，还会打断 apply 的后续步骤。
 * 重复注册在这里**没有意义**：第一个 handler 已经能服务同一个路径，第二个永远收不到请求。
 * 所以撞上就静默跳过（只留一条 debug），既不重复挂载，也不让重载失败。
 */
function mountSettingsRoutes (scoped, baseConfig) {
  const server = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
  if (server === undefined || server === null || typeof server.register !== 'function') return
  try {
    registerConfigRoute(server, scoped, baseConfig)
  } catch (error) {
    // 只吞"重复注册"：其它错误（路由表坏了、信号不对）必须冒出去，别把真故障也藏了
    if (!/duplicate .*route/i.test(String(error?.message ?? error))) throw error
  }
}

function registerConfigRoute (server, scoped, baseConfig) {
  server.register({
    kind: 'exact',
    path: '/dsh-video/api/config',
    handler: async (req, res) => {
      if (rejected(req, res, scoped)) return
      try {
        if (req.method === 'GET') {
          const eff = loadEffective({ file: CONFIG_FILE, env: process.env, base: baseConfig, io: SETTINGS_IO })
          json(res, 200, {
            ok: true,
            config: eff.config,
            resolved: resolveDisplay(eff.config, { binaries: binariesFor(eff.config) }),
            candidates: MODEL_CANDIDATES.map((c) => ({ ...c })),
            configPath: CONFIG_FILE,
            fileError: eff.fileError,
          })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
        // 写操作再挡一次（不依赖上面那层，避免以后有人把它改成宽松模式）
        if (!isTrustedReq(req, scoped)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
        const text = await readBody(req)
        let body
        try { body = JSON.parse(text === '' ? '{}' : text) } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const incoming = (body !== null && typeof body === 'object' && body.config !== null && typeof body.config === 'object') ? body.config : body
        const saved = savePatch({ incoming, file: CONFIG_FILE, io: SETTINGS_IO })
        if (!saved.ok) { json(res, saved.status ?? 400, { ok: false, error: saved.error }); return }
        json(res, 200, { ok: true, config: saved.config, configPath: saved.configPath })
      } catch (err) {
        try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch { /* 响应已结束 */ }
      }
    },
  })
}


/* ────────────────────────── spec → 标准 JSON Schema ────────────────────────── */

/**
 * dsh 的 schema spec 用**属性级** required（{ type:'string', required:true }），
 * 标准 JSON Schema 用**对象级** required 数组。ctx.tools.register 只接受后者，
 * 而 defineTool 就是干这个转换的 —— 这里自己转一份，避免为了它去 import 宿主包。
 */
function toJsonSchema (spec) {
  if (spec === null || typeof spec !== 'object') return spec
  if (Array.isArray(spec)) return spec.map(toJsonSchema)
  const out = {}
  for (const [key, value] of Object.entries(spec)) {
    // 属性级的 required 是布尔，属于「该属性必填」的标记，不能原样留在 schema 里
    if (key === 'required' && typeof value === 'boolean') continue
    out[key] = toJsonSchema(value)
  }
  const props = spec.properties
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    const requiredKeys = []
    const properties = {}
    for (const [key, value] of Object.entries(props)) {
      properties[key] = toJsonSchema(value)
      if (value !== null && typeof value === 'object' && value.required === true) requiredKeys.push(key)
    }
    out.properties = properties
    if (requiredKeys.length > 0 && out.required === undefined) out.required = requiredKeys
  }
  return out
}

/** parameters 的 spec 是**平铺的属性表**（没有 type/properties 包裹），要自己包一层。 */
function parametersToJsonSchema (spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = toJsonSchema(value)
    if (value !== null && typeof value === 'object' && value.required === true) required.push(key)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/* ────────────────────────────── 装配 ────────────────────────────── */

/**
 * 配置归一化：只留下真的给了、且类型对的值。
 * 为什么在这里做而不是在能力里：能力只该看到「一个可信的 config 对象」，
 * 缺字段由下游各自回落到默认值（paths.js / DETAILS），这样一处默认值就是一处。
 */
function normalizeConfig (rawConfig) {
  const raw = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const config = {}
  for (const key of ['ffmpeg', 'ffprobe', 'whisperBin', 'whisperDir', 'provider', 'model', 'lang']) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') config[key] = raw[key].trim()
  }
  if (Number.isFinite(raw.concurrency) && raw.concurrency >= 1) config.concurrency = Math.floor(raw.concurrency)
  if (Number.isFinite(raw.maxWallClockMs) && raw.maxWallClockMs > 0) config.maxWallClockMs = Math.floor(raw.maxWallClockMs)
  if (raw.pricing !== null && typeof raw.pricing === 'object' && !Array.isArray(raw.pricing)) config.pricing = { ...raw.pricing }
  return config
}

/** 能力 → ctx.tools.register 接受的工具定义（形状照 dsh-tools 的 register 契约）。 */
function toTool (capability, ctx, shared, baseConfig) {
  const spec = capability.tool
  return {
    name: spec.name,
    description: spec.description,
    parameters: parametersToJsonSchema(spec.parameters),
    output: {
      schema: toJsonSchema(spec.outputSchema),
      render: spec.renderResult
    },
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      // 每次调用现取三样东西：
      //   ctx.llm / ctx.attachments —— 宿主可能热替换服务；
      //   config —— 设置界面刚保存的值必须立刻生效（这就是"不用重启"的实现点）。
      // 工具和对外的 service 走**同一条** deps 装配路径（shared.callDeps），
      // 两条路径各写一遍迟早会分叉：一边校验了图片预算、另一边绕过。
      const deps = shared.callDeps(undefined, exec === undefined || exec === null ? undefined : exec.signal)
      // detail 在 understand.js 里只从 args 读，所以设置界面配的默认档位在这里补进 args。
      const effectiveArgs = (args !== null && typeof args === 'object' && args.detail === undefined && deps.config.detail !== undefined)
        ? { ...args, detail: deps.config.detail }
        : args
      return capability.run(effectiveArgs, deps)
    },
    presentCall (args) {
      const where = args !== null && typeof args === 'object' && typeof args.path === 'string' ? args.path : '视频'
      return { card: 'generic', title: '理解视频 ' + where, kind: 'search' }
    }
  }
}

/** 装配：解析 config → 建 registry → 每项能力转成一个工具注册上去。 */
export function apply (ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object' || ctx.tools === null || typeof ctx.tools !== 'object' || typeof ctx.tools.register !== 'function') {
    // 宁可在这里炸响，也不要静默装上一个没有工具的插件（契约 §19.2 那类坑的形态）
    throw new Error('dsh-video: ctx.tools 不可用。inject 里必须有 tools')
  }
  const config = normalizeConfig(rawConfig)
  const registry = createRegistry()
  for (const capability of capabilities) registry.register(capability)

  const shared = {
    // 二进制解析一次就够（它只 stat 文件）；用户改路径后要重载插件才生效
    binaries: resolveBinaries(config),
    config,
    pricing: config.pricing,
    log: typeof ctx.logger === 'object' && ctx.logger !== null && typeof ctx.logger.debug === 'function'
      ? (message) => { try { ctx.logger.debug(message) } catch { /* 日志坏了不该影响工具 */ } }
      : undefined,
    /**
     * capability.run 的 deps 装配 —— 工具（execute）和对外服务（videoUnderstand）共用这一处。
     * @param {object} [override] 本次调用的临时配置覆盖（服务调用方可以只改这一次的模型，不落盘）
     * @param {AbortSignal} [signal]
     */
    callDeps (override, signal) {
      const base = liveConfig(config)
      const effective = override !== null && typeof override === 'object' ? { ...base, ...override } : base
      return {
        ...shared,
        config: effective,
        binaries: binariesFor(effective),
        pricing: effective.pricing,
        llm: ctx.llm,
        attachments: ctx.attachments,
        signal
      }
    }
  }

  for (const capability of registry.list()) {
    ctx.tools.register(toTool(capability, ctx, shared, config))
  }

  // 设置界面的后端。**可选注入**：webServer 不在 inject 数组里，所以它缺失时
  // 插件照常加载、工具照常可用，只是没有那个界面——这比"因为 webServer 没起来就整个插件不加载"好。
  // 挂在 scoped 上下文上是必须的：cordis 卸载这个 fiber 时会释放路由，
  // 而 webServer 对重复的 (kind, path) 会 throw（dsh-voice-call 0.3.10 就栽在这）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => { mountSettingsRoutes(scoped, config) })
  }

  // ── 对外服务 ─────────────────────────────────────────────────────────────
  // 别的插件这样用（不需要 import 本包，也不需要知道它装在哪）：
  //
  //     export const inject = ['videoUnderstand']
  //     export function apply (ctx) {
  //       const r = await ctx.videoUnderstand.understand({ path, detail: 'quick' })
  //     }
  //
  // 想改成可选依赖就不写进 inject，用 ctx.get('videoUnderstand') 判空即可。
  // provide 返回 disposer，cordis 卸载本 fiber 时会自动摘掉注册。
  const service = createVideoService({
    registry,
    makeDeps: (options) => {
      const opts = options !== null && typeof options === 'object' ? options : {}
      return shared.callDeps(opts.config, opts.signal)
    }
  })
  if (typeof ctx.provide === 'function') {
    ctx.provide('videoUnderstand', service)
  } else if (ctx.reflect !== null && typeof ctx.reflect === 'object' && typeof ctx.reflect.provide === 'function') {
    // 老版本 cordis 只暴露 ctx.reflect.provide；Service 基类内部走的也是这条
    ctx.reflect.provide('videoUnderstand', service)
  } else {
    throw new Error('dsh-video: 这个宿主既没有 ctx.provide 也没有 ctx.reflect.provide，无法注册对外服务')
  }
}

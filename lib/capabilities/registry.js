// 能力注册表 —— 一个 id 一项能力，插件入口只负责把它接到 ctx.tools 上
//
// 为什么要有它（PROMPT §1）：将来加「生成视频 / 剪辑 / 字幕」时只在这里 register 一项，
// understand.js 一行都不用改。反过来，如果 lib/index.js 里直接写死三个 register 调用，
// 加第四项就得动入口文件 —— 而入口文件是最容易被改坏的那一个：它 import 出错，DSH 直接启动不了。
//
// 为什么 defineCapability 与 register 的校验分工不同：
//   · defineCapability 管**单个能力自己的形状**：id 合法、tool.name 非空、parameters 是对象、
//     run 是函数，以及 outputSchema / renderResult 必须**成对**存在。后面这两样是
//     defineTool 无条件读取的（契约 §19.1），少一个会在宿主注册阶段抛，整棵树起不来。
//   · register 管**跨能力的唯一性**：id 与 tool.name 都不许重复。工具名撞车时宿主的行为是
//     "后者覆盖前者"——不报错也不提示，表现是"工具在、但跑到别人的实现上"，最难查的那一类。
//
// 为什么不在这里 import defineTool：宿主侧那几个包只有 lib/index.js 能 import（契约 §18）。
// 所以能力自带的是**纯数据**的 schema spec 加一个纯函数 render，由 lib/index.js 转成 defineTool。
// 好处是 registry/understand 都能被裸 node 直接 import 来测（契约 §16/§18）。

const ID_RE = /^[a-z][a-z0-9_]*$/

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

const isObjectLike = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 校验单个能力的形状；不合法直接抛 coded error（注册是装配期的事，宁可早死）。 */
function assertCapabilityShape (def) {
  if (!isObjectLike(def)) throw codedError('CAPABILITY_INVALID', `能力定义必须是对象，收到 ${typeof def}`)
  const { id, tool, run } = def
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw codedError('CAPABILITY_INVALID_ID', `能力 id 必须是 snake_case（小写字母开头）：${String(id)}`)
  }
  if (!isObjectLike(tool)) throw codedError('CAPABILITY_INVALID_TOOL', `能力 ${id} 的 tool 必须是对象`)
  if (typeof tool.name !== 'string' || tool.name.trim() === '') {
    throw codedError('CAPABILITY_INVALID_TOOL', `能力 ${id} 缺少 tool.name`)
  }
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw codedError('CAPABILITY_INVALID_TOOL', `能力 ${id}（工具 ${tool.name}）缺少 tool.description`)
  }
  // 没有 parameters 的 defineTool 会让模型无从调用；给 {} 也要显式写出来，不许漏。
  if (!isObjectLike(tool.parameters)) {
    throw codedError('CAPABILITY_INVALID_PARAMS', `能力 ${id} 的 tool.parameters 必须是 schema spec 对象`)
  }
  if (typeof run !== 'function') throw codedError('CAPABILITY_INVALID_RUN', `能力 ${id} 缺少 run 函数`)
  // defineTool 无条件读 output.schema / output.render（契约 §19.1）：缺任何一个都是宿主期崩溃。
  if (!isObjectLike(tool.outputSchema) || typeof tool.renderResult !== 'function') {
    throw codedError(
      'CAPABILITY_INVALID_OUTPUT',
      `能力 ${id} 必须同时提供 tool.outputSchema 与 tool.renderResult（defineTool 的 output.schema / output.render 是必填）`
    )
  }
  return true
}

/**
 * 定义一个能力：校验形状 + 冻结，返回可直接交给 registry.register 的对象。
 * 已经冻结过的对象直接返回（幂等）：调用方拿到的是同一个引用，不必担心被复制成两份。
 */
export function defineCapability (def) {
  assertCapabilityShape(def)
  if (Object.isFrozen(def)) return def
  if (!Object.isFrozen(def.tool)) {
    Object.freeze(def.tool.parameters)
    Object.freeze(def.tool.outputSchema)
    Object.freeze(def.tool)
  }
  return Object.freeze({ id: def.id, tool: def.tool, run: def.run })
}

/**
 * 建一个注册表。
 * list() / capabilities() 返回的都是**同一批引用**（按注册顺序），入口照它循环注册即可。
 */
export function createRegistry () {
  const byId = new Map()
  const toolNames = new Set()

  const registry = {
    /**
     * 注册一项能力。可以是原始定义（{ id, tool, run }），也可以是 defineCapability 的产物。
     * id 或 tool.name 重复一律抛 —— 静默覆盖是这里最不能接受的行为。
     */
    register (def) {
      const capability = defineCapability(def)
      if (byId.has(capability.id)) {
        throw codedError('CAPABILITY_DUPLICATE_ID', `能力 id 重复：${capability.id}`)
      }
      if (toolNames.has(capability.tool.name)) {
        throw codedError('CAPABILITY_DUPLICATE_TOOL', `工具名重复：${capability.tool.name}`)
      }
      byId.set(capability.id, capability)
      toolNames.add(capability.tool.name)
      return capability
    },
    get (id) {
      return byId.get(id) ?? null
    },
    has (id) {
      return byId.has(id)
    },
    list () {
      return [...byId.values()]
    },
    /** list 的别名：契约 §12 同时列了这两个名字，留一个起来不用猜。 */
    capabilities () {
      return [...byId.values()]
    },
    get size () {
      return byId.size
    }
  }
  return registry
}

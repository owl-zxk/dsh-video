// 对外服务 videoUnderstand —— 让别的 DSH 插件用**编程接口**理解视频，而不是只能靠工具。
//
// 为什么是 cordis service，而不是从包里 export 一个函数：
//   插件之间跨包 import 要求两边的包解析对得上（link 的位置、pnpm 的 hoist、换台机器都会变），
//   一断就是 ERR_MODULE_NOT_FOUND。ctx.provide() 是宿主自己的服务总线：别的插件 inject 一下
//   就能拿到，本插件被卸载时 cordis 会自动摘掉注册（provide 返回的是 disposer）。
//
// 为什么这里不 import @deepseek-ai/cordis：
//   ctx.provide() 是 Context 的公开方法，Service 基类内部也只是转调 ctx.reflect.provide()。
//   lib/index.js 顶部解释过：装配层只要有一个宿主包静态 import，插件就加载不起来
//   （宿主不给 junction 指向的目录做 ESM 插桩）。服务是给别人的入口，更不能成为那个断点。
//
// 接口刻意与工具参数同形：调用方从 video_understand 的文档抄参数就能用，不必学第二套。

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 建对外服务。
 * @param {{ registry: object, makeDeps: (options?: object) => object }} deps
 *   registry —— 能力注册表（加新能力时服务自动跟着多一项，不用改这里）；
 *   makeDeps —— 由 lib/index.js 提供，负责把 ctx.llm / ctx.attachments / 即时配置组装成 capability.run 的 deps。
 * @returns 冻结的服务对象（挂到 ctx.videoUnderstand 上）。
 */
export function createVideoService (deps) {
  const registry = deps === null || deps === undefined ? null : deps.registry
  const makeDeps = deps === null || deps === undefined ? null : deps.makeDeps
  if (registry === null || typeof registry !== 'object' || typeof registry.get !== 'function') {
    throw codedError('SERVICE_NO_REGISTRY', 'createVideoService: 需要 registry（能力注册表）')
  }
  if (typeof makeDeps !== 'function') {
    throw codedError('SERVICE_NO_DEPS', 'createVideoService: 需要 makeDeps(options)')
  }

  const callCapability = (capability, args, options) => {
    const input = args !== null && typeof args === 'object' ? args : {}
    const opts = options !== null && typeof options === 'object' ? options : {}
    // 能力层承诺「永不抛、永远返回结构化结果」，这里不额外包一层 try ——— 
    // 包了反而会把真正的编程错误（比如 deps 装配错）也吞成 failures，调用方更难查。
    return capability.run(input, makeDeps(opts))
  }

  const service = {
    /**
     * 理解一个视频（能力 ① `video_understand`）。
     * @param {object} args 与 video_understand 工具参数同形：{ path, question?, detail?, maxFrames?, model?, ... }
     * @param {{ signal?: AbortSignal, config?: object }} [options]
     *   config 是**本次调用**的临时覆盖（例如换一个视觉模型），不写配置文件、不影响别人。
     * @returns 结构化结果（§2.6 的 17 个键）；模型或 whisper 挂掉只是 failures 非空，不抛。
     */
    async understand (args, options) {
      const capability = registry.get('video_understand')
      if (capability === null || capability === undefined) {
        throw codedError('UNKNOWN_CAPABILITY', 'videoUnderstand.understand: 能力 video_understand 未注册')
      }
      return callCapability(capability, args, options)
    },

    /**
     * 通用入口：按能力 id 调用。
     * 将来加「生成视频 / 剪辑 / 字幕」时，这里一个字都不用改 —— 新能力注册进 registry 就能被调到。
     * @param {string} capabilityId 例如 'video_understand'
     * @param {object} args 该能力的参数（与它对外的工具参数同形）
     * @param {{ signal?: AbortSignal, config?: object }} [options]
     * @throws 能力 id 未知时**抛**（调用方是代码，写错了必须立刻知道，不能混进 failures）
     */
    async run (capabilityId, args, options) {
      const id = typeof capabilityId === 'string' ? capabilityId.trim() : ''
      if (id === '') throw codedError('INVALID_CAPABILITY', 'videoUnderstand.run: capabilityId 必须是非空字符串')
      const capability = registry.get(id)
      if (capability === null || capability === undefined) {
        const known = registry.capabilities().map((item) => item.id).join(', ')
        throw codedError('UNKNOWN_CAPABILITY', `videoUnderstand.run: 没有能力 "${id}"（已知：${known || '无'}）`)
      }
      return callCapability(capability, args, options)
    },

    /** 这个插件现在能做什么（id / 工具名 / 描述）。加能力时自动变长。 */
    capabilities () {
      return registry.capabilities().map((item) => ({
        id: item.id,
        tool: item.tool.name,
        description: item.tool.description
      }))
    }
  }

  return Object.freeze(service)
}

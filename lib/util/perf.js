// 分段计时器 + 墙钟闸门
//
// 为什么要有它：没有分环节耗时，就不知道该优化哪一段（PROMPT §2.7.2）。而
// "时序优化"最容易变成"默默跳过某个环节" —— 所以墙钟闸门是**显式**的：超时就抛
// TimeoutError('WALL_CLOCK_EXCEEDED')，由上层决定"停在当前进度 + 在 failures 里如实写"，
// 绝不允许静默降准确率（PROMPT §2.7.8）。
//
// 两个踩过的点：
//   ① timings() **恒定**返回契约 §2 的 8 个键（含没跑的段记 0）。少一个键，下游
//      JSON 的 timings 形状就会随执行路径漂移，测试和用户都读不出"哪段没跑"。
//   ② totalMs 与 wallClockMs 都写，且都取墙钟而不是各段求和：并发段（视觉批次、
//      whisper 分块）在时间上是重叠的，求和会得出一个比真实耗时还大的假数字。
//      显式 stop('totalMs') 过的覆盖自动值 —— 允许调用方把"实际计过的时间"钉死。

/** 契约 §2 的固定键名与顺序，不许各写一份。 */
export const TIMING_KEYS = Object.freeze([
  'probeMs', 'framesMs', 'audioMs', 'visionMs', 'reframeMs', 'mergeMs', 'totalMs', 'wallClockMs',
])

/** 墙钟超时。code 固定，上层靠 code 判断，不靠文案。 */
export class TimeoutError extends Error {
  constructor(message = '超过墙钟上限') {
    super(message)
    this.name = 'TimeoutError'
    this.code = 'WALL_CLOCK_EXCEEDED'
  }
}

const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)

/**
 * 分段计时器。同一名字 start/stop 多次会累加（例如 reframe 分多轮）。
 * @param {() => number} [now] 注入时钟，测试用假时钟
 */
export function createTimers(now = Date.now) {
  const t0 = now()
  const done = new Map() // name -> 累计毫秒
  const open = new Map() // name -> 开始时刻

  const api = {
    start(name) {
      open.set(name, now())
      return api
    },
    stop(name) {
      const at = open.get(name)
      if (at == null) return 0
      open.delete(name)
      const d = Math.max(0, now() - at)
      done.set(name, (done.get(name) ?? 0) + d)
      return d
    },
    /** 包住一段 async/sync 工作并计时；抛错也照样 stop（finally）。 */
    async span(name, fn) {
      api.start(name)
      try {
        return await fn()
      } finally {
        api.stop(name)
      }
    },
    /** 契约 §2 的 8 个键，恒定齐全；未跑的段为 0。 */
    timings() {
      const wall = api.wallClockMs()
      const out = {}
      for (const k of TIMING_KEYS) {
        if (k === 'wallClockMs') out[k] = wall
        else if (k === 'totalMs') out[k] = done.has('totalMs') ? num(done.get('totalMs')) : wall
        else out[k] = num(done.get(k))
      }
      return out
    },
    /** 从创建到此刻的墙钟毫秒（含尚未 stop 的段）。 */
    wallClockMs() {
      return Math.max(0, now() - t0)
    },
  }
  return api
}

/**
 * 墙钟闸门。maxWallClockMs 非正 / 非有限 → 不设限（Infinity）。
 * @param {number} maxWallClockMs
 * @param {() => number} [now]
 */
export function deadline(maxWallClockMs, now = Date.now) {
  const t0 = now()
  const limit = Number.isFinite(maxWallClockMs) && maxWallClockMs > 0 ? maxWallClockMs : Infinity
  const elapsed = () => Math.max(0, now() - t0)
  const api = {
    elapsedMs: elapsed,
    remainingMs: () => (limit === Infinity ? Infinity : Math.max(0, limit - elapsed())),
    exceeded: () => limit !== Infinity && elapsed() >= limit,
    assert() {
      if (api.exceeded()) {
        const err = new TimeoutError(`超过墙钟上限 ${limit}ms（已用 ${elapsed()}ms）`)
        err.limitMs = limit
        err.elapsedMs = elapsed()
        throw err
      }
    },
  }
  return api
}

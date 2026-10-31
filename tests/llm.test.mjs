// 为什么这些测试全用 fake：视觉层唯一的外部依赖是 ctx.llm / ctx.attachments，
// 真网络和真附件库在沙箱里既不可用也不该用。用 fake 才能断言「谁在什么顺序被调用、
// 同时有几个在飞、送出去的块长什么样」——这些才是踩过的坑，文案不是。
// 注意：本文件不许 import lib/index.js（那会把 @deepseek-ai/* 拉进来，契约 §18）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { DETAILS, MAX_IMAGES_PER_MESSAGE, resolveDetail, planBatches, estimateImageTokens, estimateCostUsd, Semaphore } from '../lib/llm/budget.js'
import { assertVisionModel, analyzeBatch, analyzeBatchWithRetry, mergeAnalysis } from '../lib/llm/vision.js'

/** 一段看起来像 base64 的假图片数据；测试靠它证明「原始 base64 没被塞进 messages」。 */
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+bypBAAAAAElFTkSuQmCC'

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

function makeFrames (count, { startMs = 0, stepMs = 1000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    ms: startMs + index * stepMs,
    data: `${BASE64}${index}`,
    mediaType: 'image/jpeg'
  }))
}

/** fake 附件层：记录被调了几次，并把 wire 形状换成带 attachment 的块（真宿主就是这么换的）。 */
function makeAttachments ({ width = 2730, height = 1536 } = {}) {
  const state = { admitCalls: 0, wire: [] }
  let nextId = 0
  return {
    state,
    store: {
      async admitPromptContent (content) {
        state.admitCalls += 1
        state.wire.push(content)
        return content.map(part => {
          if (part.type !== 'image') return { type: 'text', text: part.text }
          nextId += 1
          // 归一化后尺寸（契约 §19.4：16:9 源码被压到 ~2730x1536，适配器再按 1708x961 发送）
          return { type: 'image', attachment: { attachmentId: `sha256:fake${nextId}`, mediaType: part.mediaType, bytes: 4096, width, height } }
        })
      }
    }
  }
}

const stopChunk = { type: 'finish', reason: { kind: 'stop' } }

function textChunks (text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    stopChunk
  ]
}

function makeLlm ({ modalities = ['text', 'image'], produce, chunkDelayMs = 0 } = {}) {
  const state = { streamCalls: 0, modelCalls: 0, inFlight: 0, peak: 0, options: [] }
  const llm = {
    async resolveModelInfo (provider, model) {
      state.modelCalls += 1
      return { provider, id: model, name: model, inputModalities: [...modalities] }
    },
    stream (options) {
      state.streamCalls += 1
      state.options.push(options)
      state.inFlight += 1
      state.peak = Math.max(state.peak, state.inFlight)
      const index = state.streamCalls
      return (async function * () {
        try {
          const chunks = await produce({ index, options, state })
          for (const chunk of chunks) {
            if (chunkDelayMs > 0) await sleep(chunkDelayMs)
            yield chunk
          }
        } finally {
          state.inFlight -= 1
        }
      })()
    }
  }
  return { llm, state }
}

const BATCH = (frames) => ({ index: 0, frames, windowStartMs: 0, windowEndMs: frames.at(-1).ms, durationMs: 30000 })

function deps (llmBundle, attachmentsBundle, extra = {}) {
  return {
    llm: llmBundle.llm,
    attachments: attachmentsBundle.store,
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    sleep: async () => {},
    ...extra
  }
}

test('planBatches：区间首尾相接、无重叠、每批不超批大小、批次数 = ceil(帧数/批大小)', () => {
  const cases = [[0, 8], [1, 8], [7, 8], [8, 8], [9, 8], [16, 8], [17, 5], [40, 10]]
  for (const [count, size] of cases) {
    const batches = planBatches(count, size)
    assert.equal(batches.length, Math.ceil(count / size), `${count}/${size} 批次数`)
    if (count === 0) {
      assert.deepEqual(batches, [])
      continue
    }
    assert.equal(batches[0].from, 0)
    assert.equal(batches.at(-1).to, count)
    batches.forEach((batch, index) => {
      assert.equal(batch.index, index)
      assert.ok(batch.to > batch.from, '空批次不许出现')
      assert.ok(batch.to - batch.from <= size, '每批长度不得超过 batchSize')
      if (index > 0) assert.equal(batch.from, batches[index - 1].to, '区间必须首尾相接')
      assert.ok(batch.to - batch.from <= MAX_IMAGES_PER_MESSAGE, '一批绝不能超过单请求图片上限')
    })
  }
  assert.throws(() => planBatches(10, 0), error => error.code === 'INVALID_BATCH_SIZE')
})

test('planBatches：batchSize 超过单请求图片上限时夹到 20 并 warn（不静默发出去）', () => {
  const warns = []
  const batches = planBatches(100, 50, { warn: message => warns.push(message) })
  assert.equal(batches.length, 5, '100 帧 / 20 张一批')
  for (const batch of batches) assert.ok(batch.to - batch.from <= MAX_IMAGES_PER_MESSAGE, `batchSize 被夹到 20：${JSON.stringify(batch)}`)
  assert.equal(warns.length, 1, '只 warn 一次')
  assert.match(warns[0], /夹到 20/)

  // 合法 batchSize 不许 warn（契约 §2 的 6/8/10 都在限内）
  const quiet = []
  planBatches(16, 8, { warn: message => quiet.push(message) })
  assert.deepEqual(quiet, [])
})

test('DETAILS / resolveDetail：三档常量齐全，未知档位退回 standard', () => {
  assert.deepEqual(Object.keys(DETAILS), ['quick', 'standard', 'deep'])
  assert.deepEqual({ ...DETAILS.standard }, { maxFrames: 16, batchSize: 8, maxRounds: 1, maxExtraFrames: 12, maxCostUsd: 0.1 })
  assert.equal(resolveDetail('deep'), 'deep')
  assert.equal(resolveDetail('quick'), 'quick')
  assert.equal(resolveDetail('fuzzy'), 'standard')
  assert.equal(resolveDetail(undefined), 'standard')
})

test('estimateImageTokens：不超过单图 token 预算（数值与提供方网格一致）', () => {
  // 1708x961 是 DeepSeek 16:9 的实际发送尺寸，968 是提供方算出来的数。
  assert.equal(estimateImageTokens({ width: 1708, height: 961 }), 968)
  assert.equal(estimateImageTokens({ width: 1302, height: 1302 }), 994)
  assert.equal(estimateImageTokens({ width: 640, height: 360 }), 192)
  for (const [width, height] of [[1920, 1080], [4000, 3000], [50, 3000], [1, 1]]) {
    const tokens = estimateImageTokens({ width, height })
    assert.ok(Number.isInteger(tokens) && tokens > 0 && tokens <= 1024, `${width}x${height} -> ${tokens}`)
  }
  assert.throws(() => estimateImageTokens({ width: 0, height: 10 }), error => error.code === 'INVALID_IMAGE_SIZE')
})

test('estimateCostUsd：有费率才估，没定价就是 0（不瞎估）', () => {
  const pricing = { inputPerMillion: 0.3, outputPerMillion: 1.2, imageTokensPerImage: 968 }
  const cost = estimateCostUsd({ pricing, imageCount: 8, textTokensIn: 1000, textTokensOut: 500 })
  const expected = (1000 + 8 * 968) / 1e6 * 0.3 + 500 / 1e6 * 1.2
  assert.ok(Math.abs(cost - expected) < 1e-9, `${cost} vs ${expected}`)
  // 宿主真实形状：imageRequestPricing() -> { priceImages(blocks) } 只给 visualTokens。
  // 配对费率表时才估得出钱，而且用它的 visualTokens 而不是自己去猜 token 数。
  const hostPricing = {
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    priceImages: blocks => blocks.map(() => ({ visualTokens: 968, text: 'handle' }))
  }
  const blocks = Array.from({ length: 3 }, (_, i) => ({ type: 'image', attachment: { attachmentId: 'sha256:' + i } }))
  const hostCost = estimateCostUsd({ pricing: hostPricing, images: blocks, imageCount: blocks.length, textTokensIn: 0, textTokensOut: 0 })
  assert.ok(Math.abs(hostCost - (3 * 968) / 1e6 * 0.3) < 1e-9, `宿主定价路径：${hostCost}`)
  // 宿主 imageRequestPricing 只给 visualTokens、没有任何 $ 费率 -> 必须给 0，不能编。
  assert.equal(estimateCostUsd({ pricing: { priceImages: () => [] }, imageCount: 8, textTokensIn: 1000 }), 0)
  assert.equal(estimateCostUsd({ pricing: undefined, imageCount: 8 }), 0)
  assert.equal(estimateCostUsd({}), 0)
})

test('estimateCostUsd：KNOWN_PRICING 兜底 + 费率优先级（config.pricing > 内置表 > 0）', () => {
  // 手算（deepseek/deepseek-v4.1-flash：输入 0.3 $/1M，输出 1.2 $/1M）：
  //   图片 16 张 × 968 token（1708x961，数值见 estimateImageTokens 用例）= 15488 token
  //   输入合计 15488 + 0 = 15488 token -> 15488 / 1e6 × 0.3  = 0.0046464 $
  //   输出      2000 token          -> 2000  / 1e6 × 1.2  = 0.0024    $
  //   合计 = 0.0070464 $
  const cost = estimateCostUsd({
    model: 'deepseek/deepseek-v4.1-flash',
    imageCount: 16,
    textTokensIn: 0,
    textTokensOut: 2000,
    pricing: { imageTokensPerImage: 968 } // 只给图片记账、不给 $ 费率 -> 费率取内置表
  })
  assert.ok(Math.abs(cost - 0.0070464) < 1e-12, `期望 0.0070464，实际 ${cost}`)

  // 裸 model id 也要认得（调用方常只传 model 段）
  const bare = estimateCostUsd({ model: 'deepseek-v4.1-flash', imageCount: 16, textTokensOut: 2000, pricing: { imageTokensPerImage: 968 } })
  assert.ok(Math.abs(bare - 0.0070464) < 1e-12, `裸 model id：${bare}`)

  // config.pricing 覆盖内置表，且逐字段回落：输入价改成 1 $/1M，输出价仍取内置 1.2
  //   输入 15488 / 1e6 × 1   = 0.015488
  //   输出 2000  / 1e6 × 1.2 = 0.0024
  //   合计 = 0.017888
  const overridden = estimateCostUsd({ model: 'deepseek/deepseek-v4.1-flash', pricing: { inputPerMillion: 1, imageTokensPerImage: 968 }, imageCount: 16, textTokensOut: 2000 })
  assert.ok(Math.abs(overridden - 0.017888) < 1e-12, `config 覆盖：${overridden}`)

  // 内置表里没有的 model 且没给 config.pricing -> 0（不许瞎估）
  assert.equal(estimateCostUsd({ model: 'acme/unknown-model', imageCount: 4, textTokensIn: 100, textTokensOut: 100 }), 0)
  assert.equal(estimateCostUsd({ model: 'acme/unknown-model', pricing: { imageTokensPerImage: 968 }, imageCount: 4 }), 0)
})

test('Semaphore：限流生效、峰值可观测、抛错也归还额度', async () => {
  const semaphore = new Semaphore(3)
  const task = () => semaphore.run(async () => { await sleep(10); return 'ok' })
  const results = await Promise.all(Array.from({ length: 9 }, task))
  assert.deepEqual(results, Array(9).fill('ok'))
  assert.equal(semaphore.peak, 3)
  assert.equal(semaphore.active, 0)
  await assert.rejects(semaphore.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(semaphore.active, 0, '抛错后额度必须归还')
  assert.throws(() => new Semaphore(0), error => error.code === 'INVALID_CONCURRENCY')
})

test('assertVisionModel：纯文本模型明确报错（MODEL_NOT_VISION），不静默降级', async () => {
  const textOnly = makeLlm({ modalities: ['text'] })
  await assert.rejects(
    assertVisionModel(textOnly.llm, 'deepseek', 'deepseek-v4-pro'),
    error => error.code === 'MODEL_NOT_VISION' && /不接受图片/.test(error.message)
  )
  const vision = makeLlm({ modalities: ['text', 'image'] })
  const info = await assertVisionModel(vision.llm, 'deepseek', 'deepseek-v4.1-flash')
  assert.deepEqual([...info.inputModalities], ['text', 'image'])

  // 送图路径上同样要拦住：一个 token 都不能花。
  const attachments = makeAttachments()
  const depsWithTextOnly = deps(textOnly, attachments)
  await assert.rejects(analyzeBatchWithRetry(depsWithTextOnly, BATCH(makeFrames(2))), error => error.code === 'MODEL_NOT_VISION')
  assert.equal(textOnly.state.streamCalls, 0, '模型校验失败时不许发生任何模型调用')
  assert.equal(attachments.state.admitCalls, 0, '模型校验失败时不许上传图片')
})

test('analyzeBatch：图片走附件层，messages 里是 attachment 块且不含 base64', async () => {
  const attachments = makeAttachments()
  const bundle = makeLlm({ produce: () => textChunks(JSON.stringify({ startMs: 0, endMs: 2000, visual: '两个人在说话', onScreenText: ['字幕 A'], actions: ['点头'], needsReframe: [] })) })
  const frames = makeFrames(3)
  const result = await analyzeBatch(deps(bundle, attachments), BATCH(frames))

  assert.equal(attachments.state.admitCalls, 1, '一批图片只走一次 admitPromptContent')
  assert.deepEqual({ startMs: result.startMs, endMs: result.endMs, visual: result.visual }, { startMs: 0, endMs: 2000, visual: '两个人在说话' })

  const options = bundle.state.options[0]
  const content = options.messages[0].content
  const images = content.filter(part => part.type === 'image')
  assert.equal(images.length, 3, '每帧一张图')
  for (const image of images) {
    assert.ok(image.attachment !== undefined && image.attachment !== null, 'image 块必须带 attachment 引用')
    assert.equal(image.data, undefined, 'image 块不许带 base64')
  }
  const serialized = JSON.stringify(options.messages)
  assert.equal(serialized.includes(BASE64), false, 'messages 里不许出现原始 base64')
  // 帧标签必须紧挨着图（PROMPT §2.2：模型要能引用时间戳）
  const sequence = content.map(part => part.type)
  assert.deepEqual(sequence, ['text', 'text', 'image', 'text', 'image', 'text', 'image'])
  assert.match(content[1].text, /^帧 1 · 00:00\.0$/)
  assert.match(content[3].text, /^帧 2 · 00:01\.0$/)
})

test('analyzeBatch：返回本批 imageTokens（用归一化后的 ref 尺寸，宿主 priceImages 优先）', async () => {
  const reply = JSON.stringify({ startMs: 0, endMs: 2000, visual: '画面', onScreenText: [], actions: [], needsReframe: [] })
  const bundle = makeLlm({ produce: () => textChunks(reply) })

  // ref 是 1708x961 -> 968 token/张（提供方网格，见 estimateImageTokens 用例）
  const attachments = makeAttachments({ width: 1708, height: 961 })
  const measured = await analyzeBatch(deps(bundle, attachments), BATCH(makeFrames(3)))
  assert.ok(measured.imageTokens > 0, 'imageTokens 必须 > 0，不能恒为 0')
  assert.equal(measured.imageTokens, 3 * 968)

  // 宿主给了 priceImages 就以它为准（它才懂 offloaded 与被替换的占位符）
  const priced = await analyzeBatch(
    deps(bundle, makeAttachments({ width: 1708, height: 961 }), { pricing: { priceImages: blocks => blocks.map(() => ({ visualTokens: 100, text: 'handle' })) } }),
    BATCH(makeFrames(2))
  )
  assert.equal(priced.imageTokens, 200)
})

test('analyzeBatch：合法 JSON 能解析，围栏/废话也能解析，垃圾必须 throw', async () => {
  const attachments = makeAttachments()
  const payload = JSON.stringify({ startMs: 0, endMs: 1000, visual: '远景', onScreenText: ['标题'], actions: [], needsReframe: [{ startMs: 500, endMs: 900, reason: '看不清小字', kind: 'text' }] })
  const variants = [
    payload,
    '好的，结果如下：\n```json\n' + payload + '\n```\n以上。',
    '这是本批的分析结果，请查收：' + payload
  ]
  for (const [index, text] of variants.entries()) {
    const bundle = makeLlm({ produce: () => textChunks(text) })
    const result = await analyzeBatch(deps(bundle, attachments), BATCH(makeFrames(1)))
    assert.equal(result.visual, '远景', `变体 ${index} 应能解析`)
    assert.deepEqual(result.needsReframe, [{ startMs: 500, endMs: 900, reason: '看不清小字', kind: 'text' }])
  }

  const garbage = makeLlm({ produce: () => textChunks('我觉得这个视频还挺好看的。') })
  await assert.rejects(analyzeBatch(deps(garbage, attachments), BATCH(makeFrames(1))), error => error.code === 'INVALID_MODEL_OUTPUT')

  // 缺字段一律补空数组，绝不给 undefined
  const sparse = makeLlm({ produce: () => textChunks(JSON.stringify({ visual: '只有描述' })) })
  const sparseResult = await analyzeBatch(deps(sparse, attachments), BATCH(makeFrames(2)))
  assert.deepEqual(sparseResult.needsReframe, [])
  assert.deepEqual(sparseResult.onScreenText, [])
  assert.deepEqual(sparseResult.actions, [])
  for (const value of Object.values(sparseResult)) assert.notEqual(value, undefined)
})

test('重试：前两次失败第三次成功 -> 整体成功，调用次数 3，退避 500/1500', async () => {
  const attachments = makeAttachments()
  const waits = []
  const bundle = makeLlm({
    produce: ({ index }) => {
      if (index < 3) throw new Error('网关 429')
      return textChunks(JSON.stringify({ startMs: 0, endMs: 1000, visual: '恢复', onScreenText: [], actions: [], needsReframe: [] }))
    }
  })
  const result = await analyzeBatchWithRetry(
    deps(bundle, attachments, { sleep: async ms => { waits.push(ms) } }),
    BATCH(makeFrames(2))
  )
  assert.equal(result.visual, '恢复')
  assert.equal(bundle.state.streamCalls, 3, '1 次 + 2 次重试')
  assert.deepEqual(waits, [500, 1500])
})

test('重试：宿主用 finish(error) 表示失败时不吞（llm.stream 本身不 throw）', async () => {
  const attachments = makeAttachments()
  const bundle = makeLlm({
    produce: () => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: '需要省略 3 张图' } } }]
  })
  await assert.rejects(
    analyzeBatchWithRetry(deps(bundle, attachments), BATCH(makeFrames(2))),
    error => error.code === 'MODEL_STREAM_FAILED' && /IMAGE_OFFLOAD_REQUIRED/.test(error.message)
  )
  assert.equal(bundle.state.streamCalls, 3, '失败批次要真的重试三次')
})

test('并发限流：批次并发且峰值不超过 concurrency', async () => {
  const attachments = makeAttachments()
  const bundle = makeLlm({
    chunkDelayMs: 5,
    produce: async () => {
      await sleep(5)
      return textChunks(JSON.stringify({ startMs: 0, endMs: 1000, visual: '批次', onScreenText: [], actions: [], needsReframe: [] }))
    }
  })
  const semaphore = new Semaphore(2)
  const frames = makeFrames(16)
  const batches = planBatches(frames.length, 4)
  assert.equal(batches.length, 4)

  const results = await Promise.all(batches.map(batch => semaphore.run(() => analyzeBatchWithRetry(deps(bundle, attachments), {
    index: batch.index,
    frames: frames.slice(batch.from, batch.to),
    windowStartMs: frames[batch.from].ms,
    windowEndMs: frames[batch.to - 1].ms,
    durationMs: 30000
  }))))

  assert.equal(results.length, 4)
  assert.ok(bundle.state.peak > 1, `必须真并发（peak=${bundle.state.peak}）`)
  assert.ok(bundle.state.peak <= 2, `并发数不得超过 concurrency（peak=${bundle.state.peak}）`)
  assert.equal(semaphore.peak, 2)
  assert.equal(bundle.state.inFlight, 0)
})

test('mergeAnalysis：汇总只带文字，messages 里没有任何 image 块', async () => {
  const attachments = makeAttachments()
  const bundle = makeLlm({ produce: () => textChunks(JSON.stringify({ summary: '一句话总结', answer: '第 12 秒' })) })
  const result = await mergeAnalysis(deps(bundle, attachments), {
    question: '第几秒开始说话？',
    scenes: [{ startMs: 0, endMs: 2000, visual: '两个人', onScreenText: ['字幕 A'], actions: ['点头'], firstPass: '两个人' }],
    transcript: [{ startMs: 0, endMs: 1500, text: '大家好' }],
    reframes: [{ startMs: 500, endMs: 900, visual: '特写：手表' }],
    meta: { durationMs: 30000 }
  })
  assert.deepEqual(result, { summary: '一句话总结', answer: '第 12 秒' })
  assert.equal(attachments.state.admitCalls, 0, '汇总不许走附件层')
  const options = bundle.state.options[0]
  assert.equal(JSON.stringify(options.messages).includes('"image"'), false, '汇总 messages 里不许有 image 块')
  const text = options.messages[0].content[0].text
  assert.match(text, /语音转录/)
  assert.match(text, /第几秒开始说话？/)
})

test('BlockAssembler 注入：给了就用注入的那个，不给就用本地累加器', async () => {
  const attachments = makeAttachments()
  const pushed = []
  class FakeAssembler {
    push (chunk) { pushed.push(chunk.type) }
    text () { return JSON.stringify({ startMs: 0, endMs: 1000, visual: '注入的累加器', onScreenText: [], actions: [], needsReframe: [] }) }
    blocks () { return [] }
  }
  const bundle = makeLlm({ produce: () => textChunks('ignored') })
  const result = await analyzeBatch(deps(bundle, attachments, { BlockAssembler: FakeAssembler }), BATCH(makeFrames(1)))
  assert.equal(result.visual, '注入的累加器')
  assert.deepEqual(pushed, ['text-delta', 'block-end', 'finish'])
})

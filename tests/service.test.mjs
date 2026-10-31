// 对外服务 videoUnderstand 的单测 —— 只用假 registry / 假能力，不碰网络与真实视频。
//
// 为什么不 import lib/index.js：它是装配层，一旦 import 就会把宿主包（schemastery 动态 import）
// 一起拉进来，裸 node 里跑不稳。服务本身是纯逻辑，构造时把依赖全注进来就能测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createVideoService } from '../lib/service.js'

/** 造一个假 registry：capabilities() 按 order 返回，get() 查表。 */
function fakeRegistry (items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  return {
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
    capabilities: () => [...byId.values()],
    get size () { return byId.size },
  }
}

/** 假能力：run 把收到的 args/deps 记下来，返回一个可辨认的结果。 */
function fakeCapability (id, toolName, calls) {
  return {
    id,
    tool: { name: toolName, description: '假能力 ' + id, parameters: {}, outputSchema: {}, renderResult: () => [] },
    async run (args, deps) { calls.push({ id, args, deps }); return { ok: true, id, echo: args } },
  }
}

test('understand：调到 video_understand，参数原样透传，deps 来自 makeDeps', async () => {
  const calls = []
  const registry = fakeRegistry([fakeCapability('video_understand', 'video_understand', calls)])
  const seen = []
  const service = createVideoService({
    registry,
    makeDeps: (options) => { seen.push(options); return { config: { model: 'x' }, signal: options?.signal } },
  })
  const out = await service.understand({ path: 'a.mp4', detail: 'quick' })
  assert.deepEqual(out, { ok: true, id: 'video_understand', echo: { path: 'a.mp4', detail: 'quick' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.path, 'a.mp4')
  assert.equal(calls[0].deps.config.model, 'x')
  assert.equal(seen.length, 1, 'makeDeps 被调用一次')
})

test('understand：坏 args 兜成 {}，不让能力层收到 null', async () => {
  const calls = []
  const service = createVideoService({
    registry: fakeRegistry([fakeCapability('video_understand', 'video_understand', calls)]),
    makeDeps: () => ({}),
  })
  await service.understand(null)
  assert.deepEqual(calls[0].args, {})
})

test('options.config 透传给 makeDeps，用来做「只改这一次」的临时覆盖', async () => {
  const seen = []
  const service = createVideoService({
    registry: fakeRegistry([fakeCapability('video_understand', 'video_understand', [])]),
    makeDeps: (o) => { seen.push(o); return {} },
  })
  const ac = new AbortController()
  await service.understand({ path: 'a.mp4' }, { config: { model: 'minimax-cn/MiniMax-M3' }, signal: ac.signal })
  assert.deepEqual(seen[0].config, { model: 'minimax-cn/MiniMax-M3' })
  assert.equal(seen[0].signal, ac.signal)
})

test('run：按 id 调到任意已注册能力（将来加「生成视频」不用改服务）', async () => {
  const calls = []
  const registry = fakeRegistry([
    fakeCapability('video_understand', 'video_understand', calls),
    fakeCapability('video_generate', 'video_generate', calls),
  ])
  const service = createVideoService({ registry, makeDeps: () => ({}) })
  const out = await service.run('video_generate', { prompt: '一只猫' })
  assert.equal(out.id, 'video_generate')
  assert.equal(calls[0].id, 'video_generate')
})

test('run：未知 id 抛 UNKNOWN_CAPABILITY（编程错误不许混进 failures）', async () => {
  const service = createVideoService({
    registry: fakeRegistry([fakeCapability('video_understand', 'video_understand', [])]),
    makeDeps: () => ({}),
  })
  await assert.rejects(() => service.run('nope'), (e) => {
    assert.equal(e.code, 'UNKNOWN_CAPABILITY')
    assert.match(e.message, /video_understand/)
    return true
  })
})

test('run：空 id 抛 INVALID_CAPABILITY，非字符串同样', async () => {
  const service = createVideoService({ registry: fakeRegistry([]), makeDeps: () => ({}) })
  for (const bad of ['', '   ', null, undefined, 42]) {
    await assert.rejects(() => service.run(bad), (e) => e.code === 'INVALID_CAPABILITY')
  }
})

test('capabilities：列出 id / 工具名 / 描述，加能力自动变长', () => {
  const registry = fakeRegistry([
    fakeCapability('video_understand', 'video_understand', []),
    fakeCapability('video_generate', 'video_generate', []),
  ])
  const service = createVideoService({ registry, makeDeps: () => ({}) })
  const list = service.capabilities()
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((x) => x.id), ['video_understand', 'video_generate'])
  assert.equal(list[0].tool, 'video_understand')
  assert.equal(typeof list[0].description, 'string')
})

test('构造：缺 registry / makeDeps 立刻抛（装配错误不许拖到第一次调用）', () => {
  assert.throws(() => createVideoService({}), (e) => e.code === 'SERVICE_NO_REGISTRY')
  assert.throws(() => createVideoService({ registry: fakeRegistry([]) }), (e) => e.code === 'SERVICE_NO_DEPS')
})

test('服务对象是冻结的：调用方改不动它', () => {
  const service = createVideoService({ registry: fakeRegistry([]), makeDeps: () => ({}) })
  assert.ok(Object.isFrozen(service))
  assert.throws(() => { 'use strict'; service.understand = null })
})

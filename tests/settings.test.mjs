// 设置项的规则测试 —— 全内存 io，不碰真实文件、不连网。
//
// 为什么这些规则值得单独的测试文件：它们决定「用户点了保存之后到底发生了什么」。
// 写坏一个优先级就会让界面显示的值和实际用的值不一致，而这种不一致极难在真机上发现。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_FILE, DEFAULT_DETAIL, DEFAULT_MAX_WALL_CLOCK_MS, EDITABLE, MODEL_CANDIDATES,
  deriveConcurrency, envOverrides, loadEffective, mergeConfig, readConfigFile,
  resolveDisplay, sanitize, savePatch, validatePatch, writeConfigAtomic,
} from '../lib/settings-api.js'
import { DEFAULT_MODELS } from '../lib/util/paths.js'

/** 内存 io：记录每次调用，方便断言"原子写"真的走了临时文件 + rename。 */
function memIo (initial = {}) {
  const files = new Map(Object.entries(initial))
  const calls = []
  const io = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return files.get(p)
    },
    writeFileSync: (p, data) => { calls.push(['write', p]); files.set(p, String(data)) },
    renameSync: (from, to) => {
      calls.push(['rename', from, to])
      if (!files.has(from)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      files.set(to, files.get(from))
      files.delete(from)
    },
    mkdirSync: (p) => { calls.push(['mkdir', p]) },
  }
  return { files, calls, io }
}

const FILE = 'X:/dsh-home/dsh-video.config.json'

test('默认值：没有任何配置时 resolved 全部回落到内置默认', () => {
  const { io } = memIo()
  const eff = loadEffective({ file: FILE, env: {}, base: {}, io })
  assert.deepEqual(eff.config, {})
  assert.equal(eff.fileError, null)

  const resolved = resolveDisplay(eff.config, { cpus: 8 })
  assert.equal(resolved.model, DEFAULT_MODELS[DEFAULT_DETAIL])
  assert.equal(resolved.detail, DEFAULT_DETAIL)
  assert.equal(resolved.concurrency, deriveConcurrency(8))
  assert.equal(resolved.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS)
  assert.equal(resolved.lang, 'zh')
})

test('文件覆盖：文件里的值优先于 base（profile 的 plugin config）', () => {
  const { io } = memIo({ [FILE]: JSON.stringify({ model: 'minimax-cn/MiniMax-M3', concurrency: 7 }) })
  const eff = loadEffective({ file: FILE, env: {}, base: { model: 'deepseek-account/deepseek-flash', lang: 'ja' }, io })
  assert.equal(eff.config.model, 'minimax-cn/MiniMax-M3')
  assert.equal(eff.config.concurrency, 7)
  assert.equal(eff.config.lang, 'ja', 'base 里没被文件覆盖的字段要保留')
})

test('环境变量优先级：文件 > 环境变量 > base', () => {
  // ① 文件里没有 → env 生效
  const a = memIo()
  const onlyEnv = loadEffective({ file: FILE, env: { DSH_VIDEO_MODEL: 'env/model', DSH_VIDEO_CONCURRENCY: '3' }, base: {}, io: a.io })
  assert.equal(onlyEnv.config.model, 'env/model')
  assert.equal(onlyEnv.config.concurrency, 3)

  // ② 文件里有 → 文件的赢
  const b = memIo({ [FILE]: JSON.stringify({ model: 'file/model' }) })
  const withFile = loadEffective({ file: FILE, env: { DSH_VIDEO_MODEL: 'env/model' }, base: {}, io: b.io })
  assert.equal(withFile.config.model, 'file/model')
})

test('环境变量：类型不对就不认（不让坏 env 把并发写成 NaN）', () => {
  const over = envOverrides({}, { DSH_VIDEO_CONCURRENCY: 'abc', DSH_VIDEO_DETAIL: 'bogus', DSH_VIDEO_LANG: 'zh' })
  assert.equal('concurrency' in over, false)
  assert.equal('detail' in over, false)
  assert.equal(over.lang, 'zh')
})

test('字段清洗：坏类型当没给，不往下游传', () => {
  const clean = sanitize({ concurrency: 'abc', maxWallClockMs: -5, detail: 'nope', model: '  x/y  ', lang: '' })
  assert.equal('concurrency' in clean, false)
  assert.equal('maxWallClockMs' in clean, false)
  assert.equal('detail' in clean, false)
  assert.equal('lang' in clean, false)
  assert.equal(clean.model, 'x/y', '字符串要 trim')
})

test('validatePatch：未知字段被丢弃且不报错', () => {
  const v = validatePatch({ model: 'a/b', 未知字段: 'x', __proto__x: 1, detail: 'deep' })
  assert.equal(v.ok, true)
  assert.deepEqual(v.patch, { model: 'a/b', detail: 'deep' })
})

test('validatePatch：类型/范围不对返回 400 级的错误，不静默吞', () => {
  const bad = validatePatch({ concurrency: 'abc' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /concurrency/)

  const outOfRange = validatePatch({ maxWallClockMs: 5 })
  assert.equal(outOfRange.ok, false)
  assert.match(outOfRange.error, /maxWallClockMs/)

  const badEnum = validatePatch({ detail: 'ultra' })
  assert.equal(badEnum.ok, false)
  assert.match(badEnum.error, /detail/)

  const notString = validatePatch({ model: 42 })
  assert.equal(notString.ok, false)
  assert.match(notString.error, /model/)
})

test('validatePatch：空串 = 清除该字段（回到回落值）', () => {
  const v = validatePatch({ model: '', concurrency: '  ' })
  assert.equal(v.ok, true)
  assert.equal(v.patch.model, null)
  assert.deepEqual(mergeConfig({ model: 'a/b' }, v.patch), {})
})

test('mergeConfig 不改入参，null 删键', () => {
  const cur = { model: 'a/b', lang: 'zh' }
  const next = mergeConfig(cur, { model: null, concurrency: 4 })
  assert.deepEqual(next, { lang: 'zh', concurrency: 4 })
  assert.deepEqual(cur, { model: 'a/b', lang: 'zh' }, '原对象不许被改')
})

test('原子写：先写同目录临时文件，再 rename 覆盖', () => {
  const { files, calls, io } = memIo()
  writeConfigAtomic(FILE, { model: 'a/b' }, io)

  const wrote = calls.filter(([k]) => k === 'write').map(([, p]) => p)
  const renamed = calls.filter(([k]) => k === 'rename')
  assert.equal(wrote.length, 1)
  assert.notEqual(wrote[0], FILE, '不能直接写目标文件')
  assert.ok(wrote[0].startsWith(FILE + '.tmp-'), '临时文件必须在同目录（跨盘 rename 不是原子的）')
  assert.equal(renamed.length, 1)
  assert.deepEqual(renamed[0].slice(1), [wrote[0], FILE])
  assert.equal(JSON.parse(files.get(FILE)).model, 'a/b')
  assert.equal(files.has(wrote[0]), false, '临时文件 rename 后不该留下')
})

test('即时生效：savePatch 之后同一条路径再读就是新值', () => {
  const { io } = memIo()
  const saved = savePatch({ incoming: { model: 'minimax-cn/MiniMax-M3', detail: 'deep' }, file: FILE, io })
  assert.equal(saved.ok, true)
  assert.equal(saved.configPath, FILE)

  const eff = loadEffective({ file: FILE, env: {}, base: {}, io })
  assert.equal(eff.config.model, 'minimax-cn/MiniMax-M3')
  assert.equal(eff.config.detail, 'deep')
  assert.equal(eff.fileError, null, '刚写出来的文件必须能被读回')
})

test('坏 JSON：读不炸，但把错误带出来；保存时拒绝覆盖（409）', () => {
  const { io } = memIo({ [FILE]: '{ 这不是 JSON' })
  const read = readConfigFile(FILE, io)
  assert.deepEqual(read.config, {})
  assert.match(read.error, /JSON/)

  const saved = savePatch({ incoming: { model: 'a/b' }, file: FILE, io })
  assert.equal(saved.ok, false)
  assert.equal(saved.status, 409)
})

test('候选与白名单：界面下拉的候选都在 EDITABLE 白名单的语义内', () => {
  assert.ok(MODEL_CANDIDATES.length >= 2)
  for (const c of MODEL_CANDIDATES) {
    assert.equal(typeof c.value, 'string')
    assert.ok(c.value.includes('/'), '候选必须是 provider/model 形状')
    assert.equal(typeof c.note, 'string')
  }
  assert.ok(EDITABLE.model && EDITABLE.detail && EDITABLE.concurrency && EDITABLE.maxWallClockMs)
  assert.equal(EDITABLE.detail.kind, 'enum')
  assert.deepEqual(EDITABLE.detail.values, ['quick', 'standard', 'deep'])
  assert.ok(CONFIG_FILE.endsWith('dsh-video.config.json'))
})

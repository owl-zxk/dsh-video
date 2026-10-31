
// 真宿主端到端（**默认跳过**）：DSH_VIDEO_E2E=1 且宿主注入了真 llm / attachments 才真跑
//
// 为什么不是「直接 import lib/index.js 跑一遍」：那个文件要 @deepseek-ai/schemastery /
// dsh-tools / dsh-llm，裸 node 解析不到（契约 §18 实测 MODULE_NOT_FOUND），tests 里也不许 import 它。
// 真跑需要的东西只有宿主进程里有：一个活着的 ctx.llm 与 ctx.attachments。所以这里约定一个**最小的**
// 接缝 —— 宿主在跑这个测试之前挂上：
//
//   globalThis.__dshVideoE2E = { llm, attachments, provider?, model? }
//
// 缺了它就 t.skip()，而不是造一个假 llm 硬跑：假 llm 跑出来的东西证明不了「真宿主能跑通」，
// 那种绿灯比红灯更坏（契约 §16：需要真 API key 的用例检测环境变量，否则 skip，不要让 CI 红）。
//
// 注意：这一条在本机**没有验过**（沙箱里既没有宿主 ctx 也没有 key）。如实标注，不写成已验证。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { run } from '../lib/media/ffmpeg.js'
import { TIMING_KEYS } from '../lib/util/perf.js'
import { resolveBinaries } from '../lib/util/paths.js'
import { runUnderstand } from '../lib/capabilities/understand.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 端到端专用素材（独立名字：这条用例只在手动开启时才会生成，不和别的用例抢文件）。 */
const ASSET = path.join(ROOT, 'test-assets', 'e2e-host6s.mp4')
const ASSET_MIN_BYTES = 12000

const sizeOf = (file) => { try { return fs.statSync(file).size } catch { return 0 } }

/** §2.6 的 17 个键。 */
const RESULT_KEYS = [
  'source', 'durationMs', 'width', 'height', 'fps', 'hasAudio', 'model', 'framesAnalyzed',
  'reframes', 'scenes', 'transcript', 'summary', 'answer', 'failures', 'timings',
  'concurrency', 'estimatedCostUsd'
]

const ENABLED = process.env.DSH_VIDEO_E2E === '1'
const HOST = globalThis.__dshVideoE2E === undefined ? null : globalThis.__dshVideoE2E
const HAS_HOST = HOST !== null && typeof HOST === 'object'
  && HOST.llm !== null && typeof HOST.llm === 'object' && typeof HOST.llm.stream === 'function'
  && HOST.attachments !== null && typeof HOST.attachments === 'object' && typeof HOST.attachments.admitPromptContent === 'function'

const SKIP = !ENABLED
  ? '没设 DSH_VIDEO_E2E=1（真端到端要真 key 与真宿主，默认跳过）'
  : (HAS_HOST ? false : '宿主没注入 globalThis.__dshVideoE2E = { llm, attachments } —— 这一条在本机没验过')

/** 6s / 320x180 / 25fps / 无声：端到端只要「结构完整、scenes 非空」，不需要长素材。 */
async function ensureAsset () {
  if (sizeOf(ASSET) >= ASSET_MIN_BYTES) return ASSET
  const bin = resolveBinaries().ffmpeg
  if (!bin || !fs.existsSync(bin)) throw new Error('缺 ffmpeg，生成不了端到端素材：' + String(bin))
  fs.mkdirSync(path.dirname(ASSET), { recursive: true })
  const r = await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'smptehdbars=size=320x180:rate=25:duration=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    ASSET
  ], { timeoutMs: 180000 })
  if (!r.ok || sizeOf(ASSET) < ASSET_MIN_BYTES) throw new Error('生成端到端素材失败：' + String(r.stderr ?? '').slice(-400))
  return ASSET
}

test('端到端：对 e2e- 素材真跑一次 video_understand（quick），断言返回结构完整', { skip: SKIP }, async () => {
  const asset = await ensureAsset()
  const config = {}
  if (typeof HOST.provider === 'string' && HOST.provider !== '') config.provider = HOST.provider
  if (typeof HOST.model === 'string' && HOST.model !== '') config.model = HOST.model

  const out = await runUnderstand(
    { path: asset, detail: 'quick', question: '这个视频在讲什么？' },
    { llm: HOST.llm, attachments: HOST.attachments, config }
  )

  assert.deepEqual(Object.keys(out), RESULT_KEYS, '17 个键一个不少')
  assert.deepEqual(Object.keys(out.timings), TIMING_KEYS)
  assert.ok(out.durationMs > 0, '真宿主要读出时长')
  assert.ok(out.scenes.length >= 1, '真模型必须看出至少一段画面：' + JSON.stringify(out.failures))
  assert.ok(out.summary.length > 0, '真模型必须给出总结：' + JSON.stringify(out.failures))
  assert.equal(out.answer.length > 0, true)
  assert.ok(out.model.length > 0)
  assert.ok(out.estimatedCostUsd > 0, '成本必须算得出来（model 传进 estimateCostUsd 了）')
  assert.deepEqual(out.reframes, [], 'quick 档默认关闭重采样')
  for (const scene of out.scenes) {
    assert.ok(scene.endMs > scene.startMs)
    assert.ok(Array.isArray(scene.frames) && scene.frames.length > 0)
  }
})

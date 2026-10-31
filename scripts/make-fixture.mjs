// 测试素材生成器 —— 本机现生成，不下载任何东西（契约 §16）
//
// 为什么不用现成的样例视频：
//   ① 联网下载在 CI / 离线机器上直接失败，测试就成了"看运气"；
//   ② 我们需要**特定属性**的素材来卡边界：8s/640x360/带音轨、无音轨、多场景硬切、
//      45s 长片（≥40 帧那条抽帧分支必须有人喂它）。合成的比下载的更能钉住断言。
//
// 为什么带 minBytes 而不是"文件存在就跳过"：一次生成到一半被打断（Ctrl-C、磁盘满）会留下
//   一个 0 字节的 mp4，之后每次跑测试都"存在"，然后 probe 全红。用最小字节数当健康检查。
//
// 注意：test-assets/ 不进 git（D 组写 .gitignore）；本脚本只负责 mkdir，不碰 .gitignore。
// 为什么文件名都带 media- 前缀：test-assets/ 是**多个组共用**的目录，B 组（音频）自己会写
// noaudio.mp4（实测 2s/320x180）。名字撞上就是互相覆盖 —— 我的 8s 静音素材曾被别人的
// 1s 版本替掉，probe 断言随即莫名其妙地红。带前缀 + 各自的名字，才是能并行开发的前提。
// 用法：node scripts/make-fixture.mjs [--force]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../lib/media/ffmpeg.js'
import { resolveBinaries } from '../lib/util/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 素材落地目录（仓库根的 test-assets/）。 */
export const FIXTURE_DIR = path.resolve(HERE, '..', 'test-assets')

const V = '-c:v libx264 -pix_fmt yuv420p' // 常量放注释里说明，见下：参数必须是数组，所以只能展开

const SPECS = [
  {
    file: 'media-basic8s.mp4',
    minBytes: 20000,
    why: '契约 §4 的合成样例：8s/640x360/25fps testsrc2 + 440Hz 正弦音轨',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
    ],
  },
  {
    file: 'media-silent8s.mp4',
    minBytes: 15000,
    why: '无音轨不是错误（契约 §6）：hasAudio 必须 false 且不抛',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
    ],
  },
  {
    file: 'media-scenes9s.mp4',
    minBytes: 20000,
    why: '三段硬切（9s）：场景检测必须能返回 ≥1 个升序时间戳',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'smptehdbars=size=640x360:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'color=c=0x204060:size=640x360:rate=25:duration=3',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    ],
  },
  {
    file: 'media-long45s.mp4',
    minBytes: 40000,
    why: '45s 三段硬切：maxFrames=40 时规划出的帧数能达到 ≥40，用来测「一次 fps 全量输出」那条分支',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=15',
      '-f', 'lavfi', '-i', 'smptehdbars=size=640x360:rate=25:duration=15',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=15,negate',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ],
  },
]

/** 素材清单（名字 → 用途），测试按名字取。 */
export const FIXTURES = Object.freeze(SPECS.map((s) => s.file))

const sizeOf = (f) => {
  try { return fs.statSync(f).size } catch { return 0 }
}

/**
 * 确保素材存在；缺的（或太小的）才生成。
 * @param {{ ffmpeg?: string, dir?: string, force?: boolean, timeoutMs?: number, log?: (s:string)=>void }} [opts]
 * @returns {Promise<Record<string, string>>} 名字 → 绝对路径
 */
export async function ensureFixtures(opts = {}) {
  const dir = opts.dir || FIXTURE_DIR
  const bin = opts.ffmpeg || resolveBinaries().ffmpeg
  const log = opts.log || (() => {})
  if (!bin) throw new Error('没有 ffmpeg，无法生成测试素材')
  fs.mkdirSync(dir, { recursive: true })

  const out = {}
  for (const spec of SPECS) {
    const file = path.join(dir, spec.file)
    out[spec.file] = file
    if (!opts.force && sizeOf(file) >= spec.minBytes) continue
    log(`生成 ${spec.file} —— ${spec.why}`)
    const r = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...spec.args, file], {
      timeoutMs: opts.timeoutMs ?? 180000,
    })
    if (!r.ok || sizeOf(file) < spec.minBytes) {
      throw new Error(`生成测试素材失败：${spec.file}\n${String(r.stderr || r.error || '').slice(-800)}`)
    }
  }
  return out
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isCli) {
  const force = process.argv.includes('--force')
  ensureFixtures({ force, log: (s) => console.log(s) })
    .then((files) => {
      for (const [name, file] of Object.entries(files)) {
        console.log(`${name}\t${sizeOf(file)} bytes\t${file}`)
      }
      console.log(`素材就绪：${FIXTURE_DIR}`)
    })
    .catch((e) => {
      console.error(String(e?.message ?? e))
      process.exitCode = 1
    })
}
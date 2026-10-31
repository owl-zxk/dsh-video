/**
 * 繁 → 简转换（纯查表，零依赖）
 *
 * 为什么要它（本项目自己的实测，不是抄来的理论）：
 *   whisper small 对真实视频人声输出的就是繁体。用户素材 BV1DubxzVEPB 前 20 秒的真实转录：
 *   「花四個月時間給貓咪小鎮做的地鐵站和地鐵今天終於通車了」。
 *   用 --prompt 诱导简体这条路 dsh-bili-whale 试过四种写法，全部无效、还会诱发幻觉，
 *   所以只能在输出侧转码（契约 §9.1 因此把它列为必须）。
 *
 * 为什么内嵌词表而不是装 opencc-js：
 *   插件要自包含 —— 用户不被允许 npm install，运行期也不联网。两份 OpenCC 数据合计 111 KB：
 *     TSPhrases.txt     498 条  短语级（长词优先，处理「一目瞭然 → 一目了然」这种）
 *     TSCharacters.txt 4148 条  单字级（兜底）
 *   数据逐字节拷自 OpenCC（Apache-2.0），许可证声明保留在数据文件头部，另见 assets/opencc/LICENSE。
 *
 * 为什么要短语表 + 单字表两张：
 *   一对多映射（乾→干/乾、著→着/著、覆→复/覆）单看一个字选不对；短语表覆盖常见组合，
 *   剩下的才退回单字。长词优先匹配，否则「一坏」会被拆成两个单字各转一次。
 *
 * 为什么 fail-open（词表缺失就原样返回）：
 *   裁剪安装 / 打包漏文件时宁可吐繁体，也不能让整条转录链路炸掉或记一条 failure ——
 *   繁简是输出质量问题，不是功能失败。词表按目录分族缓存，测试才能把目录指到不存在的路径
 *   而不污染已经加载好的默认词表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.resolve(HERE, '..', '..', 'assets', 'opencc')
const PHRASES_FILE = 'TSPhrases.txt'
const CHARACTERS_FILE = 'TSCharacters.txt'

// 目录 -> { phraseMap, charMap, maxPhraseLen, ready }
const cache = new Map()

function loadMap(dir, file) {
  const map = new Map()
  let txt = ''
  try {
    txt = fs.readFileSync(path.join(dir, file), 'utf8')
  } catch {
    return map // fail-open：读不到就是空表，转换退化成恒等
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('\t')
    if (i < 0) continue
    const key = line.slice(0, i)
    // 一个繁体可能对应多个候选（空格分隔）—— 取第一个，OpenCC 就是按这个顺序排优先级的
    const val = line.slice(i + 1).trim().split(/\s+/)[0]
    if (key && val) map.set(key, val)
  }
  return map
}

function dictFor(dir) {
  const key = String(dir ?? DEFAULT_DIR)
  const hit = cache.get(key)
  if (hit) return hit
  const phraseMap = loadMap(key, PHRASES_FILE)
  const charMap = loadMap(key, CHARACTERS_FILE)
  let maxPhraseLen = 2
  for (const k of phraseMap.keys()) if (k.length > maxPhraseLen) maxPhraseLen = k.length
  const dict = { dir: key, phraseMap, charMap, maxPhraseLen, ready: phraseMap.size > 0 && charMap.size > 0 }
  cache.set(key, dict)
  return dict
}

/**
 * 加载词表（幂等，按目录缓存）。
 * @param {{ dir?: string }} [opts] 词表目录，默认 assets/opencc（测试用它制造"词表缺失"）
 * @returns {{ phrases: number, chars: number, maxPhraseLen: number, ready: boolean }}
 */
export function ensureLoaded(opts = {}) {
  const d = dictFor(opts?.dir)
  return { phrases: d.phraseMap.size, chars: d.charMap.size, maxPhraseLen: d.maxPhraseLen, ready: d.ready }
}

/**
 * 繁体 → 简体。已经是简体时原样返回（幂等）。
 * @param {string} text
 * @param {{ dir?: string }} [opts]
 * @returns {string}
 */
export function toSimplified(text, opts = {}) {
  const s = String(text ?? '')
  if (!s) return s
  const d = dictFor(opts?.dir)
  if (!d.ready) return s // fail-open
  let out = ''
  let i = 0
  while (i < s.length) {
    // 长词优先
    let matched = false
    for (let len = Math.min(d.maxPhraseLen, s.length - i); len >= 2; len -= 1) {
      const hit = d.phraseMap.get(s.slice(i, i + len))
      if (hit) {
        out += hit
        i += len
        matched = true
        break
      }
    }
    if (matched) continue
    // 单字兜底；表情 / 生僻字是代理对，不能按一个 code unit 切
    const code = s.charCodeAt(i)
    const ch = code >= 0xd800 && code <= 0xdbff ? s.slice(i, i + 2) : s[i]
    out += d.charMap.get(ch) ?? ch
    i += ch.length
  }
  return out
}

/**
 * 文本里有没有可能需要转换的字（让调用方跳过无谓处理）。
 * 单字表命中不了时再看短语表 —— 只靠单字表会漏掉"只有短语里才出现的繁体组合"。
 * @param {string} text
 * @param {{ dir?: string }} [opts]
 * @returns {boolean}
 */
export function hasTraditional(text, opts = {}) {
  const s = String(text ?? '')
  if (!s) return false
  const d = dictFor(opts?.dir)
  if (!d.ready) return false // fail-open：没有词表就当作"没繁体要转"
  for (let i = 0; i < s.length; i += 1) {
    if (d.charMap.has(s[i])) return true
    for (let len = Math.min(d.maxPhraseLen, s.length - i); len >= 2; len -= 1) {
      if (d.phraseMap.has(s.slice(i, i + len))) return true
    }
  }
  return false
}

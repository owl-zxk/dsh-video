#!/usr/bin/env node
// 发布前检查 —— 只做「不依赖外部环境、但发错就必崩」的三件事。
//
// 为什么不在这里跑那 110 个测试：
//   它们要真 ffmpeg 与 whisper.cpp。发布机器的环境各不相同，缺一个就会让
//   prepublishOnly 失败 —— 而缺依赖本来只该让真用例「跳过」。完整测试交给 CI：
//   那里 ffmpeg 是 apt 装好的、退出码可信（已实测 Node 20/22 双绿）。
// 发布前该挡的是「装上就崩」，不是「这台机器装没装 ffmpeg」。
//
// 这里挡三类：
//   ① 语法错            → 插件加载阶段直接抛
//   ② 包名 ≠ patch 的 name → 表现是「装上了但没有工具」，最难排查
//   ③ 词表缺失          → 繁转简会静默 fail-open（不报错，但功能悄悄降级）

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function fail (message) {
  console.error('✗ ' + message)
  process.exit(1)
}

// ① 语法：lib/ 下每个 .js 都要能 --check 过
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) return walk(full)
  return full.endsWith('.js') ? [full] : []
})
const jsFiles = walk(path.join(ROOT, 'lib'))
if (jsFiles.length === 0) fail('lib/ 下一个 .js 都没有，打包配置大概写错了')
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    fail('语法错误 ' + path.relative(ROOT, file) + String.fromCharCode(10) + String(error.stderr ?? ''))
  }
}
console.log('✓ 语法：' + jsFiles.length + ' 个文件')

// ② 包名必须与 cordis.patch.yml 的 name 完全一致（否则装上了也没有工具）
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patchLines = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
const nameLine = patchLines.map((line) => line.trim()).find((line) => line.startsWith('name:'))
const patchName = nameLine === undefined ? '' : nameLine.slice('name:'.length).trim()
if (patchName !== manifest.name) {
  fail('包名不一致：package.json name=' + JSON.stringify(manifest.name) +
    ' 而 cordis.patch.yml name=' + JSON.stringify(patchName) +
    String.fromCharCode(10) + '  两者必须完全相同，否则装上了但不会有工具。')
}
const idLine = patchLines.map((line) => line.trim()).find((line) => line.startsWith('- id:'))
const patchId = idLine === undefined ? '' : idLine.slice('- id:'.length).trim()
if (patchId === '') fail('cordis.patch.yml 缺少 id')
console.log('✓ 包名一致：' + manifest.name + '（patch id=' + patchId + '）')

// ③ 词表必须在：缺了繁转简会静默 fail-open，功能降级却看不出来
const dictionary = path.join(ROOT, 'assets', 'opencc', 'TSCharacters.txt')
if (!fs.existsSync(dictionary)) fail('缺 assets/opencc/TSCharacters.txt：繁转简会静默失效')
const lines = fs.readFileSync(dictionary, 'utf8').split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#')).length
if (lines < 1000) fail('词表行数异常（' + lines + '），大概被截断或转码坏了')
console.log('✓ 词表：' + lines + ' 条')

// ④ files 里声明的每一项都得真的存在
for (const entry of manifest.files ?? []) {
  if (!fs.existsSync(path.join(ROOT, entry))) fail('files 里声明了 ' + entry + ' 但它不存在')
}
console.log('✓ files：' + (manifest.files ?? []).length + ' 项都在')

console.log('\n发布前检查通过：' + manifest.name + '@' + manifest.version)

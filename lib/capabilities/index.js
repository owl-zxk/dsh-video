// 全部能力的清单 —— lib/index.js 只按这个数组循环注册
//
// 为什么单独一个文件而不是在入口里 import 每一项：将来加「生成视频 / 剪辑 / 字幕」时，
// 这里加一行 import + 一个数组成员就完事，入口文件（最容易改坏的那一个）一个字都不用动。
// 顺序即注册顺序，注册表会拒绝重复的 id / tool.name（registry.js 负责）。

import { understandCapability } from './understand.js'

export { understandCapability }

/** 已实现的能力。以后只往这里加，不动 understand.js，也不动 lib/index.js。 */
export const capabilities = Object.freeze([understandCapability])

// ffmpeg / ffprobe 的 async spawn 封装 —— 全插件唯一的子进程接缝
//
// 为什么必须是 async spawn，而不是 spawnSync / execFileSync：
//   抽帧和视觉批次要并发（PROMPT §2.7.5）。spawnSync 会把事件循环整段堵住，
//   并发退化成排队 —— 看起来同时在跑，实际一个接一个。所以这里一律
//   child_process.spawn + Promise，绝不同步等待。
//
// 为什么参数是**数组**而不是拼字符串：PowerShell 会把 $i:v 当变量吃掉、
//   [0:v]scale= 会变成 scale=（契约 §1、PROMPT §0）。数组进 argv，一个字符都不会被解释。
//
// 为什么 run() 永不 throw：整条管线对"工具不可用"的唯一正确反应是
//   failures 里写一条、结构化成空数组继续（PROMPT §2.6、契约 §13）。如果这里抛，
//   上层每一处调用都得包 try/catch，漏一处就把异常漏给 DSH。
//   超时 → code='TIMEOUT'，中止 → code='ABORTED'，起不来 → code='SPAWN_FAILED'。
//
// 为什么有"命名管道失败 → 临时文件重定向"这条备用路径：
//   DSH 的受限执行环境（以及部分企业策略 / 容器）**禁止子进程开匿名管道**，
//   spawn 会直接抛 EPERM —— 此时 stdout/stderr 一个字都拿不到，而场景检测全靠 stderr。
//   所以第一次用 pipe 起（正常环境最快、不落盘）；只有 spawn 因权限失败时，
//   才把 stdout/stderr 重定向到临时文件再读回来。重定向是"起一个新进程"，
//   不是续跑同一个进程 —— 对 ffmpeg 这类幂等命令完全等价。
//
// 为什么 stdout/stderr 要设上限：场景检测的 showinfo 一行一帧，长视频 stderr 能有几十 MB；
//   全量 Buffer.concat 会让一次检测吃掉几百 MB 内存。超过 8 MiB 只留尾巴（时间戳都在其中）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_CAPTURE = 8 * 1024 * 1024
const PIPE_DENIED = /EPERM|EACCES|ENOTSUP|ENOSYS/

const tail = (buf) => (buf.length > MAX_CAPTURE ? buf.subarray(buf.length - MAX_CAPTURE) : buf)

/**
 * 跑一次子进程（pipe 或临时文件两种捕获方式）。
 * @returns {Promise<{ ok: boolean, status: number|null, stdout: any, stderr: any, code?: string, error?: string }>}
 */
function exec(bin, args, opts, useFiles) {
  const { timeoutMs = 120000, signal, encoding = 'utf8' } = opts || {}
  const decode = (buf) => (encoding === 'buffer' ? buf : buf.toString(encoding || 'utf8'))
  const blank = { stdout: decode(Buffer.alloc(0)), stderr: decode(Buffer.alloc(0)) }

  if (!bin || typeof bin !== 'string') {
    return Promise.resolve({ ok: false, status: null, ...blank, code: 'SPAWN_FAILED', error: '没有可执行的二进制路径' })
  }
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, status: null, ...blank, code: 'ABORTED', error: '调用前已被中止' })
  }

  let tmpDir = null
  let fdOut = null
  let fdErr = null
  let stdio = ['ignore', 'pipe', 'pipe']
  try {
    if (useFiles) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-io-'))
      fdOut = fs.openSync(path.join(tmpDir, 'out'), 'w')
      fdErr = fs.openSync(path.join(tmpDir, 'err'), 'w')
      stdio = ['ignore', fdOut, fdErr]
    }
    const out = []
    const err = []
    return new Promise((resolve) => {
      let settled = false
      let child = null
      let timer = null
      let graceTimer = null

      const cleanupFiles = () => {
        for (const fd of [fdOut, fdErr]) {
          try { if (fd != null) fs.closeSync(fd) } catch { /* 已关 */ }
        }
        fdOut = null
        fdErr = null
      }

      const readFiles = () => {
        cleanupFiles()
        if (!tmpDir) return { out: Buffer.alloc(0), err: Buffer.alloc(0) }
        const read = (f) => {
          try { return tail(fs.readFileSync(f)) } catch { return Buffer.alloc(0) }
        }
        const r = { out: read(path.join(tmpDir, 'out')), err: read(path.join(tmpDir, 'err')) }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结果 */ }
        tmpDir = null
        return r
      }

      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (graceTimer) clearTimeout(graceTimer)
        if (signal) signal.removeEventListener('abort', onAbort)
        let stdout = decode(tail(Buffer.concat(out)))
        let stderr = decode(tail(Buffer.concat(err)))
        if (useFiles) {
          const files = readFiles()
          stdout = decode(files.out) || stdout
          stderr = decode(files.err) || stderr
        } else {
          cleanupFiles()
        }
        resolve({ status: null, ...blank, stdout, stderr, ...result })
      }

      const kill = (code) => {
        try { child?.kill('SIGKILL') } catch { /* 已经退出就无所谓 */ }
        // kill 在 Windows 上偶尔不触发 close；给 2s 兜底，避免管线卡死在一个死进程上
        if (!graceTimer) {
          graceTimer = setTimeout(() => finish({ ok: false, status: null, code, error: '进程未响应 kill' }), 2000)
          graceTimer.unref?.()
        }
      }

      const onAbort = () => {
        kill('ABORTED')
        finish({ ok: false, status: null, code: 'ABORTED', error: '调用被中止' })
      }

      try {
        child = spawn(bin, Array.isArray(args) ? args : [], { windowsHide: true, stdio })
      } catch (e) {
        finish({ ok: false, status: null, code: 'SPAWN_FAILED', error: String(e?.message ?? e) })
        return
      }

      child.stdout?.on('data', (b) => out.push(b))
      child.stderr?.on('data', (b) => err.push(b))
      child.on('error', (e) => {
        finish({ ok: false, status: null, code: 'SPAWN_FAILED', error: String(e?.message ?? e) })
      })
      child.on('close', (status) => {
        finish({ ok: status === 0, status, code: status === 0 ? undefined : 'EXIT_NONZERO' })
      })

      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          kill('TIMEOUT')
          finish({ ok: false, status: null, code: 'TIMEOUT', error: `超时 ${timeoutMs}ms` })
        }, timeoutMs)
        timer.unref?.()
      }
    })
  } catch (e) {
    for (const fd of [fdOut, fdErr]) {
      try { if (fd != null) fs.closeSync(fd) } catch { /* 忽略 */ }
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    return Promise.resolve({ ok: false, status: null, ...blank, code: 'SPAWN_FAILED', error: String(e?.message ?? e) })
  }
}

/**
 * 跑一个子进程并收集输出。**永不 throw**（参数非法、可执行文件不存在、超时、中止都一样）。
 * @param {string} bin 可执行文件绝对路径
 * @param {string[]} args 参数数组（绝不拼字符串）
 * @param {{ timeoutMs?: number, signal?: AbortSignal, encoding?: string|'buffer' }} [opts]
 * @returns {Promise<{ ok: boolean, status: number|null, stdout: any, stderr: any, code?: string, error?: string }>}
 */
export async function run(bin, args, opts = {}) {
  const first = await exec(bin, args, opts, false)
  if (first.code !== 'SPAWN_FAILED' || !PIPE_DENIED.test(String(first.error || ''))) return first
  // 受限环境：匿名管道被策略禁掉，退到临时文件重定向再起一次（见文件头注释）
  return exec(bin, args, opts, true)
}

/** 前置 -hide_banner -loglevel error：正常路径不要往 stderr 里灌噪音。 */
export async function ffmpeg(binPath, args, opts = {}) {
  const { runImpl = run, ...rest } = opts || {}
  return runImpl(binPath, ['-hide_banner', '-loglevel', 'error', ...(args || [])], rest)
}

/**
 * ffprobe → 解析后的 JSON；任何失败都返回 null（调用方自己决定抛不抛）。
 * runImpl 透传：契约 §5 没点名它，但 §6 的 probe 要靠这个接缝注入假 run。
 */
export async function ffprobeJSON(binPath, args, opts = {}) {
  const { runImpl = run, ...rest } = opts || {}
  const r = await runImpl(binPath, ['-hide_banner', '-v', 'error', ...(args || [])], rest)
  if (!r?.ok) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

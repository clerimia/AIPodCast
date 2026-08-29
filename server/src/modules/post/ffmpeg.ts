// ffmpeg/ffprobe CLI 运行器：post 流水线的全部子进程都从这里出（args 数组、不经 shell）。
// 子进程登记进模块级 Set，进程退出时统一 kill（Windows 上父进程死亡不自动杀子进程，
// docs/synthesis-progress-and-cancel.md 验证项 5）。步骤超时 kill 并按 SYNTH_POST_FAILED 报。
import { spawn } from 'node:child_process'
import { AppError } from '../../shared/errors.js'

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000

const running = new Set<ReturnType<typeof spawn>>()

/** 进程退出时清理在途 ffmpeg/ffprobe（app.onClose 调） */
export function killRunningFfmpeg(): void {
  for (const child of running) {
    child.kill()
  }
  running.clear()
}

export interface CliResult {
  stdout: string
  stderr: string
}

/** 跑一步 ffmpeg/ffprobe；非零退出 / 超时 → AppError SYNTH_POST_FAILED（stderr 尾部入 message） */
export function runFfCli(
  bin: 'ffmpeg' | 'ffprobe',
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    running.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
    }, timeoutMs)

    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new AppError('SYNTH_POST_FAILED', message, 500))
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      fail(`${bin} 启动失败：${err.message}（本机需安装 ffmpeg 8.x 并在 PATH）`)
    })
    child.on('close', (code) => {
      running.delete(child)
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        fail(`${bin} 退出码 ${code}：${stderrTail(stderr)}`)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function stderrTail(stderr: string): string {
  const lines = stderr.trim().split('\n')
  return lines.slice(-3).join(' ').slice(0, 500)
}

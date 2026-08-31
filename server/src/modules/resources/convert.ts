// 文件 → markdown：.md/.txt 直读；.docx/.pdf 写临时文件后子进程调
// `uvx --from markitdown[docx,pdf] markitdown <file>`（stdout = markdown，60s 超时）。
// spike 3 结论：extras 必须含 docx（裸 [pdf] 拒收 .docx）；Windows 需强制 UTF-8
// 输出（否则 GBK 乱码）。失败 = 400 可读错误；临时文件 finally 清理，
// 转换失败零库行残留（落库在转换成功之后，见 service.ts）。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'

export type ResourceKind = 'md' | 'txt' | 'docx' | 'pdf' | 'paste'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_PASTE_CHARS = 200_000
const CONVERT_TIMEOUT_MS = 60_000

const EXT_TO_KIND: Record<string, 'md' | 'txt' | 'docx' | 'pdf'> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf',
}

export function kindFromFilename(filename: string): 'md' | 'txt' | 'docx' | 'pdf' | null {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_TO_KIND[filename.slice(dot).toLowerCase()] ?? null
}

export type CliRunner = (file: string, timeoutMs: number) => Promise<string>

/** 默认 runner：uvx markitdown；非零退出/超时/启动失败 → 400「文件解析失败」 */
export const runMarkitdown: CliRunner = (file, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('uvx', ['--from', 'markitdown[docx,pdf]', 'markitdown', file], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const fail = (message: string) => {
      clearTimeout(timer)
      reject(new AppError('BAD_REQUEST', message, 400))
    }
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('error', (err) => fail(`文件解析失败：markitdown 启动失败（本机需安装 uv 并在 PATH）：${err.message}`))
    child.on('close', (code) => {
      if (timedOut) {
        fail(`文件解析失败：转换超时（${Math.round(timeoutMs / 1000)}s）`)
        return
      }
      if (code !== 0) {
        fail(`文件解析失败：markitdown 退出码 ${code}：${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`)
        return
      }
      clearTimeout(timer)
      resolve(stdout)
    })
  })

export async function convertToMarkdown(
  buffer: Buffer,
  filename: string,
  opts: { runCli?: CliRunner } = {},
): Promise<{ kind: 'md' | 'txt' | 'docx' | 'pdf'; markdown: string }> {
  const kind = kindFromFilename(filename)
  if (!kind) {
    throw new AppError('BAD_REQUEST', `不支持的文件类型：${filename}（支持 .md/.txt/.docx/.pdf）`, 400)
  }
  if (kind === 'md' || kind === 'txt') {
    return { kind, markdown: buffer.toString('utf8') }
  }
  const runCli = opts.runCli ?? runMarkitdown
  const dir = await mkdtemp(join(tmpdir(), 'aipodcast-convert-'))
  const file = join(dir, `${randomUUID()}.${kind}`)
  try {
    await writeFile(file, buffer)
    const markdown = await runCli(file, CONVERT_TIMEOUT_MS)
    if (markdown.trim() === '') {
      throw new AppError('BAD_REQUEST', '文件解析失败：转换结果为空', 400)
    }
    return { kind, markdown }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Spike 3：uvx markitdown CLI：冷启动时长、参数与输出形态、二进制转换产物。
// 探针结论：extras 必须含 [docx]——裸 [pdf] 对 .docx 报「dependencies needed」，
// 故 convert.ts 的 spawn 参数用 markitdown[docx,pdf]。
// Windows 上 stdout 默认走 locale 码页（本机 GBK）会乱码，须注入
// PYTHONIOENCODING=utf-8 / PYTHONUTF8=1；convert.ts 同样要带这两个环境变量。
// 夹具由 test/fixtures.ts 手写生成（最小 docx/pdf，不引第三方库）。
// 用法：npm run spike-markitdown -w server（本机需安装 uv 并在 PATH）
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDocxFixture, makePdfFixture } from '../test/fixtures.js'

function runMarkitdown(fileBytes: Buffer, filename: string): Promise<{ ms: number; stdout: string; stderr: string; code: number | null }> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spike-markitdown-'))
    const file = join(dir, filename)
    await writeFile(file, fileBytes)
    const startedAt = Date.now()
    try {
      return await new Promise<{ ms: number; stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn('uvx', ['--from', 'markitdown[docx,pdf]', 'markitdown', file], {
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
        child.on('error', (err) => resolve({ ms: Date.now() - startedAt, stdout, stderr: String(err), code: null }))
        child.on('close', (code) => resolve({ ms: Date.now() - startedAt, stdout, stderr, code }))
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
}

const docx = makeDocxFixture(['这是文档第一段。', '第二段提到量子计算。'])
const r1 = await runMarkitdown(docx, 'sample.docx')
console.log('docx：', r1.ms, 'ms；code=', r1.code)
console.log(r1.stdout)
if (r1.code !== 0 || !r1.stdout.includes('量子计算')) {
  throw new Error('docx 转换未达预期：' + r1.stderr.slice(-300))
}

const pdf = makePdfFixture('PDF 正文：播客后期流水线')
const r2 = await runMarkitdown(pdf, 'sample.pdf')
console.log('pdf：', r2.ms, 'ms；code=', r2.code)
console.log(r2.stdout)
if (r2.code !== 0 || !r2.stdout.includes('播客后期流水线')) {
  console.log('注意：最小 pdf 未被提取出文本时，把该事实记入结论（集成测试对该夹具降级断言「转换不报错」）')
}
console.log('SPIKE OK：把冷启动时长/参数形态/失败退出码结论写入 docs/research/knowledge-retrieval-spikes.md')

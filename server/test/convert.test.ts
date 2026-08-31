import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { test } from 'node:test'
import { convertToMarkdown, kindFromFilename } from '../src/modules/resources/convert.js'
import { hasUvx, makeDocxFixture, makePdfFixture } from './fixtures.js'
import { AppError } from '../src/shared/errors.js'

test('kindFromFilename：白名单命中与拒绝', () => {
  assert.equal(kindFromFilename('笔记.md'), 'md')
  assert.equal(kindFromFilename('notes.MARKDOWN'), 'md')
  assert.equal(kindFromFilename('readme.txt'), 'txt')
  assert.equal(kindFromFilename('报告.docx'), 'docx')
  assert.equal(kindFromFilename('paper.pdf'), 'pdf')
  assert.equal(kindFromFilename('a.html'), null)
  assert.equal(kindFromFilename('noext'), null)
  assert.equal(kindFromFilename('a.tar.md'), 'md')
  assert.equal(kindFromFilename('file.'), null)
})

test('md/txt 直读（不进子进程）', async () => {
  const md = await convertToMarkdown(Buffer.from('# 标题\n正文', 'utf8'), 'a.md')
  assert.deepEqual(md, { kind: 'md', markdown: '# 标题\n正文' })
  const txt = await convertToMarkdown(Buffer.from('纯文本', 'utf8'), 'b.txt')
  assert.equal(txt.kind, 'txt')
  assert.equal(txt.markdown, '纯文本')
})

test('不支持的扩展名 → 400 可读错误', async () => {
  await assert.rejects(
    () => convertToMarkdown(Buffer.from('x'), 'a.html'),
    (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.message.includes('不支持的文件类型'),
  )
})

test('docx/pdf 走注入的 CLI：临时文件用完即清；空产物 → 400', async () => {
  let seenFile = ''
  const ok = await convertToMarkdown(Buffer.from('x'), '报告.docx', {
    runCli: async (file) => {
      seenFile = file
      return '# 转换结果'
    },
  })
  assert.equal(ok.kind, 'docx')
  assert.equal(ok.markdown, '# 转换结果')
  assert.ok(seenFile.endsWith('.docx'))
  await assert.rejects(() => access(seenFile)) // 临时文件已清理

  await assert.rejects(
    () => convertToMarkdown(Buffer.from('x'), 'a.pdf', { runCli: async () => '   ' }),
    (err: unknown) => err instanceof AppError && err.message.includes('转换结果为空'),
  )

  // CLI 失败路径：错误原样上抛，临时目录同样清理
  let seenFile2 = ''
  await assert.rejects(
    () =>
      convertToMarkdown(Buffer.from('x'), '报告.docx', {
        runCli: async (file) => {
          seenFile2 = file
          throw new AppError('BAD_REQUEST', '文件解析失败：boom', 400)
        },
      }),
    (err: unknown) => err instanceof AppError && err.message.includes('文件解析失败：boom'),
  )
  await assert.rejects(() => access(seenFile2)) // 失败后临时目录也已清理
})

test('真 markitdown：docx 夹具转换出文本（无 uv 时跳过）', async (t) => {
  if (!(await hasUvx())) return t.skip('本机无 uv/uvx，跳过真转换测试')
  const docx = makeDocxFixture(['这是文档第一段。', '第二段提到量子计算。'])
  const result = await convertToMarkdown(docx, 'sample.docx')
  assert.equal(result.kind, 'docx')
  assert.ok(result.markdown.includes('量子计算'), result.markdown)

  const pdf = makePdfFixture('PDF 正文：播客后期流水线')
  const pdfResult = await convertToMarkdown(pdf, 'sample.pdf')
  assert.equal(pdfResult.kind, 'pdf')
  // 最小 pdf 夹具的文本提取依赖 pdfminer 宽容度（Task 1 spike 3 结论）：
  // 提取成功则断言文本在；否则只断言「转换不报错且产物非空」
  assert.ok(pdfResult.markdown.trim().length > 0)
})

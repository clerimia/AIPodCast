import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkMarkdown } from '../src/modules/resources/chunk.js'

test('空文档 / 纯空白 → 零块', () => {
  assert.deepEqual(chunkMarkdown(''), [])
  assert.deepEqual(chunkMarkdown('   \n\n\t '), [])
})

test('只有标题没有正文 → 零块', () => {
  assert.deepEqual(chunkMarkdown('# 标题\n## 子标题'), [])
})

test('单标题 + 短段落 → 一块，记录标题路径，seq 从 0', () => {
  const chunks = chunkMarkdown('# 第一章 > 引言不对——这是标题文本\n正文一段。')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.seq, 0)
  assert.equal(chunks[0]!.heading, '第一章 > 引言不对——这是标题文本')
  assert.equal(chunks[0]!.content, '正文一段。')
})

test('嵌套标题记标题路径「A > B」', () => {
  const chunks = chunkMarkdown('# A\n\n## B\n\n正文')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.heading, 'A > B')
})

test('同级标题重置栈：# A → ## B → # C 后 heading 为「C」而非「A > B > C」', () => {
  const chunks = chunkMarkdown('# A\n\n## B\n\n一\n\n# C\n\n二')
  assert.deepEqual(chunks.map((c) => c.heading), ['A > B', 'C'])
})

test('无标题文档：段落直接成块，heading 为空串', () => {
  const chunks = chunkMarkdown('第一段。\n\n第二段。')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.heading, '')
  assert.equal(chunks[0]!.content, '第一段。\n第二段。')
})

test('超长单段按 target 硬切，相邻块带重叠', () => {
  // 40 字符单段；target=20 overlap=5 → 三块：
  // [0,20) / [15,35) / [30,40)（末块为尾段，含上一块尾部重叠）
  const text = '0123456789'.repeat(4)
  const chunks = chunkMarkdown(text, { targetChars: 20, overlapChars: 5 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]!.content, '01234567890123456789')
  assert.equal(chunks[1]!.content, '56789012345678901234')
  assert.equal(chunks[2]!.content, '0123456789')
  assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2])
})

test('多段落按 target 累积：超过即出块', () => {
  const md = ['一二三四五六七八九十', '甲乙丙丁戊己庚辛壬癸', '子丑寅卯辰巳午未申酉'].join('\n\n')
  const chunks = chunkMarkdown(`# 节\n\n${md}`, { targetChars: 20, overlapChars: 5 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]!.content, '一二三四五六七八九十')
  assert.ok(chunks[1]!.content.endsWith('甲乙丙丁戊己庚辛壬癸'))
  assert.ok(chunks[2]!.content.includes('子丑寅卯辰巳午未申酉'))
})

test('默认参数可用：长文不炸、每块非空', () => {
  const para = '播客制作的一段资料。'.repeat(100)
  const chunks = chunkMarkdown(`# 大文档\n\n${para}`)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.content.trim().length > 0)
})

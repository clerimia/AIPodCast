import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatHits, fuseRrf, sanitizeQuery } from '../src/modules/resources/retrieve.js'

test('fuseRrf：单通道保持原序', () => {
  assert.deepEqual(fuseRrf([['a', 'b', 'c']]), ['a', 'b', 'c'])
})

test('fuseRrf：双通道重叠项被抬升（score = Σ 1/(60+rank)，rank 从 1）', () => {
  // b 在两通道各排第 2/第 1：1/62 + 1/61 > a 的 1/61 > c 的 1/62
  assert.deepEqual(fuseRrf([['a', 'b'], ['b', 'c']]), ['b', 'a', 'c'])
})

test('fuseRrf：三通道同 id 归并去重', () => {
  const fused = fuseRrf([['x', 'y'], ['y', 'z'], ['y', 'x']])
  assert.equal(fused[0], 'y')
  assert.equal(new Set(fused).size, fused.length)
})

test('fuseRrf：空通道 → 空结果', () => {
  assert.deepEqual(fuseRrf([]), [])
  assert.deepEqual(fuseRrf([[]]), [])
})

test('sanitizeQuery：剥掉 tantivy 语法字符，归一空白', () => {
  assert.equal(sanitizeQuery('量子 (计算) [技术]!'), '量子 计算 技术')
  assert.equal(sanitizeQuery('  a && b || c  '), 'a b c')
  assert.equal(sanitizeQuery('!!!'), '')
})

test('formatHits：《资源标题》> 标题路径：块文本；无标题路径省略箭头', () => {
  const text = formatHits([
    { chunkId: '1', resourceTitle: '量子手册', heading: '第一章 > 背景', content: '正文甲' },
    { chunkId: '2', resourceTitle: '随手记', heading: '', content: '正文乙' },
  ])
  assert.deepEqual(text.split('\n\n'), [
    '《量子手册》> 第一章 > 背景：正文甲',
    '《随手记》：正文乙',
  ])
})

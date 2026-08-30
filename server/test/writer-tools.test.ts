import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOps, type OpLine, type ResolvedOp } from '../src/modules/script/apply-ops.js'
import { buildAddOps } from '../src/modules/writer/tools.js'

// add 锚点语义（#35 复盘 1）：buildAddOps 编译链式 op + applyOps 端到端验证顺序。

const item = (text: string) => ({ speakerId: 'sp-1', text, instructions: '' })

/** 每个测试独立的 id 生成器（断言按 new-1…new-N 落笔） */
const makeIdGen = () => {
  let seq = 0
  return () => `new-${++seq}`
}

const base: OpLine[] = [
  { id: 'a', serial: 'L001', speakerId: 'sp-1', text: '一', instructions: '' },
  { id: 'b', serial: 'L002', speakerId: 'sp-1', text: '二', instructions: '' },
]

test('缺省锚点 = 追加末尾（翻译成末行 id）', () => {
  const newId = makeIdGen()
  const ops = buildAddOps([item('三')], undefined, 'b', newId)
  assert.deepEqual(ops, [
    { op: 'add', id: 'new-1', afterLineId: 'b', speakerId: 'sp-1', text: '三', instructions: '' },
  ])
  const result = applyOps(base, ops as ResolvedOp[])
  assert.deepEqual(result.lines.map((l) => l.id), ['a', 'b', 'new-1'])
})

test('空脚本 + 缺省锚点 → null（最前）', () => {
  const newId = makeIdGen()
  const ops = buildAddOps([item('首')], undefined, null, newId)
  const result = applyOps([], ops as ResolvedOp[])
  assert.deepEqual(result.lines.map((l) => l.id), ['new-1'])
})

test('多行链式：一次调用按序追加，行序与数组序一致', () => {
  const newId = makeIdGen()
  const ops = buildAddOps([item('三'), item('四'), item('五')], undefined, 'b', newId)
  const result = applyOps(base, ops as ResolvedOp[])
  assert.deepEqual(result.lines.map((l) => l.id), ['a', 'b', 'new-1', 'new-2', 'new-3'])
  assert.deepEqual(result.lines.map((l) => l.text), ['一', '二', '三', '四', '五'])
  assert.deepEqual(result.addedIds, ['new-1', 'new-2', 'new-3'])
})

test('传锚点 = 插到该行之后；后续行仍链接在该行后', () => {
  const newId = makeIdGen()
  const ops = buildAddOps([item('一点五'), item('一点七五')], 'a', 'b', newId)
  const result = applyOps(base, ops as ResolvedOp[])
  assert.deepEqual(result.lines.map((l) => l.id), ['a', 'new-1', 'new-2', 'b'])
})

test('null 锚点 = 插到最前', () => {
  const newId = makeIdGen()
  const ops = buildAddOps([item('零')], null, 'b', newId)
  const result = applyOps(base, ops as ResolvedOp[])
  assert.deepEqual(result.lines.map((l) => l.id), ['new-1', 'a', 'b'])
})

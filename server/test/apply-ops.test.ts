import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AppError } from '../src/shared/errors.js'
import { applyOps, resolveOps, type OpLine, type ScriptOp } from '../src/modules/script/apply-ops.js'

// applyOps 纯函数单测：add/edit/delete/reorder 顺序应用 + serial 重编（#25 验收 3）

function line(id: string, serial: string, overrides: Partial<OpLine> = {}): OpLine {
  return { id, serial, speakerId: `sp-${id}`, text: `台词 ${id}`, instructions: '', ...overrides }
}

function errOf(fn: () => unknown): AppError {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`)
    return e
  }
  throw new Error('expected fn to throw')
}

test('add：null 插最前、afterLineId 插中间；serial 按最终顺序重编', () => {
  const base = [line('a', 'L001'), line('b', 'L002')]
  const [x, y] = ['x', 'y']
  const resolved = resolveOps(
    [
      { op: 'add', afterLineId: null, speakerId: 'sp-x', text: '开头', instructions: '' },
      { op: 'add', afterLineId: 'a', speakerId: 'sp-y', text: '中间', instructions: '' },
    ],
    (() => {
      const ids = [x, y]
      return () => ids.shift()!
    })(),
  )
  const result = applyOps(base, resolved)
  assert.deepEqual(result.lines.map((l) => [l.id, l.serial, l.text]), [
    [x, 'L001', '开头'],
    ['a', 'L002', '台词 a'],
    [y, 'L003', '中间'],
    ['b', 'L004', '台词 b'],
  ])
  assert.deepEqual(result.addedIds, [x, y])
  assert.deepEqual(result.editedIds, [])
  assert.deepEqual(result.deletedIds, [])
})

test('edit：改台词/指令/说话人记入 editedIds；同值 patch 不算变化', () => {
  const base = [line('a', 'L001', { instructions: '沉稳' })]
  const result = applyOps(base, [
    { op: 'edit', lineId: 'a', patch: { text: '改了' } },
    { op: 'edit', lineId: 'a', patch: { instructions: '沉稳' } },
    { op: 'edit', lineId: 'a', patch: { speakerId: 'sp-z' } },
  ])
  assert.deepEqual(result.editedIds, ['a', 'a'])
  assert.equal(result.lines[0]!.text, '改了')
  assert.equal(result.lines[0]!.speakerId, 'sp-z')
  assert.equal(result.lines[0]!.instructions, '沉稳')
})

test('delete：行移出工作集，serial 重编压实', () => {
  const base = [line('a', 'L001'), line('b', 'L002'), line('c', 'L003')]
  const result = applyOps(base, [{ op: 'delete', lineId: 'a' }])
  assert.deepEqual(result.lines.map((l) => [l.id, l.serial]), [
    ['b', 'L001'],
    ['c', 'L002'],
  ])
  assert.deepEqual(result.deletedIds, ['a'])
})

test('reorder：全序重排后 serial 跟随新顺序', () => {
  const base = [line('a', 'L001'), line('b', 'L002'), line('c', 'L003')]
  const result = applyOps(base, [{ op: 'reorder', lineIds: ['c', 'a', 'b'] }])
  assert.deepEqual(result.lines.map((l) => l.id), ['c', 'a', 'b'])
  assert.deepEqual(result.lines.map((l) => l.serial), ['L001', 'L002', 'L003'])
})

test('混合顺序应用：add 后可 edit 同一行；edit 后 delete 该行仍成立', () => {
  const base = [line('a', 'L001')]
  const ops = resolveOps(
    [
      { op: 'add', afterLineId: 'a', speakerId: 'sp-x', text: '新行', instructions: '' },
      { op: 'edit', lineId: 'x', patch: { text: '新行改' } },
      { op: 'reorder', lineIds: ['x', 'a'] },
    ],
    () => 'x',
  )
  const result = applyOps(base, ops)
  assert.deepEqual(result.lines.map((l) => [l.id, l.serial]), [
    ['x', 'L001'],
    ['a', 'L002'],
  ])
  assert.equal(result.lines[0]!.text, '新行改')
  assert.deepEqual(result.addedIds, ['x'])
})

test('引用不存在的行 → 409 CONFLICT（edit / delete / add 锚点）', () => {
  const base = [line('a', 'L001')]
  const cases: ScriptOp[] = [
    { op: 'edit', lineId: 'ghost', patch: { text: 'x' } },
    { op: 'delete', lineId: 'ghost' },
    { op: 'add', afterLineId: 'ghost', speakerId: 'sp', text: 'x', instructions: '' },
  ]
  for (const op of cases) {
    const err = errOf(() => applyOps(base, resolveOps([op], () => 'n1')))
    assert.equal(err.code, 'CONFLICT', JSON.stringify(op))
    assert.equal(err.statusCode, 409)
  }
})

test('同一提交内先 delete 再引用该行 → 409（工作集已不含它）', () => {
  const base = [line('a', 'L001'), line('b', 'L002')]
  const err = errOf(() =>
    applyOps(base, [{ op: 'delete', lineId: 'a' }, { op: 'edit', lineId: 'a', patch: { text: 'x' } }]),
  )
  assert.equal(err.code, 'CONFLICT')
})

test('reorder 不是当前活行的排列 → 400 BAD_REQUEST（缺行/多行/重复）', () => {
  const base = [line('a', 'L001'), line('b', 'L002')]
  for (const lineIds of [['a'], ['a', 'b', 'c'], ['a', 'a']]) {
    const err = errOf(() => applyOps(base, [{ op: 'reorder', lineIds: lineIds as string[] }]))
    assert.equal(err.code, 'BAD_REQUEST', `lineIds=${JSON.stringify(lineIds)}`)
  }
})

test('resolveOps 给每个 add 预生成唯一行 id；客户端已带 id 则原样保留', () => {
  const ops: ScriptOp[] = [
    { op: 'add', id: 'client-1', afterLineId: null, speakerId: 'sp', text: '一', instructions: '' },
    { op: 'edit', lineId: 'a', patch: {} },
    { op: 'add', afterLineId: 'client-1', speakerId: 'sp', text: '二', instructions: '' },
  ]
  let n = 0
  const resolved = resolveOps(ops, () => `new-${++n}`)
  assert.deepEqual(
    resolved.map((op) => (op.op === 'add' ? op.id : null)),
    ['client-1', null, 'new-1'],
  )
})

test('同提交内 add 引用客户端预生成 id：锚点与 reorder 都可指向暂存新增行', () => {
  const base = [line('a', 'L001')]
  const result = applyOps(
    base,
    resolveOps(
      [
        { op: 'add', id: 'n1', afterLineId: null, speakerId: 'sp', text: '一', instructions: '' },
        { op: 'add', id: 'n2', afterLineId: 'n1', speakerId: 'sp', text: '二', instructions: '' },
        { op: 'reorder', lineIds: ['n2', 'a', 'n1'] },
      ],
      () => 'unused',
    ),
  )
  assert.deepEqual(result.lines.map((l) => [l.id, l.serial]), [
    ['n2', 'L001'],
    ['a', 'L002'],
    ['n1', 'L003'],
  ])
})

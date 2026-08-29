import { describe, expect, it } from 'vitest'
import type { ScriptLine, Speaker } from '@/lib/api/types'
import {
  applyOps,
  commitBlocker,
  isStaged,
  toRequestOps,
  type StagedOp,
} from './staging'

// applyOps overlay 投影单测（#25 验收 3）：add/edit/delete/reorder 顺序应用 + serial 重编。
// 与 server/src/test/apply-ops.test.ts 对照：那边严格（4xx），这边宽松（跳过不崩 UI）。

const speakers: Speaker[] = [
  { id: 'sp-1', name: '主持人', persona: '', gender: '', voice: 'Cherry' },
  { id: 'sp-2', name: '嘉宾', persona: '', gender: '', voice: 'Ethan' },
]

function line(id: string, overrides: Partial<ScriptLine> = {}): ScriptLine {
  return {
    id,
    serial: 'L000',
    speakerId: 'sp-1',
    speakerName: '主持人',
    text: `台词 ${id}`,
    instructions: '',
    post: {},
    asset: { has: false, durationMs: null },
    ...overrides,
  }
}

function serials(lines: ScriptLine[]) {
  return lines.map((l) => l.serial)
}

describe('applyOps', () => {
  it('空 ops → 原样投影（serial 重编不破坏既有顺序）', () => {
    const base = [line('a', { serial: 'L002' }), line('b', { serial: 'L001' })]
    const out = applyOps(base, [], speakers)
    expect(out.map((l) => l.id)).toEqual(['a', 'b'])
    expect(serials(out)).toEqual(['L001', 'L002'])
  })

  it('add：null 插最前、afterLineId 插中间，说话人名随 speakers 解析', () => {
    const base = [line('a'), line('b')]
    const ops: StagedOp[] = [
      { op: 'add', tempId: 't1', afterLineId: null, speakerId: 'sp-2', text: '开头' },
      { op: 'add', tempId: 't2', afterLineId: 'a', speakerId: 'sp-1', text: '中间', instructions: '沉稳' },
    ]
    const out = applyOps(base, ops, speakers)
    expect(out.map((l) => [l.id, l.text])).toEqual([
      ['t1', '开头'],
      ['a', '台词 a'],
      ['t2', '中间'],
      ['b', '台词 b'],
    ])
    expect(out[0]).toMatchObject({ speakerName: '嘉宾', serial: 'L001', asset: { has: false } })
    expect(out[2]!.instructions).toBe('沉稳')
  })

  it('edit：改台词/指令/说话人投影到行（speakerName 跟随 speakers）', () => {
    const base = [line('a'), line('b', { speakerId: 'sp-2', speakerName: '嘉宾' })]
    const ops: StagedOp[] = [
      { op: 'edit', lineId: 'a', patch: { text: '改了', instructions: '轻快' } },
      { op: 'edit', lineId: 'b', patch: { speakerId: 'sp-1' } },
    ]
    const out = applyOps(base, ops, speakers)
    expect(out[0]).toMatchObject({ text: '改了', instructions: '轻快' })
    expect(out[1]).toMatchObject({ speakerId: 'sp-1', speakerName: '主持人' })
  })

  it('delete：行移除，serial 压实重编', () => {
    const base = [line('a'), line('b'), line('c')]
    const out = applyOps(base, [{ op: 'delete', lineId: 'b' }], speakers)
    expect(out.map((l) => l.id)).toEqual(['a', 'c'])
    expect(serials(out)).toEqual(['L001', 'L002'])
  })

  it('reorder：全序重排，serial 跟随新顺序', () => {
    const base = [line('a'), line('b'), line('c')]
    const out = applyOps(base, [{ op: 'reorder', lineIds: ['c', 'a', 'b'] }], speakers)
    expect(out.map((l) => l.id)).toEqual(['c', 'a', 'b'])
    expect(serials(out)).toEqual(['L001', 'L002', 'L003'])
  })

  it('混合：add 后编辑其 tempId、删除引用已不存在的行 → 宽松跳过不崩', () => {
    const base = [line('a')]
    const ops: StagedOp[] = [
      { op: 'add', tempId: 't1', afterLineId: 'a', speakerId: 'sp-1', text: '新行' },
      { op: 'edit', lineId: 't1', patch: { text: '新行改' } },
      { op: 'edit', lineId: 'ghost', patch: { text: '不存在' } },
      { op: 'delete', lineId: 'ghost' },
      { op: 'reorder', lineIds: ['t1', 'ghost'] },
    ]
    const out = applyOps(base, ops, speakers)
    expect(out.map((l) => [l.id, l.text, l.serial])).toEqual([
      ['a', '台词 a', 'L001'],
      ['t1', '新行改', 'L002'],
    ])
  })

  it('reorder 非当前投影的排列（缺行/重复）→ 跳过', () => {
    const base = [line('a'), line('b')]
    const out = applyOps(base, [{ op: 'reorder', lineIds: ['b', 'ghost'] }], speakers)
    expect(out.map((l) => l.id)).toEqual(['a', 'b'])
  })
})

describe('isStaged / commitBlocker / toRequestOps', () => {
  it('isStaged：edit/delete 命中该行，reorder 不标', () => {
    const ops: StagedOp[] = [
      { op: 'edit', lineId: 'a', patch: { text: 'x' } },
      { op: 'delete', lineId: 'b' },
      { op: 'reorder', lineIds: ['a', 'b', 'c'] },
    ]
    expect(isStaged(ops, 'a')).toBe(true)
    expect(isStaged(ops, 'b')).toBe(true)
    expect(isStaged(ops, 'c')).toBe(false)
  })

  it('commitBlocker：新增行空台词阻断，写完放行', () => {
    const add: StagedOp = { op: 'add', tempId: 't1', afterLineId: null, speakerId: 'sp-1', text: ' ' }
    expect(commitBlocker([add])).toBe('有新增行还没写台词')
    expect(commitBlocker([{ ...add, text: '台词' }])).toBeNull()
    expect(commitBlocker([{ op: 'delete', lineId: 'a' }])).toBeNull()
  })

  it('toRequestOps：tempId 变为 add.id 随 op 发出（同提交内后续 op 可引用暂存新增行）', () => {
    const ops: StagedOp[] = [
      { op: 'add', tempId: 't1', afterLineId: 'a', speakerId: 'sp-1', text: 'x', instructions: '' },
      { op: 'edit', lineId: 'b', patch: { text: 'y' } },
      { op: 'delete', lineId: 'c' },
    ]
    expect(toRequestOps(ops)).toEqual([
      { op: 'add', id: 't1', afterLineId: 'a', speakerId: 'sp-1', text: 'x', instructions: '' },
      { op: 'edit', lineId: 'b', patch: { text: 'y' } },
      { op: 'delete', lineId: 'c' },
    ])
  })
})

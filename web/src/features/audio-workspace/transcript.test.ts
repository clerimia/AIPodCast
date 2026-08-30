import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/api/types'
import { transcriptEntryAt } from './transcript'

// transcript 二分查找（#29 验证项 2）：[startMs, endMs) 命中、gap/轴外 null、空轴安全。
const entry = (serial: string, startMs: number, endMs: number): TranscriptEntry => ({
  serial,
  speakerName: '主持人',
  text: serial,
  startMs,
  endMs,
})

const entries = [entry('L001', 0, 500), entry('L002', 1300, 1800), entry('L003', 2600, 3100)]

describe('transcriptEntryAt', () => {
  it('命中行内（含左右边界）', () => {
    expect(transcriptEntryAt(entries, 0)?.serial).toBe('L001')
    expect(transcriptEntryAt(entries, 250)?.serial).toBe('L001')
    expect(transcriptEntryAt(entries, 499)?.serial).toBe('L001')
    expect(transcriptEntryAt(entries, 1300)?.serial).toBe('L002')
    expect(transcriptEntryAt(entries, 3099)?.serial).toBe('L003')
  })

  it('endMs 为开区间：恰在 endMs 上落在 gap → null', () => {
    expect(transcriptEntryAt(entries, 500)).toBeNull()
    expect(transcriptEntryAt(entries, 1800)).toBeNull()
  })

  it('行间 gap 与轴外 → null（开头前/结尾后）', () => {
    expect(transcriptEntryAt(entries, 1000)).toBeNull()
    expect(transcriptEntryAt(entries, 2000)).toBeNull()
    expect(transcriptEntryAt(entries, 4000)).toBeNull()
    expect(transcriptEntryAt(entries, -1)).toBeNull()
  })

  it('空轴与单条轴安全', () => {
    expect(transcriptEntryAt([], 100)).toBeNull()
    expect(transcriptEntryAt([entry('L001', 0, 100)], 50)?.serial).toBe('L001')
  })
})

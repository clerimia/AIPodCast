import { describe, expect, it } from 'vitest'
import { isTerminalJobStatus, jobRefetchInterval, stageLabel } from './synthesis'

// useSynthesisJob 轮询约定（#28）：活跃态 2s 轮询、终态停；stage 文案是进度条唯一来源
describe('isTerminalJobStatus', () => {
  it('succeeded/failed/canceled/interrupted 为终态，pending/running/canceling 为活跃态', () => {
    for (const s of ['succeeded', 'failed', 'canceled', 'interrupted'] as const) {
      expect(isTerminalJobStatus(s)).toBe(true)
    }
    for (const s of ['pending', 'running', 'canceling'] as const) {
      expect(isTerminalJobStatus(s)).toBe(false)
    }
  })
})

describe('jobRefetchInterval', () => {
  it('活跃态 2000ms；终态返回 false 停轮询', () => {
    expect(jobRefetchInterval('pending')).toBe(2000)
    expect(jobRefetchInterval('running')).toBe(2000)
    expect(jobRefetchInterval('canceling')).toBe(2000)
    expect(jobRefetchInterval('succeeded')).toBe(false)
    expect(jobRefetchInterval('failed')).toBe(false)
    expect(jobRefetchInterval('interrupted')).toBe(false)
  })
})

describe('stageLabel', () => {
  it('四个阶段各有文案；无阶段（排队中）给等待文案', () => {
    expect(stageLabel(null)).toContain('排队')
    expect(stageLabel('tts')).toContain('逐行')
    expect(stageLabel('post')).toContain('拼接')
    expect(stageLabel('verify')).toContain('校验')
    expect(stageLabel('encode')).toContain('编码')
  })
})

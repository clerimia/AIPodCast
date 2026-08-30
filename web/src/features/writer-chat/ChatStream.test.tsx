// @vitest-environment jsdom
// Task 折叠头回归测试（「脚本操作（N 步）」点不开）：TaskTrigger asChild 的直接子元素
// 必须是会透传 props 的 DOM 元素——此前 TaskTriggerFace 丢弃了 Radix 合并进来的
// onClick/data-state，导致整个 Task 块无法开合。
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatStream } from './ChatStream'
import { useWriterRunStore, type RunState } from '@/stores/writer-run'

const EP = 'ep-test'

function seedRun(overrides: Partial<RunState> = {}) {
  useWriterRunStore.setState({
    runs: {
      [EP]: {
        messages: [
          { role: 'user', text: '你好' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              { tool: 'read', summary: '读取脚本' },
              { tool: 'add', summary: '加了一行' },
            ],
          },
        ],
        streamingText: '',
        streamingThinking: '',
        thinkingActive: false,
        running: false,
        tools: [],
        toolsDone: 0,
        error: null,
        ...overrides,
      },
    },
  })
}

const trigger = () => screen.getByText('脚本操作（2 步）')
const rootState = (el: HTMLElement) =>
  el.closest('[data-slot="collapsible"]')?.getAttribute('data-state')

afterEach(() => {
  cleanup()
  useWriterRunStore.setState({ runs: {} })
})

describe('ChatStream Task 折叠头', () => {
  it('点击「脚本操作」可展开/收起工具步骤', async () => {
    seedRun()
    render(<ChatStream episodeId={EP} />)
    const user = userEvent.setup()

    // 初始收起（run 已结束）
    expect(rootState(trigger())).toBe('closed')

    await user.click(trigger())
    await waitFor(() => expect(rootState(trigger())).toBe('open'))
    // 展开后能看到工具步骤条目
    expect(screen.getByText('读取脚本')).toBeTruthy()

    await user.click(trigger())
    await waitFor(() => expect(rootState(trigger())).toBe('closed'))
    // Radix Collapsible 关闭时内容从 DOM 卸载
    expect(screen.queryByText('读取脚本')).toBeNull()
  })

  it('手动展开后不被本轮 running 状态覆盖（userOpen 优先）', async () => {
    seedRun()
    render(<ChatStream episodeId={EP} />)
    const user = userEvent.setup()

    await user.click(trigger())
    await waitFor(() => expect(rootState(trigger())).toBe('open'))

    // 模拟新一轮 run 开始：liveOpen 变 false，但用户手动开合应以手动为准
    seedRun({ running: true })
    await waitFor(() => expect(rootState(trigger())).toBe('open'))
  })
})

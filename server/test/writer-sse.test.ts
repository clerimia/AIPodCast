import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { runWriterSession, type BrowserSseEvent } from '../src/modules/writer/sse.js'

// SSE 映射单测（#19「SSE 事件协议」映射表）：喂 PI 事件，断言浏览器事件序列。

/** 最小假会话：记录 listener，测试里手动 push 事件 */
function fakeSession(): {
  session: AgentSession
  push: (event: AgentSessionEvent) => void
  unsubscribed: () => boolean
} {
  let listener: ((event: AgentSessionEvent) => void) | null = null
  let off = false
  const session = {
    subscribe: (l: (event: AgentSessionEvent) => void) => {
      listener = l
      return () => {
        off = true
      }
    },
  } as unknown as AgentSession
  return {
    session,
    push: (event) => listener?.(event),
    unsubscribed: () => off,
  }
}

interface AssistantLike {
  role: 'assistant'
  content: { type: string; text?: string; id?: string; name?: string }[]
  stopReason?: string
  errorMessage?: string
}

function run(): {
  push: (event: AgentSessionEvent) => void
  events: BrowserSseEvent[]
  ended: () => 'done' | 'error' | null
  unsubscribed: () => boolean
} {
  const f = fakeSession()
  const events: BrowserSseEvent[] = []
  let end: 'done' | 'error' | null = null
  runWriterSession(f.session, (e) => events.push(e), (result) => {
    end = result
  })
  return { push: f.push, events, ended: () => end, unsubscribed: () => f.unsubscribed() }
}

const agentStart: AgentSessionEvent = { type: 'agent_start' }

test('正文增量：text_delta → delta；assistant message_end → message:end', () => {
  const r = run()
  r.push(agentStart)
  r.push({
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你', partial: null },
  } as unknown as AgentSessionEvent)
  r.push({
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好', partial: null },
  } as unknown as AgentSessionEvent)
  r.push({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
  } as unknown as AgentSessionEvent)

  assert.deepEqual(
    r.events.map((e) => e.event),
    ['run:start', 'delta', 'delta', 'message:end'],
  )
  const delta = r.events[1] as Extract<BrowserSseEvent, { event: 'delta' }>
  assert.equal(delta.data.delta, '你')
  const end = r.events[3] as Extract<BrowserSseEvent, { event: 'message:end' }>
  assert.equal(end.data.text, '你好')
})

test('user 的 message_end 不回放（用户气泡由前端本地渲染）', () => {
  const r = run()
  r.push({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: '写段开场白' }] },
  } as unknown as AgentSessionEvent)
  assert.deepEqual(r.events, [])
})

test('add 工具：tool:start → tool:end → script:changed（lineIds 来自 details）', () => {
  const r = run()
  r.push(agentStart)
  r.push({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'add',
    args: {},
  } as unknown as AgentSessionEvent)
  r.push({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'add',
    result: { content: [], details: { summary: '新增 L002', lineIds: ['uuid-1'] } },
    isError: false,
  } as unknown as AgentSessionEvent)

  const names = r.events.map((e) => e.event)
  assert.deepEqual(names, ['run:start', 'tool:start', 'tool:end', 'script:changed'])
  const end = r.events[2] as Extract<BrowserSseEvent, { event: 'tool:end' }>
  assert.deepEqual(end.data, {
    toolCallId: 't1',
    tool: 'add',
    ok: true,
    isError: false,
    summary: '新增 L002',
    lineIds: ['uuid-1'],
  })
  const changed = r.events[3] as Extract<BrowserSseEvent, { event: 'script:changed' }>
  assert.deepEqual(changed.data.lineIds, ['uuid-1'])
})

test('read 工具不派发 script:changed；工具报错不派发且 isError:true', () => {
  const r = run()
  r.push({
    type: 'tool_execution_end',
    toolCallId: 't0',
    toolName: 'read',
    result: { content: [], details: { summary: '读取脚本（2 行）', lineIds: [] } },
    isError: false,
  } as unknown as AgentSessionEvent)
  r.push({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'edit',
    result: { content: [], details: undefined },
    isError: true,
  } as unknown as AgentSessionEvent)

  assert.deepEqual(r.events.map((e) => e.event), ['tool:end', 'tool:end'])
  const failed = r.events[1] as Extract<BrowserSseEvent, { event: 'tool:end' }>
  assert.equal(failed.data.isError, true)
  assert.equal(failed.data.summary, 'edit 完成')
})

test('正常收尾：agent_settled → done，退订，onDone(done)', () => {
  const r = run()
  r.push(agentStart)
  r.push({ type: 'agent_end', messages: [], willRetry: false } as unknown as AgentSessionEvent)
  assert.equal(r.ended(), null) // agent_end 无错不终结，等 agent_settled
  r.push({ type: 'agent_settled' } as unknown as AgentSessionEvent)
  assert.deepEqual(r.events.map((e) => e.event), ['run:start', 'done'])
  assert.equal(r.ended(), 'done')
  assert.equal(r.unsubscribed(), true)
})

test('run 级失败：agent_end(willRetry:false) 且 assistant stopReason=error → error + 退订，不再 done', () => {
  const r = run()
  const assistant: AssistantLike = {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'provider 429',
  }
  r.push({ type: 'agent_end', messages: [assistant], willRetry: false } as unknown as AgentSessionEvent)
  assert.deepEqual(r.events.map((e) => e.event), ['error'])
  const err = r.events[0] as Extract<BrowserSseEvent, { event: 'error' }>
  assert.equal(err.data.message, 'provider 429')
  assert.equal(r.ended(), 'error')
  assert.equal(r.unsubscribed(), true)
})

test('willRetry:true 的 agent_end 不发 error（等待重试）', () => {
  const r = run()
  r.push({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x' }],
    willRetry: true,
  } as unknown as AgentSessionEvent)
  assert.deepEqual(r.events, [])
})

test('turn_end → turn:end；abort（stopReason=aborted）不算 run 错误，仍 done 收尾', () => {
  const r = run()
  r.push({ type: 'turn_start' } as unknown as AgentSessionEvent)
  r.push({
    type: 'turn_end',
    message: { role: 'assistant', content: [] },
    toolResults: [],
  } as unknown as AgentSessionEvent)
  r.push({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }],
    willRetry: false,
  } as unknown as AgentSessionEvent)
  r.push({ type: 'agent_settled' } as unknown as AgentSessionEvent)
  assert.deepEqual(r.events.map((e) => e.event), ['turn:end', 'done'])
  assert.equal(r.ended(), 'done')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWriterHistory } from '../src/modules/writer/history.js'

// history 回放单测（api-and-dataflow.md「history」节）：JSONL → 浏览器友好列表；
// change_set 等 display:false 的 custom_message 不回放；toolResult 并入 assistant.toolCalls。

const base = { id: 'e', parentId: null, timestamp: '2026-08-29T00:00:00Z' }
const line = (obj: unknown): string => JSON.stringify(obj)

function jsonl(...entries: unknown[]): string {
  return entries.map(line).join('\n')
}

test('user + assistant 正文 + toolCall（摘要并入）按序回放', () => {
  const content = jsonl(
    { type: 'session', id: 's', cwd: '/x' },
    {
      ...base,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: '写段开场白' }], timestamp: 1 },
    },
    {
      ...base,
      id: 'e2',
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考' },
          { type: 'text', text: '好的，先读脚本。' },
          { type: 'toolCall', id: 'tc1', name: 'add', arguments: {} },
        ],
        stopReason: 'toolUse',
        timestamp: 2,
      },
    },
    {
      ...base,
      id: 'e3',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'add',
        content: [{ type: 'text', text: '已新增 L002（id=abc）：大家好' }],
        isError: false,
        timestamp: 3,
      },
    },
    {
      ...base,
      id: 'e4',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '开场白写好了。' }],
        stopReason: 'stop',
        timestamp: 4,
      },
    },
  )

  const entries = parseWriterHistory('/nonexistent.jsonl')
  assert.deepEqual(entries, []) // 文件不存在 → 空列表，不抛

  const parsed = parseWriterHistoryContent(content)
  assert.deepEqual(parsed, [
    { role: 'user', text: '写段开场白' },
    { role: 'assistant', text: '好的，先读脚本。', toolCalls: [{ tool: 'add', summary: '已新增 L002（id=abc）：大家好' }] },
    { role: 'assistant', text: '开场白写好了。' },
  ])
})

test('change_set（custom_message display:false）不回放；模型 change_set 也绝不出现在列表', () => {
  const content = jsonl(
    {
      ...base,
      type: 'custom_message',
      customType: 'change_set',
      display: false,
      content: '<system-reminder>脚本已更新</system-reminder>',
    },
    {
      ...base,
      id: 'e2',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: '继续' }], timestamp: 1 },
    },
  )
  assert.deepEqual(parseWriterHistoryContent(content), [{ role: 'user', text: '继续' }])
})

test('错误占位 assistant（无正文无工具调用）与 compaction/model_change 条目跳过；user 纯字符串 content 支持', () => {
  const content = jsonl(
    { type: 'model_change', provider: 'dashscope', modelId: 'qwen3.7-plus' },
    {
      ...base,
      type: 'message',
      message: { role: 'user', content: '裸字符串消息', timestamp: 1 },
    },
    {
      ...base,
      id: 'e2',
      type: 'message',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom', timestamp: 2 },
    },
  )
  assert.deepEqual(parseWriterHistoryContent(content), [{ role: 'user', text: '裸字符串消息' }])
})

test('超长 toolResult 摘要截断到 120 字符', () => {
  const long = 'x'.repeat(200)
  const content = jsonl(
    {
      ...base,
      id: 'e1',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }],
        stopReason: 'toolUse',
        timestamp: 1,
      },
    },
    {
      ...base,
      id: 'e2',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read',
        content: [{ type: 'text', text: long }],
        isError: false,
        timestamp: 2,
      },
    },
  )
  const [entry] = parseWriterHistoryContent(content)
  assert.equal(entry!.toolCalls![0]!.summary.length, 121) // 120 + 省略号
  assert.ok(entry!.toolCalls![0]!.summary.endsWith('…'))
})

// history.ts 只接受文件路径；测试经由临时文件读取
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function parseWriterHistoryContent(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'writer-history-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, content, 'utf8')
  return parseWriterHistory(file)
}

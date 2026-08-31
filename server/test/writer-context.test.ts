import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatShowContext, writerStaticPrompt } from '../src/modules/writer/context.js'

// context 纯函数单测：第六层拼接（Layer 2 每轮覆盖的内容形态）+ 静态种子不含动态层。

test('第六层：固定槽位标题，空字段省略，说话人快照（名称+性别+人设）', () => {
  const text = formatShowContext({
    title: '第 1 集：AI 写作',
    showNotes: '',
    outline: '聊聊 AI 写作',
    topic: '',
    tone: '轻松',
    terms: '',
    bannedWords: '赋能',
    intro: '一档聊技术的节目',
    speakers: [
      { id: '11111111-1111-4111-8111-111111111111', name: '主持人', persona: '沉稳，爱提问', gender: '女' },
      { id: '22222222-2222-4222-8222-222222222222', name: '嘉宾', persona: '', gender: '' },
    ],
    resources: [],
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '## 节目信息与说话人')
  assert.ok(lines.includes('单集标题：第 1 集：AI 写作'))
  assert.ok(lines.includes('节目大纲：聊聊 AI 写作'))
  assert.ok(lines.includes('口吻：轻松'))
  assert.ok(lines.includes('禁词：赋能'))
  assert.ok(!lines.some((l) => l.startsWith('主题：'))) // 空字段省略
  assert.ok(lines.includes('- 主持人（speakerId=11111111-1111-4111-8111-111111111111，女）：沉稳，爱提问'))
  assert.ok(lines.includes('- 嘉宾（speakerId=22222222-2222-4222-8222-222222222222）'))
})

test('说话人为空时不出现「说话人：」空段，且提示模型引导用户创建', () => {
  const text = formatShowContext({
    title: 't',
    showNotes: '',
    outline: '',
    topic: '',
    tone: '',
    terms: '',
    bannedWords: '',
    intro: '',
    speakers: [],
    resources: [],
  })
  assert.ok(!text.includes('说话人：'))
  assert.ok(text.includes('还没有可用说话人'))
  assert.ok(text.includes('创建说话人'))
})

test('静态种子（Layer 3）不含第六层标题——动态内容只在 before_agent_start 覆盖', () => {
  const seed = writerStaticPrompt()
  assert.ok(!seed.includes('## 节目信息与说话人'))
  assert.ok(seed.includes('read / add / edit'))
  assert.ok(seed.includes('retrieve'))
})

test('第六层：资源清单（标题 + 字符数）；空库给引导', () => {
  const withRes = formatShowContext({
    title: 't', showNotes: '', outline: '', topic: '', tone: '', terms: '', bannedWords: '', intro: '',
    speakers: [],
    resources: [{ title: '量子手册', charCount: 1234 }],
  })
  assert.ok(withRes.includes('工作间资源（细节用 retrieve 工具检索）：'))
  assert.ok(withRes.includes('- 《量子手册》（1234 字）'))

  const empty = formatShowContext({
    title: 't', showNotes: '', outline: '', topic: '', tone: '', terms: '', bannedWords: '', intro: '',
    speakers: [],
    resources: [],
  })
  assert.ok(empty.includes('还没有资源'))
})

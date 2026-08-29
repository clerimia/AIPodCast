// #26 M3 spike：PI SDK 进程内嵌入，沿目标架构（Map 懒建 + per-episode loader +
// Layer 2 每轮覆盖第六层）验三件事：
//   1. tool_execution_start 真发出（SSE 映射的根）；
//   2. DashScope 专属端点经 SDK 全链路可用（developer role 已探针 400 →
//      compat.supportsDeveloperRole:false；thinkingFormat:"qwen" 已探针 200）；
//   3. Layer 2 每轮覆盖生效：改元数据后下一轮 prompt 末尾含新值；未改时逐字节不变。
// 用法：set -a && source ../.env && set +a && npm run spike -w server
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { config as loadEnv } from 'dotenv'

const serverDir = new URL('..', import.meta.url).pathname
loadEnv({ path: join(serverDir, '.env') })
loadEnv({ path: join(serverDir, '../.env') })

const apiKey = process.env.DASHSCOPE_API_KEY
const baseUrl = process.env.DASHSCOPE_BASE_URL
if (!apiKey || !baseUrl) throw new Error('missing DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL')

const MODEL_ID = process.env.SPIKE_MODEL ?? 'qwen3.7-plus'

// ---- Layer 3：前五层静态种子（spike 用极简版；正式版见 modules/writer/context.ts）----
function writerStaticPrompt(): string {
  return [
    '你是播客写稿大师，负责一集播客的全部文本（台词 + 指令）。',
    '用 read 查看当前脚本，用 add 新增行，用 edit 修改行。',
    '台词要口语化、可直接朗读；指令是「怎么说」的自然语言描述。',
  ].join('\n')
}

// ---- 第六层：每轮从「DB」（spike 里是可变对象）读当前元数据 ----
interface FakeMetadata {
  outline: string
  speakers: { name: string; persona: string }[]
}
const db: Record<string, FakeMetadata> = {
  'ep-spike': {
    outline: '第一版大纲：聊聊 AI 写作',
    speakers: [{ name: '主持人', persona: '沉稳，爱提问' }],
  },
}
const layer6Of = (m: FakeMetadata): string =>
  [
    '## 节目信息与说话人',
    `节目大纲：${m.outline}`,
    ...m.speakers.map((s) => `- ${s.name}：${s.persona}`),
  ].join('\n')

// ---- per-episode 会话创建（目标架构的最小复刻）----
const modelRuntime = await ModelRuntime.create({ modelsPath: null })
modelRuntime.registerProvider('dashscope', {
  baseUrl: `${baseUrl}/compatible-mode/v1`,
  apiKey: '$DASHSCOPE_API_KEY',
  api: 'openai-completions',
  models: [
    {
      id: MODEL_ID,
      name: 'Qwen (writer)',
      reasoning: true,
      input: ['text'],
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen' },
    },
  ],
})
await modelRuntime.setRuntimeApiKey('dashscope', apiKey)
const model = modelRuntime.getModel('dashscope', MODEL_ID)
if (!model) throw new Error(`dashscope/${MODEL_ID} 未注册`)
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })

// before_agent_start handler 每轮跑：读「DB」拼第六层，返回覆盖串；记录哈希供断言
const promptLog: { baseHash: string; finalHash: string; final: string }[] = []
function writerMetadataExtension(episodeId: string) {
  return (pi: ExtensionAPI) => {
    pi.on('before_agent_start', async (event) => {
      const meta = db[episodeId]!
      const final = `${event.systemPrompt}\n\n${layer6Of(meta)}`
      promptLog.push({
        baseHash: sha256(event.systemPrompt),
        finalHash: sha256(final),
        final,
      })
      return { systemPrompt: final }
    })
  }
}

async function makeResourceLoader(episodeId: string) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(serverDir, '.pi-agent-spike'),
    settingsManager,
    systemPrompt: writerStaticPrompt(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [writerMetadataExtension(episodeId)],
  })
  // DefaultResourceLoader 是惰性的：createAgentSession 只对自己新建的 loader 调
  // reload()（sdk.js:77 仅 if (!resourceLoader) 分支）；传入自定义 loader 必须自己
  // await reload()，否则 getSystemPrompt()/getExtensions() 返回空。
  await loader.reload()
  return loader
}

function makeReadTool() {
  return defineTool({
    name: 'read',
    label: '读脚本',
    description: '读取当前脚本（说话人 + 台词 + 指令，按行号）',
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        {
          type: 'text',
          text: 'L001 主持人：大家好，欢迎收听本期节目。\nL002 主持人：今天我们聊聊 AI 写作。',
        },
      ],
      details: { lines: 2 },
    }),
  })
}

const sessions = new Map<string, AgentSession>()
async function getOrCreateSession(episodeId: string): Promise<AgentSession> {
  const hit = sessions.get(episodeId)
  if (hit) return hit
  const { session } = await createAgentSession({
    modelRuntime,
    model,
    thinkingLevel: 'off',
    settingsManager,
    resourceLoader: await makeResourceLoader(episodeId),
    noTools: 'builtin',
    customTools: [makeReadTool()],
    sessionManager: SessionManager.inMemory(),
    settingsManager: settingsManager,
  })
  sessions.set(episodeId, session)
  return session
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function runTurn(session: AgentSession, text: string): Promise<Set<string>> {
  const seen = new Set<string>()
  let textOut = ''
  const off = session.subscribe((e) => {
    seen.add(e.type)
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
      textOut += e.assistantMessageEvent.delta
    }
  })
  try {
    await session.prompt(text)
  } finally {
    off()
  }
  console.log(`  └─ assistant: ${textOut.slice(0, 120).replace(/\n/g, ' ')}`)
  return seen
}

// ---- 断言 1：Map 懒建 + read 工具调用，tool_execution_start 真发出 ----
console.log(`[spike] model = dashscope/${MODEL_ID}`)
const session = await getOrCreateSession('ep-spike')
console.log('[spike] turn 1: 触发 read 工具调用')
const turn1 = await runTurn(session, '请先用 read 工具读取当前脚本，然后用一句话概括它讲了什么。')
console.log(`  └─ events: ${[...turn1].sort().join(', ')}`)

// ---- 断言 2：整链路无 400（developer role / enable_thinking 兼容已过）----
if (turn1.has('tool_execution_start')) {
  console.log('[assert 1] PASS: tool_execution_start 真发出')
} else {
  console.log('[assert 1] FAIL: 未看到 tool_execution_start')
}
if (turn1.has('agent_settled')) console.log('[assert 2] PASS: DashScope 端点 SDK 全链路跑通（agent_settled）')

// ---- 断言 3：Layer 2 每轮覆盖——改元数据后下一轮 prompt 含新值；未改时逐字节不变 ----
console.log('[spike] turn 2: 元数据未变，prompt 应逐字节不变')
await runTurn(session, '简单回应：好的。')
console.log('[spike] turn 3: 改元数据后，prompt 末尾应含新值')
db['ep-spike']!.outline = '第二版大纲：聊聊 AI 播客制作'
await runTurn(session, '简单回应：收到。')

const [t1, t2, t3] = promptLog
const baseStable = t1!.baseHash === t2!.baseHash && t2.baseHash === t3!.baseHash
console.log(`[assert 3a] base prompt 缓存稳定（建会话算一次）：${baseStable ? 'PASS' : 'FAIL'}`)
const unchanged = t1.finalHash === t2.finalHash
console.log(
  `[assert 3b] 元数据未改 → 逐字节不变：${unchanged ? 'PASS' : 'FAIL'}（turn1 vs turn2 final hash ${t1.finalHash.slice(0, 8)} vs ${t2.finalHash.slice(0, 8)}）`,
)
const hasNewValue = t3!.final.includes('第二版大纲：聊聊 AI 播客制作')
console.log(`[assert 3c] 元数据改后 → 下一轮含新值：${hasNewValue ? 'PASS' : 'FAIL'}`)

// ---- 附加：ChangeSet 通知 sendCustomMessage(triggerTurn:false) 不触发回合 ----
const beforeCount = promptLog.length
await session.sendCustomMessage(
  {
    customType: 'change_set',
    display: false,
    content: '<system-reminder>脚本已更新（本次提交）：L003 新增一行</system-reminder>',
  },
  { triggerTurn: false },
)
console.log(
  `[assert 4] sendCustomMessage(triggerTurn:false) 未触发回合：${promptLog.length === beforeCount ? 'PASS' : 'FAIL'}`,
)

await session.dispose()
console.log('[spike] done')

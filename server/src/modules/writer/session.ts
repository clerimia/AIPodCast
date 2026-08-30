// 写稿大师会话运行时（ADR-0005：一集一个会话；配方 §3.3 + #26 决策 3）：
// Map<episodeId, AgentSession> 懒建/恢复，不用 createAgentRuntime（单当前会话是
// CLI 形态；abort 与 ChangeSet 通知逼会话跨请求驻留、天然并发）。
// 共享单例：modelRuntime + settingsManager（进程内一次）；per-episode：ResourceLoader
// + SessionManager(id=episodeId) + customTools（闭包持有该集 db 与 episodeId）。
// 不主动空闲逐出（单用户、内存微不足道）；进程退出统一 dispose()。
// Layer 2 每轮读 DB 元数据（context.ts），会话驻留时元数据不陈旧，无需版本号重建。
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { Db } from '../../db/client.js'
import { conversations } from '../../db/schema.js'
import { env } from '../../env.js'
import { AppError } from '../../shared/errors.js'
import { makeWriterResourceLoader } from './context.js'
import { makeWriterTools } from './tools.js'

export interface ChangeSetNotice {
  id: string
  summary: string | null
}

/** conversations 里该集的写稿会话行（路由层 history 与生命周期共用一个查询） */
export async function getWriterConversationRow(db: Db, episodeId: string) {
  const [row] = await db
    .select({ id: conversations.id, sessionFile: conversations.sessionFile })
    .from(conversations)
    .where(and(eq(conversations.episodeId, episodeId), eq(conversations.kind, 'writer')))
  return row
}

/** 新建会话的思考默认档：关（与现状行为一致；运行时可经 setThinkingLevel 切换） */
const THINKING_LEVEL = 'off' as const

/**
 * 思考开关注入的档位（ADR-0010，M6）：开关开 = low，关 = off。
 * qwen thinkingFormat 映射（pi-ai openai-completions）：enable_thinking = !!reasoningEffort，
 * 即任何非 off 的 level 都 → enable_thinking:true；reasoning_effort 因 provider 注册未设
 * supportsReasoningEffort 不会下发——正是 M4 spike 验证过 DashScope 接受的形状。
 */
export const THINKING_LEVEL_ON = 'low' as const

export class WriterRuntime {
  private readonly sessions = new Map<string, AgentSession>()
  private readonly pending = new Map<string, Promise<AgentSession>>()
  private shared: {
    modelRuntime: ModelRuntime
    model: NonNullable<ReturnType<ModelRuntime['getModel']>>
    settingsManager: SettingsManager
  } | null = null

  constructor(private readonly db: Db) {}

  /** 共享单例（modelRuntime/settingsManager 建一次）；DashScope 凭证缺失时在此报错 */
  private async ensureShared() {
    if (this.shared) return this.shared
    const { dashscopeApiKey, dashscopeBaseUrl, writerModel } = env
    if (!dashscopeApiKey || !dashscopeBaseUrl) {
      throw new AppError('INTERNAL', 'DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL 未配置，写稿大师不可用', 500)
    }
    // modelsPath: null = 不读 models.json，provider 全部编程注册；authPath 指向应用
    // 自己的 agentDir，不落到 ~/.pi/agent（配方 §6.2 要点 6）
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      authPath: join(env.agentDir, 'auth.json'),
    })
    modelRuntime.registerProvider('dashscope', {
      baseUrl: `${dashscopeBaseUrl.replace(/\/+$/, '')}/compatible-mode/v1`,
      apiKey: '$DASHSCOPE_API_KEY',
      api: 'openai-completions',
      models: [
        {
          id: writerModel,
          name: 'Writer model',
          reasoning: true,
          input: ['text'],
          contextWindow: 131072,
          // 必须严格大于思考开启时端点的默认 thinking_budget（8192）：qwen format 只发
          // enable_thinking，budget 由服务端定，max_completion_tokens <= budget 会 400
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // spike 实测（#26）：该端点拒绝 developer role（400），enable_thinking 接受
          compat: { supportsDeveloperRole: false, thinkingFormat: 'qwen' },
        },
      ],
    })
    await modelRuntime.setRuntimeApiKey('dashscope', dashscopeApiKey)
    const model = modelRuntime.getModel('dashscope', writerModel)
    if (!model) throw new AppError('INTERNAL', `dashscope/${writerModel} 未注册`, 500)

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    this.shared = { modelRuntime, model, settingsManager }
    return this.shared
  }

  /** 懒建/恢复：命中 Map 复用；未命中按 conversations.session_file 恢复或新建 */
  async getOrCreate(episodeId: string): Promise<AgentSession> {
    const hit = this.sessions.get(episodeId)
    if (hit) return hit
    const inflight = this.pending.get(episodeId)
    if (inflight) return inflight

    const creating = this.createSession(episodeId).finally(() => this.pending.delete(episodeId))
    this.pending.set(episodeId, creating)
    return creating
  }

  private async createSession(episodeId: string): Promise<AgentSession> {
    const row = await getWriterConversationRow(this.db, episodeId)

    const shared = await this.ensureShared()
    // 新建：sessionId = episodeId，文件 = <timestamp>_<episodeId>.jsonl（勿自行拼路径）
    const sessionManager = row?.sessionFile
      ? SessionManager.open(row.sessionFile)
      : SessionManager.create(process.cwd(), env.sessionsDir, { id: episodeId })

    const { session } = await createAgentSession({
      modelRuntime: shared.modelRuntime,
      model: shared.model,
      thinkingLevel: THINKING_LEVEL,
      settingsManager: shared.settingsManager,
      resourceLoader: await makeWriterResourceLoader({
        episodeId,
        db: this.db,
        settingsManager: shared.settingsManager,
        agentDir: env.agentDir,
      }),
      noTools: 'builtin',
      customTools: makeWriterTools(this.db, episodeId),
      sessionManager,
    })

    if (!row?.sessionFile && session.sessionFile) {
      if (row) {
        await this.db
          .update(conversations)
          .set({ sessionFile: session.sessionFile })
          .where(eq(conversations.id, row.id))
      } else {
        // 历史脏数据（建单集应连带 conversations 行）：补建再回填
        await this.db.insert(conversations).values({ episodeId, kind: 'writer', sessionFile: session.sessionFile })
      }
    }
    this.sessions.set(episodeId, session)
    return session
  }

  /** 中止当前 run；会话不在内存或不忙 → false（幂等） */
  async abort(episodeId: string): Promise<boolean> {
    const session = this.sessions.get(episodeId)
    if (!session || session.isIdle) return false
    await session.abort()
    return true
  }

  /**
   * 用户提交改动后把一条紧凑 ChangeSet 追加进会话上下文（ADR-0002）：
   * 会话驻留且 idle 时 sendCustomMessage(triggerTurn:false)——只追加，不触发回合。
   * 非驻留会话不补发（解锁既定决策）：恢复后由 Layer 2 元数据 + read 工具看到最新脚本。
   */
  async notifyChangeSet(episodeId: string, changeSet: ChangeSetNotice): Promise<void> {
    const session = this.sessions.get(episodeId)
    if (!session || !session.isIdle) return
    const summary = changeSet.summary ?? changeSet.id
    await session.sendCustomMessage(
      {
        customType: 'change_set',
        display: false,
        content: `<system-reminder>脚本已更新（本次提交）：${summary}</system-reminder>`,
      },
      { triggerTurn: false },
    )
  }

  /** 进程退出统一释放（Fastify onClose 调用） */
  async dispose(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of all) {
      try {
        session.dispose()
      } catch {
        // 单个会话释放失败不影响其余
      }
    }
  }
}

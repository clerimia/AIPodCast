// 写稿大师 system prompt（docs/api-and-dataflow.md「会话生命周期」+ 配方 §6）：
// Layer 3 = getSystemPrompt 建会话时算一次的静态种子（前五层身份），SDK 缓存为
// _baseSystemPrompt。注意：SDK 的 buildSystemPrompt 走 customPrompt 分支时**不追加
// 任何工具段/指南**（只补一行 Current working directory）——工具用法指引全靠本文件
// 的「工作流」+ 工具 schema 的 description。Layer 2 = before_agent_start 每轮把第六层
// （当前 DB 节目元数据 + 说话人快照）覆盖到末尾——覆盖、不累加。
import { eq } from 'drizzle-orm'
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { Db } from '../../db/client.js'
import { episodes, showMetadata, speakers } from '../../db/schema.js'

// ---- Layer 3：前五层静态种子（建会话算一次；第六层动态内容绝不写在这里） ----

export function writerStaticPrompt(): string {
  return [
    '# 角色',
    '你是「写稿大师」，一集播客的唯一写作者，负责全部文本：台词与每行的指令。',
    '',
    '# 职责边界',
    '- 你只工作在脚本文本层：台词 + 指令。音频素材、停顿/语速、合成产物都不归你管，也不要向用户承诺改动它们。',
    '- 你的全部改动都通过 read / add / edit 三个工具落到脚本上，工具返回结果就是你看到的最新状态；查资料用 retrieve（只读，不改脚本）。',
    '',
    '# 写作约定',
    '- 台词要口语化、可直接朗读；避免书面腔和长难句。',
    '- 指令是这一行「怎么说」的自然语言描述（语气/情感/节奏），写给配音引擎看，例如：「用沉稳的语气，语速放慢」。',
    '- 遵守第六层的节目大纲、主题、口吻与术语；禁词一律不出现。',
    '',
    '# 工作流',
    '- 动笔前先用 read 看当前脚本，再决定 add 还是 edit；行号（L001…）与行 id 都在 read 结果里。',
    '- 引用行一律用行 id；行号会随增删整段重编，只用于给用户展示位置。',
    '- add / edit 的返回结果已带最新行号与 id，就是最新状态——不要为「确认生效」而重复 read。',
    '- 收到「脚本已更新」的系统提醒（用户直接改了稿）时，以提醒为准；要继续动笔前先 read 复核当前脚本。',
    '- 顺序写稿：把要写的多行用一次 add 的 lines 数组按序给出，不要传 afterLineId——新行会依次追加到末尾，比逐行调用省轮次且不会乱序。只有把新行插到脚本中间时才传 afterLineId（某行 id 之后；null = 最前）。',
    '- edit 改字、改指令、换说话人、删行或移动行。',
    '- 涉及事实、数据、背景、引用时，先 retrieve 检索本工作间资源，用带出处的检索结果写稿；第六层有资源清单，先扫一眼再决定检索词。',
    '- 改动即时生效，不需要向用户请求确认；写完用一两句话说明你改了什么。',
  ].join('\n')
}

// ---- Layer 2：第六层（每轮从 DB 读当前值） ----

export interface ShowContext {
  title: string
  showNotes: string
  outline: string
  topic: string
  tone: string
  terms: string
  bannedWords: string
  intro: string
  /** id 必须带：add/edit 工具按 uuid 引用说话人（模型从第六层取 id） */
  speakers: { id: string; name: string; persona: string; gender: string }[]
}

/** 第六层文本（纯函数，可单测）：固定槽位「## 节目信息与说话人」，拼在 system prompt 末尾 */
export function formatShowContext(ctx: ShowContext): string {
  const lines: string[] = ['## 节目信息与说话人', `单集标题：${ctx.title}`]
  if (ctx.outline) lines.push(`节目大纲：${ctx.outline}`)
  if (ctx.topic) lines.push(`主题：${ctx.topic}`)
  if (ctx.tone) lines.push(`口吻：${ctx.tone}`)
  if (ctx.terms) lines.push(`术语：${ctx.terms}`)
  if (ctx.bannedWords) lines.push(`禁词：${ctx.bannedWords}`)
  if (ctx.intro) lines.push(`节目简介：${ctx.intro}`)
  if (ctx.showNotes) lines.push(`单集简介：${ctx.showNotes}`)
  if (ctx.speakers.length > 0) {
    lines.push('说话人（speakerId 用各行标注的 uuid）：')
    for (const s of ctx.speakers) {
      const persona = s.persona ? `：${s.persona}` : ''
      lines.push(`- ${s.name}（speakerId=${s.id}${s.gender ? `，${s.gender}` : ''}）${persona}`)
    }
  } else {
    // 冷启动死角：没有可用说话人时 add 必然失败，提前告知模型该做什么而不是盲试
    lines.push('（工作间还没有可用说话人——无法新增台词，请提示用户先在工作间创建说话人）')
  }
  return lines.join('\n')
}

/** 每轮从 DB 读当前节目上下文；单集不存在 → null（调用方跳过覆盖） */
export async function loadShowContext(db: Db, episodeId: string): Promise<ShowContext | null> {
  const [ep] = await db
    .select({ id: episodes.id, wsId: episodes.wsId, title: episodes.title, showNotes: episodes.showNotes })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
  if (!ep) return null

  const [meta] = await db.select().from(showMetadata).where(eq(showMetadata.wsId, ep.wsId))
  const speakerRows = await db
    .select({ id: speakers.id, name: speakers.name, persona: speakers.persona, gender: speakers.gender })
    .from(speakers)
    .where(eq(speakers.wsId, ep.wsId))

  return {
    title: ep.title,
    showNotes: ep.showNotes,
    outline: meta?.outline ?? '',
    topic: meta?.topic ?? '',
    tone: meta?.tone ?? '',
    terms: meta?.terms ?? '',
    bannedWords: meta?.bannedWords ?? '',
    intro: meta?.intro ?? '',
    speakers: speakerRows,
  }
}

// ---- per-episode ResourceLoader：静态种子 + 关 discovery + Layer 2 extension ----

export interface WriterLoaderOptions {
  episodeId: string
  db: Db
  settingsManager: SettingsManager
  /** PI agentDir：仅作 packageManager 的落点（discovery 已全关），指向应用自己的目录，避开 ~/.pi/agent */
  agentDir: string
}

/**
 * per-episode loader（闭包持有 episodeId；getSystemPrompt 不带参数，故每集一个实例）。
 * noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles 全关 = 不加载项目
 * 扩展/技能/AGENTS.md，隔离写稿大师；extensionFactories 只挂 Layer 2 的
 * before_agent_start handler（v0.84.4 的 InlineExtension 即 ExtensionFactory 形状）。
 * 注意 DefaultResourceLoader 是惰性的：必须显式 await reload()，否则
 * getSystemPrompt()/getExtensions() 返回空（createAgentSession 只对自己新建的
 * loader 调 reload，见 <pkg>/dist/core/sdk.js 的 if (!resourceLoader) 分支）。
 */
export async function makeWriterResourceLoader(opts: WriterLoaderOptions): Promise<DefaultResourceLoader> {
  const { episodeId, db, settingsManager, agentDir } = opts
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    systemPrompt: writerStaticPrompt(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on('before_agent_start', async (event) => {
          const ctx = await loadShowContext(db, episodeId)
          if (!ctx) return undefined
          return { systemPrompt: `${event.systemPrompt}\n\n${formatShowContext(ctx)}` }
        })
      },
    ],
  })
  await loader.reload()
  return loader
}

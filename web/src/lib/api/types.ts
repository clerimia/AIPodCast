// 全部请求/响应类型，对照 docs/api-and-dataflow.md 手写；契约变更只改这里。
// 合成任务状态/载荷含 #22（docs/synthesis-progress-and-cancel.md）的扩展形状。

// ---- 档位（后期参数，ADR-0004）----
export type Pause = '短' | '中' | '长'
export type Speed = '慢' | '正常' | '快'

/** GET /api/health */
export interface Health {
  status: string
  db: string
}

/** 逐行后期覆盖；字段为 null = 清除该行覆盖，回退集级 post_rules */
export interface LinePost {
  pause?: Pause | null
  speed?: Speed | null
}

// ---- 工作间与单集 ----
export interface Workspace {
  id: string
  name: string
  createdAt: string
}

/** GET /api/workspaces/:wsId —— 详情一次拉全 show_metadata + speakers（#19） */
export interface WorkspaceDetail {
  id: string
  name: string
  showMetadata: ShowMetadata
  speakers: Speaker[]
}

export interface Speaker {
  id: string
  name: string
  persona: string
  gender: string
  voice: string
}

/** POST speakers；voice 为 24 系统音色名之一（web/src/lib/voices.ts） */
export interface CreateSpeakerInput {
  name: string
  voice: string
  persona?: string
  gender?: string
}

/** PATCH speakers/:id；字段缺省 = 不改 */
export type UpdateSpeakerInput = Partial<CreateSpeakerInput>

export interface ShowMetadata {
  outline: string
  topic: string
  tone: string
  terms: string
  bannedWords: string
  intro: string
}

/** PUT show-metadata；字段缺省 = 不改 */
export type ShowMetadataInput = Partial<ShowMetadata>

export interface Episode {
  id: string
  wsId: string
  title: string
  showNotes: string
  createdAt: string
}

/** GET /episodes/:id —— 单集详情（M2：artifact 恒 null，M5 起为产物摘要） */
export interface EpisodeDetail {
  id: string
  wsId: string
  title: string
  showNotes: string
  postRules: PostRules
  artifact: null
}

/** 集级后期默认规则 */
export interface PostRules {
  pause: Pause
  speed: Speed
}

// ---- 脚本（活单层文本）----
export interface LineAsset {
  has: boolean
  durationMs: number | null
}

/** GET /episodes/:id/script 每行（照 #19 的 jsonc 形状） */
export interface ScriptLine {
  id: string
  serial: string
  speakerId: string
  speakerName: string
  text: string
  instructions: string
  post: LinePost
  asset: LineAsset
}

export interface Script {
  lines: ScriptLine[]
}

// ---- 暂存/确认门（ADR-0003）----
export type ChangeOp =
  | {
      op: 'add'
      /** 可选客户端预生成行 id：同提交内后续 op（afterLineId/reorder）引用暂存新增行时必需 */
      id?: string
      afterLineId: string | null
      speakerId: string
      text: string
      instructions?: string
    }
  | { op: 'edit'; lineId: string; patch: { speakerId?: string; text?: string; instructions?: string } }
  | { op: 'delete'; lineId: string }
  | { op: 'reorder'; lineIds: string[] }

export interface ChangesRequest {
  ops: ChangeOp[]
  summary?: string
}

/** POST /changes 响应：新脚本 + 素材已作废的行（「需重新合成」标记依据） */
export interface ChangesResponse {
  changeSetId: string
  invalidatedLineIds: string[]
  lines: ScriptLine[]
}

// ---- 合成与产物 ----
export type SynthesisStage = 'tts' | 'post' | 'encode' | 'verify'
/** #22：状态机含 canceling/canceled 两段式取消；#28：interrupted = 进程重启收场（终态） */
export type SynthesisStatus = 'pending' | 'running' | 'canceling' | 'succeeded' | 'failed' | 'canceled' | 'interrupted'

/** 任务失败原因（synthesis_jobs.error jsonb）；行失败带 lineId/serial 定位 */
export interface SynthesisJobError {
  code: string
  message: string
  lineId?: string
  serial?: string
}

export interface TranscriptEntry {
  serial: string
  speakerName: string
  text: string
  startMs: number
  endMs: number
}

/** GET /episodes/:id/artifact */
export interface Artifact {
  id: string
  createdAt: string
  durationMs: number
  size: number
  audioUrl: string
  transcriptUrl: string
  notesUrl: string
  transcript: TranscriptEntry[]
  notes: string | null
}

/** GET /synthesis-jobs/:jobId（#22 扩展后全量形状） */
export interface SynthesisJob {
  status: SynthesisStatus
  stage: SynthesisStage | null
  doneLines: number
  totalLines: number
  doneLineIds: string[]
  currentLine: { lineId: string; serial: string } | null
  artifact: Artifact | null
  error: SynthesisJobError | null
}

/** POST /lines/:lineId/preview */
export interface PreviewResponse {
  asset: { id: string; url: string; durationMs: number | null }
}

/** POST /episodes/:id/synthesize */
export interface StartSynthesisResponse {
  jobId: string
  statusUrl: string
}

// ---- 写稿大师（M3 消费）----
export interface WriterHistoryToolCall {
  tool: string
  summary: string
}

export interface WriterHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: WriterHistoryToolCall[]
}

/** GET /episodes/:id/writer/history */
export interface WriterHistory {
  messages: WriterHistoryEntry[]
}

/** POST /episodes/:id/writer/abort */
export interface WriterAbortResponse {
  aborted: boolean
}

// ---- 写稿大师 SSE 事件词汇（#19 映射表；前端只认这套，不依赖 PI 事件名）----
export type WriterSseEvent =
  | { event: 'run:start'; data: Record<string, never> }
  | { event: 'delta'; data: { delta: string } }
  | { event: 'message:end'; data: { text: string } }
  | { event: 'tool:start'; data: { toolCallId: string; tool: string } }
  | {
      event: 'tool:end'
      data: { toolCallId: string; tool: string; ok: boolean; isError: boolean; summary: string; lineIds: string[] }
    }
  | { event: 'script:changed'; data: { lineIds: string[] } }
  | { event: 'turn:end'; data: Record<string, never> }
  | { event: 'done'; data: Record<string, never> }
  | { event: 'error'; data: { message: string } }

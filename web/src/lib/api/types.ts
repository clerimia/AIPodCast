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

export interface Speaker {
  id: string
  name: string
  persona: string
  gender: string
  voice: string
}

export interface ShowMetadata {
  outline: string
  topic: string
  tone: string
  terms: string
  bannedWords: string
  intro: string
}

export interface Episode {
  id: string
  wsId: string
  title: string
  showNotes: string
  createdAt: string
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
  | { op: 'add'; afterLineId: string | null; speakerId: string; text: string; instructions?: string }
  | { op: 'edit'; lineId: string; patch: { speakerId?: string; text?: string; instructions?: string } }
  | { op: 'delete'; lineId: string }
  | { op: 'reorder'; lineIds: string[] }

export interface ChangesRequest {
  ops: ChangeOp[]
  summary?: string
}

export interface ChangesResponse {
  changeSetId: string
  invalidatedLineIds: string[]
}

// ---- 合成与产物 ----
export type SynthesisStage = 'tts' | 'post' | 'encode' | 'verify'
/** #22：状态机含 canceling/canceled 两段式取消 */
export type SynthesisStatus = 'pending' | 'running' | 'canceling' | 'succeeded' | 'failed' | 'canceled'

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
  error: string | null
}

/** POST /lines/:lineId/preview */
export interface PreviewResponse {
  asset: { id: string; url: string; durationMs: number }
}

/** POST /episodes/:id/synthesize */
export interface StartSynthesisResponse {
  jobId: string
  statusUrl: string
}

// ---- 写稿大师（M3 消费）----
export interface WriterHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: { tool: string; summary: string }[]
}

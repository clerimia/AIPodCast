// 合成任务编排（M5，#28 重新讨论定案）：synthesis_jobs 落库 + 进程内 async 循环（不引入
// 队列/worker/任务库——编排是纯 I/O，TTS fetch + ffmpeg 子进程）。可持久化状态在 DB，
// 运行期句柄（AbortController/取消旗标）留进程内按 jobId 关联，重启即失。
// 重启收场：启动时把非终态孤儿任务标 interrupted（终态，不自动续跑——素材命中复用，
// 重新合成一次即可）+ 清理上次崩溃残留的任务临时目录。
// 产物整包替换（ADR-0007）：验证通过后才 rename 落位，任何失败/中断不动旧产物。
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import type { JobError } from '../../db/schema.js'
import { artifacts, audioAssets, episodes, postRules, scriptLines, speakers, synthesisJobs } from '../../db/schema.js'
import { getArtifactView, type ArtifactView } from '../artifacts/service.js'
import { computeGaps, SPEED_FACTOR } from '../post/gaps.js'
import { PipelineCanceled, runPostPipeline, type PostLineInput, type PostStage } from '../post/pipeline.js'
import { AppError } from '../../shared/errors.js'
import type { LinePost, PauseLevel, SpeedLevel } from '../../shared/post-params.js'
import { parseSerial } from '../../shared/serial.js'
import type { TtsClient } from './tts.js'
import { synthesizeLine, type SynthesisDeps } from './service.js'

export type SynthesisJobStatus =
  | 'pending'
  | 'running'
  | 'canceling'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'
export type SynthesisJobStage = 'tts' | 'post' | 'encode' | 'verify'

/** 活跃状态（同一单集同时只允许一个活跃任务）；canceling/canceled 随 #22（M6）启用 */
export const ACTIVE_STATUSES: SynthesisJobStatus[] = ['pending', 'running', 'canceling']

export interface SynthesisJobDeps extends SynthesisDeps {
  /** post 七步流水线（测试注入 stub 用） */
  runPipeline: typeof runPostPipeline
  /** 单行 TTS 失败重试退避（#22 语义：进程内重试 1 次；测试可调小） */
  lineRetryBackoffMs?: number
}

/** 任务快照行（启动时固化；任务按快照跑，期间脚本文本可改，下次合成收敛） */
interface PlanLine {
  id: string
  serial: string
  speakerId: string
  speakerName: string
  text: string
  post: LinePost
}

export interface SynthesisJobSnapshot {
  jobId: string
  episodeId: string
  status: SynthesisJobStatus
  stage: SynthesisJobStage | null
  totalLines: number
  doneLines: number
  doneLineIds: string[]
  currentLine: { lineId: string; serial: string } | null
  artifact: ArtifactView | null
  error: JobError | null
}

/** 重试判定（synthesis-progress-and-cancel.md）：超时/网络错误（tts.ts 无 upstreamStatus
 * 的 502）、上游 5xx/429 → 重试 1 次；上游 4xx 参数错误直接失败 */
function isRetryableTtsError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false
  if (err.statusCode === 429) return true
  if (err.statusCode < 500) return false
  const upstream = (err as AppError & { upstreamStatus?: number }).upstreamStatus
  return upstream === undefined || upstream >= 500 || upstream === 429
}

export class SynthesisJobManager {
  private db: Db
  deps: SynthesisJobDeps
  /** 运行期句柄（不落库）；M6 取消端点读写 cancelRequested */
  readonly runtime = new Map<string, { cancelRequested: boolean; abort: AbortController }>()

  constructor(db: Db, deps: SynthesisJobDeps) {
    this.db = db
    this.deps = deps
  }

  /** 进程启动收场：非终态孤儿行标 interrupted + 清理残留任务临时目录（media/tmp/*） */
  async recover(): Promise<void> {
    await this.db
      .update(synthesisJobs)
      .set({
        status: 'interrupted',
        error: {
          code: 'INTERRUPTED',
          message: '进程重启，合成中断；重新发起合成即可（已合成的素材会命中复用）',
        },
      })
      .where(inArray(synthesisJobs.status, ACTIVE_STATUSES))
    await rm(join(this.deps.mediaRoot, 'tmp'), { recursive: true, force: true })
  }

  async get(jobId: string): Promise<SynthesisJobSnapshot | null> {
    const [row] = await this.db.select().from(synthesisJobs).where(eq(synthesisJobs.id, jobId))
    if (!row) return null
    let artifact: ArtifactView | null = null
    if (row.status === 'succeeded') {
      // 产物文件被外部删掉时不拖垮任务快照
      artifact = await getArtifactView(this.db, this.deps.mediaRoot, row.episodeId).catch(() => null)
    }
    return {
      jobId: row.id,
      episodeId: row.episodeId,
      status: row.status as SynthesisJobStatus,
      stage: (row.stage ?? null) as SynthesisJobStage | null,
      totalLines: row.plan.length,
      doneLines: row.doneLineIds.length,
      doneLineIds: row.doneLineIds,
      currentLine: row.currentLine ?? null,
      artifact,
      error: row.error ?? null,
    }
  }

  /** preview 行级互斥（#28 定案）：活跃任务处于 TTS 阶段、该行在快照 plan 内且未计入
   * doneLineIds（正在合成或排队中）→ 锁；已合成行与 post/encode/verify 阶段的任意行照常试听 */
  async isLineLocked(episodeId: string, lineId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ stage: synthesisJobs.stage, plan: synthesisJobs.plan, doneLineIds: synthesisJobs.doneLineIds })
      .from(synthesisJobs)
      .where(
        and(eq(synthesisJobs.episodeId, episodeId), inArray(synthesisJobs.status, ACTIVE_STATUSES)),
      )
      .orderBy(desc(synthesisJobs.createdAt))
      .limit(1)
    if (!row) return false
    if (row.stage !== null && row.stage !== 'tts') return false
    return row.plan.includes(lineId) && !row.doneLineIds.includes(lineId)
  }

  /** 活跃任务快照（#22 active-job 端点，页面重载恢复轮询）：先查活跃（pending/running/
   * canceling），无则查最近一次 interrupted（前端横幅用），都没有 → null */
  async getActive(episodeId: string): Promise<SynthesisJobSnapshot | null> {
    const [active] = await this.db
      .select({ id: synthesisJobs.id })
      .from(synthesisJobs)
      .where(and(eq(synthesisJobs.episodeId, episodeId), inArray(synthesisJobs.status, ACTIVE_STATUSES)))
      .orderBy(desc(synthesisJobs.createdAt))
      .limit(1)
    if (active) return this.get(active.id)

    const [interrupted] = await this.db
      .select({ id: synthesisJobs.id })
      .from(synthesisJobs)
      .where(and(eq(synthesisJobs.episodeId, episodeId), eq(synthesisJobs.status, 'interrupted')))
      .orderBy(desc(synthesisJobs.createdAt))
      .limit(1)
    return interrupted ? this.get(interrupted.id) : null
  }

  /** 请求取消（#22）：写运行期旗标 + 中止在途 TTS，DB 置 canceling（pending/running 才置，
   * 已 canceling 幂等）。终态任务不在此处理（路由判 409）。返回置后快照。 */
  async requestCancel(jobId: string): Promise<SynthesisJobSnapshot | null> {
    const [row] = await this.db
      .select({ id: synthesisJobs.id })
      .from(synthesisJobs)
      .where(eq(synthesisJobs.id, jobId))
    if (!row) return null

    const runtime = this.runtime.get(jobId)
    if (runtime) {
      runtime.cancelRequested = true
      runtime.abort.abort()
    }
    await this.db
      .update(synthesisJobs)
      .set({ status: 'canceling', updatedAt: new Date() })
      .where(and(eq(synthesisJobs.id, jobId), inArray(synthesisJobs.status, ['pending', 'running'])))
    return this.get(jobId)
  }

  /**
   * 发起整集合成： episode 不存在 → 404；无活行 → 400；已有活跃任务 → 409。
   * 任务行落库后进程内起 async 编排（不 await）。
   */
  async start(episodeId: string): Promise<{ jobId: string }> {
    const [ep] = await this.db
      .select({ id: episodes.id, wsId: episodes.wsId, showNotes: episodes.showNotes })
      .from(episodes)
      .where(eq(episodes.id, episodeId))
    if (!ep) throw new AppError('NOT_FOUND', 'episode not found', 404)
    if (await this.activeJobExists(episodeId)) {
      throw new AppError('CONFLICT', '该单集已有合成任务进行中', 409)
    }

    // 快照：活行按 serial 数值序 + 说话人 + 逐行 post + 集级规则
    const rows = await this.db
      .select({
        id: scriptLines.id,
        serial: scriptLines.serial,
        speakerId: scriptLines.speakerId,
        speakerName: speakers.name,
        text: scriptLines.text,
        post: scriptLines.post,
      })
      .from(scriptLines)
      .innerJoin(speakers, eq(speakers.id, scriptLines.speakerId))
      .where(and(eq(scriptLines.episodeId, episodeId), eq(scriptLines.deleted, false)))
    if (rows.length === 0) throw new AppError('BAD_REQUEST', '脚本没有可合成的行', 400)
    const plan: PlanLine[] = rows.map((r) => ({ ...r, post: (r.post ?? {}) as LinePost }))
    plan.sort((a, b) => parseSerial(a.serial) - parseSerial(b.serial))
    const [rules] = await this.db
      .select({ pause: postRules.pause, speed: postRules.speed })
      .from(postRules)
      .where(eq(postRules.episodeId, episodeId))
    const resolvedRules = {
      pause: (rules?.pause ?? '中') as PauseLevel,
      speed: (rules?.speed ?? '正常') as SpeedLevel,
    }

    let job: { id: string }
    try {
      const inserted = await this.db
        .insert(synthesisJobs)
        .values({
          episodeId,
          status: 'pending',
          stage: null,
          plan: plan.map((r) => r.id),
          doneLineIds: [],
          currentLine: null,
          error: null,
        })
        .returning({ id: synthesisJobs.id })
      if (!inserted[0]) throw new Error('synthesis_jobs insert returned no row')
      job = inserted[0]
    } catch (err) {
      // 活跃任务部分唯一索引兜底（并发双击：路由预查与插入之间仍有窗口）
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
        throw new AppError('CONFLICT', '该单集已有合成任务进行中', 409)
      }
      throw err
    }

    void this.run(job.id, episodeId, ep.wsId, ep.showNotes, plan, resolvedRules)
    return { jobId: job.id }
  }

  private async activeJobExists(episodeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: synthesisJobs.id })
      .from(synthesisJobs)
      .where(and(eq(synthesisJobs.episodeId, episodeId), inArray(synthesisJobs.status, ACTIVE_STATUSES)))
      .limit(1)
    return row !== undefined
  }

  // ---- 编排循环（进程内 async；TTS 逐行 → post 七步 → 验证 → 整包替换产物）----

  private async run(
    jobId: string,
    episodeId: string,
    wsId: string,
    showNotes: string,
    plan: PlanLine[],
    rules: { pause: PauseLevel; speed: SpeedLevel },
  ): Promise<void> {
    this.runtime.set(jobId, { cancelRequested: false, abort: new AbortController() })
    const tmpDir = join(this.deps.mediaRoot, 'tmp', jobId)
    // 取消查询：旗标置位（含 PipelineCanceled 由 pipeline 抛出后的旗标态）
    const isCanceled = () => this.runtime.get(jobId)?.cancelRequested === true
    const signal = this.runtime.get(jobId)!.abort.signal
    try {
      await mkdir(tmpDir, { recursive: true })
      // 条件更新（防竞态：canceling 已被置位时不得打回 running）
      await this.db
        .update(synthesisJobs)
        .set({ status: 'running', stage: 'tts', updatedAt: new Date() })
        .where(and(eq(synthesisJobs.id, jobId), eq(synthesisJobs.status, 'pending')))

      // 逐行取/合成素材（复用 synthesizeLine，ADR-0006）；fail-fast：单行重试仍失败即整任务 failed
      const doneLineIds: string[] = []
      for (const line of plan) {
        if (isCanceled()) throw new PipelineCanceled()
        await this.update(jobId, { currentLine: { lineId: line.id, serial: line.serial } })
        try {
          const view = await this.synthesizeLineWithRetry(episodeId, line, signal, isCanceled)
          if (!view) {
            throw new AppError('SYNTH_LINE_FAILED', `${line.serial} 合成失败：行已不存在`, 500)
          }
        } catch (err) {
          // 取消按原样向上抛（toLineError 会把 PipelineCanceled 包装成行失败）
          if (isCanceled() || err instanceof PipelineCanceled) throw err
          throw toLineError(err, line)
        }
        doneLineIds.push(line.id)
        await this.update(jobId, { doneLineIds: [...doneLineIds], currentLine: null })
      }

      // post：素材路径 + 语速系数 + 行间 gap → 七步流水线（stage 回调落库）
      await this.update(jobId, { stage: 'post' })
      const assetRows = await this.db
        .select({ lineId: audioAssets.scriptLineId, audioRef: audioAssets.audioRef })
        .from(audioAssets)
        .where(inArray(audioAssets.scriptLineId, plan.map((l) => l.id)))
      const assetRefByLine = new Map(assetRows.map((r) => [r.lineId, r.audioRef]))
      const gapBeforeMs = computeGaps(plan, rules)
      const inputs: PostLineInput[] = plan.map((line, i) => ({
        lineId: line.id,
        serial: line.serial,
        speakerName: line.speakerName,
        text: line.text,
        assetPath: join(this.deps.mediaRoot, assetRefByLine.get(line.id)!),
        speedFactor: SPEED_FACTOR[line.post.speed ?? rules.speed],
        gapBeforeMs: gapBeforeMs[i] ?? 0,
      }))
      const result = await this.deps.runPipeline(inputs, tmpDir, {
        onStage: (stage: PostStage) => this.update(jobId, { stage }),
        isCanceled,
      })

      // 协作式取消的最后一道：pipeline 正常返回但旗标已置 → 在途步输出随任务废弃，
      // 不进产物落位（取消路径到不了产物替换，ADR-0007）
      if (isCanceled()) throw new PipelineCanceled()

      // 整包替换：验证已过，transcript.json/notes.md 快照 + master.mp3 原子 rename 落位。
      // Windows 上刚写完的文件可能被杀软/索引器短暂锁住（EPERM），rename 带退避重试。
      await writeFile(join(tmpDir, 'transcript.json'), JSON.stringify(result.transcript, null, 2))
      await writeFile(join(tmpDir, 'notes.md'), showNotes)
      const artifactDir = join(this.deps.mediaRoot, `ws-${wsId}`, `ep-${episodeId}`, 'artifacts')
      await mkdir(artifactDir, { recursive: true })
      await renameWithRetry(result.masterPath, join(artifactDir, 'master.mp3'))
      await renameWithRetry(join(tmpDir, 'transcript.json'), join(artifactDir, 'transcript.json'))
      await renameWithRetry(join(tmpDir, 'notes.md'), join(artifactDir, 'notes.md'))
      const rel = (file: string) => `ws-${wsId}/ep-${episodeId}/artifacts/${file}`
      await this.db
        .insert(artifacts)
        .values({
          episodeId,
          audioRef: rel('master.mp3'),
          transcriptRef: rel('transcript.json'),
          notesRef: rel('notes.md'),
          durationMs: Math.round(result.durationMs),
          size: result.size,
        })
        .onConflictDoUpdate({
          target: artifacts.episodeId,
          set: {
            audioRef: rel('master.mp3'),
            transcriptRef: rel('transcript.json'),
            notesRef: rel('notes.md'),
            durationMs: Math.round(result.durationMs),
            size: result.size,
            createdAt: new Date(),
          },
        })

      await this.update(jobId, { status: 'succeeded', currentLine: null })
    } catch (err) {
      // 取消（旗标或 pipeline 抛 PipelineCanceled）：素材保留（已落盘不动）、无产物替换、
      // 不记错误；其余按失败落库（落库失败不掩盖原始错误，finally 清理照常）
      if (isCanceled() || err instanceof PipelineCanceled) {
        await this.update(jobId, { status: 'canceled', error: null, currentLine: null }).catch(() => {})
      } else {
        const error = toJobError(err)
        await this.update(jobId, { status: 'failed', error, currentLine: null }).catch(() => {})
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      this.runtime.delete(jobId)
    }
  }

  /** 单行重试 1 次（2s 退避）；判定见 isRetryableTtsError。取消旗标在重试判定与退避后
   * 各查一次——abort 包装出的 SYNTH_FAILED 会被误判为可重试，必须先看旗标 */
  private async synthesizeLineWithRetry(
    episodeId: string,
    line: PlanLine,
    signal: AbortSignal,
    isCanceled: () => boolean,
  ) {
    const backoff = this.deps.lineRetryBackoffMs ?? 2000
    try {
      return await synthesizeLine(this.db, this.deps, { episodeId, lineId: line.id, signal })
    } catch (err) {
      if (isCanceled()) throw err
      if (!isRetryableTtsError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, backoff))
      if (isCanceled()) throw new PipelineCanceled()
      return synthesizeLine(this.db, this.deps, { episodeId, lineId: line.id, signal })
    }
  }

  private async update(
    jobId: string,
    patch: {
      status?: SynthesisJobStatus
      stage?: SynthesisJobStage | null
      doneLineIds?: string[]
      currentLine?: { lineId: string; serial: string } | null
      error?: JobError | null
    },
  ): Promise<void> {
    await this.db
      .update(synthesisJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(synthesisJobs.id, jobId))
  }
}

function toLineError(err: unknown, line: PlanLine): AppError {
  let appErr: AppError
  if (err instanceof AppError) {
    // TTS 失败以 SYNTH_FAILED 透传（tts.ts）；任务级错误码按 #22 细化为 SYNTH_LINE_FAILED 并携带行
    appErr =
      err.code === 'SYNTH_FAILED'
        ? new AppError('SYNTH_LINE_FAILED', `${line.serial} 合成失败：${err.message}`, err.statusCode)
        : err
  } else {
    appErr = new AppError('SYNTH_LINE_FAILED', `${line.serial} 合成失败：${String(err)}`, 500)
  }
  return Object.assign(appErr, { lineId: line.id, serial: line.serial })
}

function toJobError(err: unknown): JobError {
  if (err instanceof AppError) {
    const withLine = err as AppError & { lineId?: unknown; serial?: unknown }
    return {
      code: err.code,
      message: err.message,
      ...(typeof withLine.lineId === 'string' && { lineId: withLine.lineId }),
      ...(typeof withLine.serial === 'string' && { serial: withLine.serial }),
    }
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

/** Windows 下刚落盘的文件可能被杀软/索引器短暂锁住（rename EPERM），指数退避重试几次 */
async function renameWithRetry(from: string, to: string, attempts = 4): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= attempts - 1 || (code !== 'EPERM' && code !== 'EACCES')) throw err
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** i))
    }
  }
}

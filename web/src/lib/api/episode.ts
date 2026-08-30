// 单集侧端点（#19「单集与脚本」+「后期参数」+「试听/整集合成/产物」表）：脚本读、
// 暂存/确认门提交、后期参数直写、单行试听、整集合成任务（M5）与产物。
import { http } from './http'
import type {
  Artifact,
  ChangesRequest,
  ChangesResponse,
  EpisodeDetail,
  LinePost,
  PostRules,
  PreviewResponse,
  Script,
  StartSynthesisResponse,
  SynthesisJob,
} from './types'

export const episodeApi = {
  /** 单集详情：title / show_notes / post_rules（artifact M2 恒 null） */
  get: (episodeId: string) => http.get<EpisodeDetail>(`/episodes/${episodeId}`),

  /** 当前脚本：过滤 deleted、按 serial */
  getScript: (episodeId: string) => http.get<Script>(`/episodes/${episodeId}/script`),

  /** 暂存/确认门（ADR-0003）：暂存 ops 一次性提交，响应带新脚本 + invalidatedLineIds */
  applyChanges: (episodeId: string, body: ChangesRequest) =>
    http.post<ChangesResponse>(`/episodes/${episodeId}/changes`, body),

  /** 集级后期默认：直接写，不经确认门（ADR-0004） */
  updatePostRules: (episodeId: string, body: Partial<PostRules>) =>
    http.patch<PostRules>(`/episodes/${episodeId}/post-rules`, body),

  /** 逐行后期覆盖：字段给 null 清除覆盖；同样不经门 */
  updateLinePost: (episodeId: string, lineId: string, body: LinePost) =>
    http.patch<LinePost>(`/episodes/${episodeId}/lines/${lineId}/post`, body),

  /** 试听 = 单行合成（同步，ADR-0006）：命中素材直接返回，未命中 TTS 后回填；force 强制重生成 */
  preview: (episodeId: string, lineId: string, force = false) =>
    http.post<PreviewResponse>(`/episodes/${episodeId}/lines/${lineId}/preview`, force ? { force: true } : undefined),

  /** 整集合成（M5）：异步任务，202 返回 jobId + statusUrl；同集已有活跃任务 → 409 */
  synthesize: (episodeId: string) => http.post<StartSynthesisResponse>(`/episodes/${episodeId}/synthesize`),

  /** 合成任务轮询（GET /synthesis-jobs/:jobId）：status/stage/doneLines/totalLines + 终态 error */
  getSynthesisJob: (jobId: string) => http.get<SynthesisJob>(`/synthesis-jobs/${jobId}`),

  /** 取消整集合成（#22）：pending/running → 202（status=canceling）；已在 canceling → 200；
   * 终态 → 409；未知 → 404 */
  cancelSynthesisJob: (jobId: string) => http.post<SynthesisJob>(`/synthesis-jobs/${jobId}/cancel`),

  /** 当前活跃任务（#22 active-job）：pending/running/canceling → 快照；最近一次 interrupted
   * → 快照（「上次合成被中断」横幅）；无 → 404（调用方吞成 null） */
  getActiveSynthesisJob: (episodeId: string) =>
    http.get<SynthesisJob>(`/episodes/${episodeId}/synthesis-job`),

  /** 产物（master mp3 + transcript + notes）；尚未合成 → 404（调用方按需吞成 null） */
  getArtifact: (episodeId: string) => http.get<Artifact>(`/episodes/${episodeId}/artifact`),
}

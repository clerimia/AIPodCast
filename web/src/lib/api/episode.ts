// 单集侧端点（#19「单集与脚本」+「后期参数」表）：脚本读、暂存/确认门提交、后期参数直写。
import { http } from './http'
import type {
  ChangesRequest,
  ChangesResponse,
  EpisodeDetail,
  LinePost,
  PostRules,
  Script,
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

  /** 逐行后期覆盖：字段给 null 清除覆盖；同样不经门（M4 消费） */
  updateLinePost: (episodeId: string, lineId: string, body: LinePost) =>
    http.patch<LinePost>(`/episodes/${episodeId}/lines/${lineId}/post`, body),
}

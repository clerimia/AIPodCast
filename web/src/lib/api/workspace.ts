// 工作间配置端点（#19 表 1「工作间与单集」）：工作间 / 节目元数据 / 说话人 / 单集列表与创建。
// episode.ts（/episodes/:id 侧）M2 落。
import { http } from './http'
import type {
  CreateSpeakerInput,
  Episode,
  ShowMetadata,
  ShowMetadataInput,
  Speaker,
  UpdateSpeakerInput,
  Workspace,
  WorkspaceDetail,
} from './types'

export const workspaceApi = {
  list: () => http.get<Workspace[]>('/workspaces'),

  create: (body: { name: string }) => http.post<Workspace>('/workspaces', body),

  /** 详情一次拉全 show_metadata + speakers */
  get: (wsId: string) => http.get<WorkspaceDetail>(`/workspaces/${wsId}`),

  updateShowMetadata: (wsId: string, body: ShowMetadataInput) =>
    http.put<ShowMetadata>(`/workspaces/${wsId}/show-metadata`, body),

  createSpeaker: (wsId: string, body: CreateSpeakerInput) =>
    http.post<Speaker>(`/workspaces/${wsId}/speakers`, body),

  updateSpeaker: (wsId: string, speakerId: string, body: UpdateSpeakerInput) =>
    http.patch<Speaker>(`/workspaces/${wsId}/speakers/${speakerId}`, body),

  /** 删说话人；被 script_lines 引用 → ApiError(code='CONFLICT', status=409) */
  deleteSpeaker: (wsId: string, speakerId: string) =>
    http.delete<void>(`/workspaces/${wsId}/speakers/${speakerId}`),

  listEpisodes: (wsId: string) => http.get<Episode[]>(`/workspaces/${wsId}/episodes`),

  /** 建单集：后端连带 conversations(kind=writer) + post_rules 默认行 */
  createEpisode: (wsId: string, body: { title: string }) =>
    http.post<Episode>(`/workspaces/${wsId}/episodes`, body),
}

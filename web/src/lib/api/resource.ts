// 资源端点（知识摄入与检索设计 2026-08-31）：列表/上传/粘贴/替换/删除/向量化。
// 检索不给前端——那是写稿大师的工具面。
import { http } from './http'
import type { EmbedResourceResponse, IngestResourceResponse, ResourceSummary } from './types'

export const resourceApi = {
  list: (wsId: string) => http.get<ResourceSummary[]>(`/workspaces/${wsId}/resources`),

  upload: (wsId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.upload<IngestResourceResponse>(`/workspaces/${wsId}/resources`, fd)
  },

  paste: (wsId: string, body: { title: string; text: string }) =>
    http.post<IngestResourceResponse>(`/workspaces/${wsId}/resources`, body),

  replaceWithFile: (wsId: string, resourceId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.upload<IngestResourceResponse>(`/workspaces/${wsId}/resources/${resourceId}/replace`, fd)
  },

  /** 粘贴文本替换资源（与 paste 走同一管道；事务内删旧块 + 写新块） */
  replaceWithText: (wsId: string, resourceId: string, body: { title?: string; text: string }) =>
    http.post<IngestResourceResponse>(`/workspaces/${wsId}/resources/${resourceId}/replace`, body),

  remove: (wsId: string, resourceId: string) =>
    http.delete<void>(`/workspaces/${wsId}/resources/${resourceId}`),

  /** 同步向量化：用户点"向量化"按钮触发。toast 成功 / 部分失败 / 全失败。 */
  embed: (wsId: string, resourceId: string) =>
    http.post<EmbedResourceResponse>(`/workspaces/${wsId}/resources/${resourceId}/embed`),
}
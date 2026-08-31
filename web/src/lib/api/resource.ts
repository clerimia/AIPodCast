// 资源端点（知识摄入与检索设计 2026-08-31）：列表/上传/粘贴/替换/删除。
// 检索不给前端——那是写稿大师的工具面。
import { http } from './http'
import type { IngestResourceResponse, ResourceSummary } from './types'

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

  remove: (wsId: string, resourceId: string) =>
    http.delete<void>(`/workspaces/${wsId}/resources/${resourceId}`),
}
// 工作间配置数据 hooks（frontend-structure.md 数据流表）：详情一次拉全 show_metadata + speakers。
import { useQuery } from '@tanstack/react-query'
import { workspaceApi } from '@/lib/api/workspace'
import { qk } from '@/lib/api/keys'

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces(), queryFn: workspaceApi.list })
}

export function useWorkspace(wsId: string) {
  return useQuery({ queryKey: qk.workspace(wsId), queryFn: () => workspaceApi.get(wsId) })
}

export function useEpisodes(wsId: string) {
  return useQuery({
    queryKey: qk.episodes(wsId),
    queryFn: () => workspaceApi.listEpisodes(wsId),
    enabled: wsId !== '',
  })
}

// 单集/脚本数据 hooks（frontend-structure.md 数据流表）：脚本行是上下两半共享的唯一缓存。
import { useQuery } from '@tanstack/react-query'
import { episodeApi } from '@/lib/api/episode'
import { qk } from '@/lib/api/keys'

export function useEpisode(episodeId: string) {
  return useQuery({
    queryKey: qk.episode(episodeId),
    queryFn: () => episodeApi.get(episodeId),
    enabled: episodeId !== '',
  })
}

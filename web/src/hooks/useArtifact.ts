// 产物摘要（M5）：master mp3 + transcript + notes。未合成过 → 服务端 404，吞成
// null（「还没有产物」分支）；合成 succeeded 后由 useSynthesisJob invalidate 刷新。
import { useQuery } from '@tanstack/react-query'
import { episodeApi } from '@/lib/api/episode'
import { ApiError } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { Artifact } from '@/lib/api/types'

export function useArtifact(episodeId: string) {
  return useQuery({
    queryKey: qk.artifact(episodeId),
    queryFn: async () => {
      try {
        return await episodeApi.getArtifact(episodeId)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    enabled: episodeId !== '',
  })
}

export type { Artifact }

// 素材已作废的行 id（invalidatedLineIds）：StagingBar 提交改动后经 setQueryData 写入
// ['invalidated', ep] 缓存，音频区据此亮「需重新合成」（#19/#27）。
// 该键无服务端来源（只在提交响应里出现），queryFn 仅兜底空集；staleTime:Infinity
// 保证不被 refetch 冲掉，数据只经 setQueryData 更新（订阅者随之重渲染）。
import { useQuery } from '@tanstack/react-query'
import { qk } from '@/lib/api/keys'

export function useInvalidatedLineIds(episodeId: string): Set<string> {
  const { data } = useQuery({
    queryKey: qk.invalidated(episodeId),
    queryFn: () => [] as string[],
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return new Set(data ?? [])
}

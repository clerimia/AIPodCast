// 脚本行 hook：['script', episodeId] 是文本侧与音频侧共同消费的唯一真相缓存。
import { useQuery } from '@tanstack/react-query'
import { episodeApi } from '@/lib/api/episode'
import { qk } from '@/lib/api/keys'

export function useScript(episodeId: string) {
  return useQuery({
    queryKey: qk.script(episodeId),
    queryFn: () => episodeApi.getScript(episodeId),
    enabled: episodeId !== '',
  })
}

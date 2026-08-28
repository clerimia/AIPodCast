import { useParams } from 'react-router'

// 编辑页（M2 落上下两半布局 + 暂存条；M3/M4 落写稿大师与音频工作区）
export default function EpisodePage() {
  const { wsId, episodeId } = useParams()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2">
      <p className="text-lg font-medium">编辑页（M2 落地）</p>
      <p className="text-sm text-muted-foreground">
        ws {wsId} · episode {episodeId}
      </p>
    </div>
  )
}

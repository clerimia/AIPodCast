import { Link, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { ShowMetadataForm } from '@/features/workspace-settings/ShowMetadataForm'
import { SpeakerList } from '@/features/workspace-settings/SpeakerList'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ApiError, apiErrorMessage } from '@/lib/api/http'

// 工作间设置（#20 路由表 /workspaces/:wsId/settings）：
// 节目元数据表单 + 说话人增删改；不碰脚本、不碰音频、不碰会话。
export default function WorkspaceSettingsPage() {
  const { wsId = '' } = useParams()
  const workspace = useWorkspace(wsId)

  return (
    <div className="mx-auto min-h-svh max-w-3xl space-y-4 p-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">← 返回工作间列表</Link>
        </Button>
      </div>

      {workspace.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {workspace.isError && (
        <p className="text-sm text-destructive">
          {workspace.error instanceof ApiError && workspace.error.code === 'NOT_FOUND'
            ? '工作间不存在'
            : `加载失败：${apiErrorMessage(workspace.error)}`}
        </p>
      )}

      {workspace.data && (
        <>
          <header>
            <h1 className="text-2xl font-semibold">{workspace.data.name}</h1>
            <p className="text-sm text-muted-foreground">工作间设置</p>
          </header>
          <ShowMetadataForm wsId={wsId} metadata={workspace.data.showMetadata} />
          <SpeakerList wsId={wsId} speakers={workspace.data.speakers} />
        </>
      )}
    </div>
  )
}

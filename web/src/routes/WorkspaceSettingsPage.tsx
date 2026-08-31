import { Link, useParams } from 'react-router'
import { ArrowLeft, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { ShowMetadataForm } from '@/features/workspace-settings/ShowMetadataForm'
import { SpeakerList } from '@/features/workspace-settings/SpeakerList'
import { ResourceList } from '@/features/resources/ResourceList'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ApiError, apiErrorMessage } from '@/lib/api/http'
import { EmptyState } from '@/components/ui/empty-state'

// 工作间设置（#20 路由表 /workspaces/:wsId/settings）：
// 节目元数据表单 + 说话人增删改；不碰脚本、不碰音频、不碰会话。
//
// 手感层：原来返回箭头指向「工作间列表」，但从编辑页点「工作间设置」进来后，返回应该
// 回到**这个工作间**（单集列表）——语义上更近的一层。同时补上品牌标识与主题切换。
export default function WorkspaceSettingsPage() {
  const { wsId = '' } = useParams()
  const workspace = useWorkspace(wsId)

  return (
    <div className="mx-auto min-h-svh max-w-3xl px-6 py-8">
      <header className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="返回工作间" title="返回工作间">
          <Link to={`/workspaces/${wsId}`}>
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
          {workspace.isPending ? '加载中…' : (workspace.data?.name ?? '工作间设置')}
        </h1>
        <ThemeToggle />
      </header>

      <div className="mt-2 flex items-center gap-1.5 pl-11 text-sm text-muted-foreground">
        <Settings className="size-3.5" />
        工作间设置：这里的配置对整档节目生效，跨单集共享
      </div>

      {workspace.isPending && (
        <div className="mt-6 space-y-4">
          <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
          <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
        </div>
      )}

      {workspace.isError && (
        <div className="mt-6">
          <EmptyState
            title={
              workspace.error instanceof ApiError && workspace.error.code === 'NOT_FOUND'
                ? '工作间不存在'
                : '加载失败'
            }
            description={apiErrorMessage(workspace.error)}
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/">回到工作间列表</Link>
              </Button>
            }
          />
        </div>
      )}

      {workspace.data && (
        <div className="mt-6 space-y-4">
          <ShowMetadataForm wsId={wsId} metadata={workspace.data.showMetadata} />
          <SpeakerList wsId={wsId} speakers={workspace.data.speakers} />
          <ResourceList wsId={wsId} />
        </div>
      )}
    </div>
  )
}

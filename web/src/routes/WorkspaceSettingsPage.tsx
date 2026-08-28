import { useParams } from 'react-router'

// 工作间设置（M1 落节目元数据表单 + 说话人增删改）
export default function WorkspaceSettingsPage() {
  const { wsId } = useParams()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2">
      <p className="text-lg font-medium">工作间设置（M1 落地）</p>
      <p className="text-sm text-muted-foreground">ws {wsId}</p>
    </div>
  )
}

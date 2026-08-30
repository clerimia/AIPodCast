// 运行状态条：run:start → done/error 之间显示生成中 + 当前窗口的工具状态
// （tool:start 显示「正在…」，tool:end 落摘要，isError 标红；窗口 = 上一条
// message:end 之后的调用，随归属进 Task 块而清空，另有累计步数防长 run 堆积）。
// 工具中文标签上浮导出（ChatStream 的 Task 清单复用，ADR-0010）。
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWriterRunStore } from '@/stores/writer-run'

const TOOL_LABEL: Record<string, string> = {
  read: '读脚本',
  add: '写脚本',
  edit: '改脚本',
}

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool
}

export function RunStatusBar({ episodeId }: { episodeId: string }) {
  const run = useWriterRunStore((s) => s.runs[episodeId])
  if (!run?.running && !run?.error) return null

  return (
    <div className="flex flex-col gap-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
      {run.error && <p className="text-destructive">{run.error}</p>}
      {run.tools.map((t) => (
        <p key={t.toolCallId} className="flex items-center gap-1.5">
          {t.state === 'running' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <span className={cn('size-1.5 rounded-full', t.state === 'ok' ? 'bg-emerald-500' : 'bg-destructive')} />
          )}
          {t.state === 'running'
            ? (TOOL_LABEL[t.tool] ? `正在${TOOL_LABEL[t.tool]}…` : `正在调用 ${t.tool}…`)
            : t.summary || '完成'}
        </p>
      ))}
      {run.running && run.toolsDone > 0 && <p>本轮已完成 {run.toolsDone} 步</p>}
      {run.running && run.tools.every((t) => t.state !== 'running') && (
        <p className="flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" /> 生成中…
        </p>
      )}
    </div>
  )
}

// 运行状态条：run:start → done/error 之间显示生成中 + 当前窗口的工具状态
// （tool:start 显示「正在…」，tool:end 落摘要，isError 标红；窗口 = 上一条
// message:end 之后的调用，随归属进 Task 块而清空，另有累计步数防长 run 堆积）。
// 工具中文标签上浮导出（ChatStream 的 Task 清单复用，ADR-0010）。
//
// 手感层：这条是「它还在干活」的唯一信号，所以要能被余光看见——加了已用秒数与
// 累计步数（长 run 没有推进指示会让人以为卡死了），并把整条染成品牌色底。
import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
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
  const running = run?.running ?? false
  const [elapsed, setElapsed] = useState(0)
  const [prevRunning, setPrevRunning] = useState(running)

  // 每轮 run 重新计时：running 由 store 驱动（外部状态），用「渲染期对比上一值」
  // 的惯用法归零，而不是在 effect 里 setState（后者会多触发一轮渲染）
  if (prevRunning !== running) {
    setPrevRunning(running)
    setElapsed(0)
  }

  // 秒表只在生成期间跑
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [running])

  if (!running && !run?.error) return null

  return (
    <div className="shrink-0 animate-rise border-t bg-brand-soft px-3 py-2">
      {run?.error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <XCircle className="mt-px size-3 shrink-0" />
          {run.error}
        </p>
      )}

      {run?.tools && run.tools.length > 0 && (
        <ul className="space-y-1">
          {run.tools.map((t) => (
            <li key={t.toolCallId} className="flex items-center gap-1.5 text-xs">
              {t.state === 'running' ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
              ) : t.state === 'ok' ? (
                <CheckCircle2 className="size-3 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="size-3 shrink-0 text-destructive" />
              )}
              <span className="shrink-0 font-medium text-foreground">
                {t.state === 'running' ? `正在${toolLabel(t.tool)}…` : toolLabel(t.tool)}
              </span>
              {t.state !== 'running' && (
                <span className="min-w-0 truncate text-muted-foreground">{t.summary || '完成'}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {running && (
        <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', run.tools.length > 0 && 'mt-1')}>
          <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
          生成中…
          {elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
          {run.toolsDone > 0 && <span>· 已完成 {run.toolsDone} 步</span>}
        </p>
      )}
    </div>
  )
}

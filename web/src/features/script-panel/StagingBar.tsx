import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useCommitStaged } from '@/features/script-panel/use-commit-staged'
import { formatHotkey } from '@/lib/hotkeys'

// 暂存条（ADR-0003）：N 处改动待提交 · 撤销全部 / 提交改动。
// 提交 = POST /changes：成功后清空 store、用响应的新脚本直写缓存、invalidatedLineIds
// 写入 invalidated 缓存（音频区据此亮「需重新合成」；整集合成成功后清除）。
//
// 手感层：文案改动前是「还没落定」这一状态的最强提示，所以让它浮起来——带呼吸的琥珀
// 圆点（一眼看出有事没办）、入场动画（出现时不突兀）、以及 ⌘↵ 直接提交的键位提示。
// 提交逻辑上浮到 useCommitStaged，命令面板与快捷键走的是同一条路径。
export function StagingBar({ episodeId }: { episodeId: string }) {
  const { commit, isPending, ops, blocker, clearAll } = useCommitStaged(episodeId)

  if (ops.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full animate-rise items-center gap-2 rounded-full border bg-background/95 py-1.5 pr-1.5 pl-4 shadow-xl backdrop-blur">
        <span aria-hidden className="size-1.5 shrink-0 animate-breathe rounded-full bg-amber-500" />
        <span className="text-sm whitespace-nowrap">
          <span className="font-medium tabular-nums">{ops.length}</span> 处改动待提交
        </span>
        {blocker && (
          <span className="hidden max-w-56 truncate text-xs text-destructive sm:inline" title={blocker}>
            {blocker}
          </span>
        )}

        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={clearAll}
          className="text-muted-foreground"
        >
          撤销全部
        </Button>
        <Button
          size="sm"
          disabled={isPending || blocker !== null}
          title={blocker ?? `提交改动（${formatHotkey('mod+enter')}）`}
          onClick={() => commit()}
        >
          {isPending ? '提交中…' : '提交改动'}
          {!isPending && <Kbd className="ml-1 hidden border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground md:inline-flex">{formatHotkey('mod+enter')}</Kbd>}
        </Button>
      </div>
    </div>
  )
}

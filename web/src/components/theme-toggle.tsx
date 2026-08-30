import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'

// 主题切换（亮 / 暗 / 跟随系统）：next-themes 在 <html> 上加 class，
// index.css 的 @custom-variant dark (&:is(.dark *)) 据此生效。
//
// 不需要 SSR 那套 mounted 守卫：这是 Vite CSR 应用，next-themes 在首帧就能从
// localStorage 读出 theme，不存在水合前后不一致的问题。图标的亮/暗切换干脆交给
// CSS 的 dark: 变体（跟着 <html> 上的 class 走），连 theme 值都不用读。
const OPTIONS = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="切换主题"
          title="切换主题"
          className={cn('relative', className)}
        >
          <Sun className="size-4 rotate-0 scale-100 transition-transform duration-200 dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-transform duration-200 dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)} className="gap-2">
            <Icon className="size-4" />
            <span>{label}</span>
            {theme === value && <span className="ml-auto text-xs text-brand">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

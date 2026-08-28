import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { http } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import type { Health } from '@/lib/api/types'

// 工作间列表（脚手架页，M1 落完整列表/建工作间/建单集）。
// M0 先用 health 打通「Vite 页面 → proxy → 后端 → Postgres」整条链路。
export default function HomePage() {
  const health = useQuery({
    queryKey: qk.health(),
    queryFn: () => http.get<Health>('/health'),
    refetchInterval: 5000,
  })

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Podcast Studio</CardTitle>
          <CardDescription>单用户 AI 播客工作间（M0 骨架）</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          {health.isFetching && <span className="text-muted-foreground">检查后端…</span>}
          {health.isError && (
            <>
              <Badge variant="destructive">后端不可达</Badge>
              <span className="text-muted-foreground">{String(health.error)}</span>
            </>
          )}
          {health.data && (
            <>
              <Badge>后端正常</Badge>
              <span className="text-muted-foreground">数据库 {health.data.db}</span>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ApiError, apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import { voiceLabel } from '@/lib/voices'
import type { Speaker } from '@/lib/api/types'
import { SpeakerDialog } from './SpeakerDialog'

// 说话人增删改（#19「工作间设置」消费方式）。
// 删除被 script_lines 引用的说话人 → 409 CONFLICT → toast 引导先改绑脚本行。
export function SpeakerList({ wsId, speakers }: { wsId: string; speakers: Speaker[] }) {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Speaker | null>(null)

  const remove = useMutation({
    mutationFn: (id: string) => workspaceApi.deleteSpeaker(wsId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.workspace(wsId) })
      toast.success('说话人已删除')
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        toast.error('该说话人已被脚本行引用，暂不能删除', {
          description: '请先在引用它的单集里改绑或删除相关脚本行，再回来删除。',
        })
      } else {
        toast.error(`删除失败：${apiErrorMessage(e)}`)
      }
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>说话人</CardTitle>
        <CardDescription>脚本行引用说话人 id；合成时经说话人取音色</CardDescription>
        <CardAction>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            新增说话人
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {speakers.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有说话人，先建一个。</p>
        )}
        {speakers.map((s) => (
          <div
            key={s.id}
            className="flex items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {s.gender && <Badge variant="secondary">{s.gender}</Badge>}
                <Badge variant="outline">{voiceLabel(s.voice)}</Badge>
              </div>
              {s.persona && <p className="text-sm text-muted-foreground">{s.persona}</p>}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(s)
                  setDialogOpen(true)
                }}
              >
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(s.id)}
              >
                删除
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
      <SpeakerDialog wsId={wsId} speaker={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
    </Card>
  )
}

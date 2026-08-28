import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import { VOICES } from '@/lib/voices'
import type { Speaker } from '@/lib/api/types'

interface SpeakerDialogProps {
  wsId: string
  /** null = 新建 */
  speaker: Speaker | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 说话人新建/编辑共用一个对话框：名称 + 人设 + 性别 + 音色（24 系统音色选一）。
export function SpeakerDialog({ wsId, speaker, open, onOpenChange }: SpeakerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          // 每次打开重新挂载，表单从目标说话人重新初始化
          <SpeakerForm
            key={speaker?.id ?? 'new'}
            wsId={wsId}
            speaker={speaker}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SpeakerForm({
  wsId,
  speaker,
  onDone,
}: {
  wsId: string
  speaker: Speaker | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(speaker?.name ?? '')
  const [persona, setPersona] = useState(speaker?.persona ?? '')
  const [gender, setGender] = useState(speaker?.gender ?? '')
  const [voice, setVoice] = useState(speaker?.voice ?? VOICES[0]!.name)

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), persona, gender, voice }
      return speaker
        ? workspaceApi.updateSpeaker(wsId, speaker.id, body)
        : workspaceApi.createSpeaker(wsId, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.workspace(wsId) })
      toast.success(speaker ? '说话人已更新' : '说话人已创建')
      onDone()
    },
    onError: (e) => toast.error(`保存失败：${apiErrorMessage(e)}`),
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>{speaker ? '编辑说话人' : '新增说话人'}</DialogTitle>
        <DialogDescription>名称与人设供写稿大师引用，音色在合成时取用</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="speaker-name">名称</Label>
          <Input
            id="speaker-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：主持人、嘉宾"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="speaker-persona">人设</Label>
          <Textarea
            id="speaker-persona"
            rows={2}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="角色定位与口吻，写稿时引用"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="speaker-gender">性别</Label>
            <Input
              id="speaker-gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              placeholder="男 / 女…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="speaker-voice">音色</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger id="speaker-voice" className="w-full">
                <SelectValue placeholder="选择音色" />
              </SelectTrigger>
              <SelectContent>
                {VOICES.map((v) => (
                  <SelectItem key={v.name} value={v.name}>
                    {v.name} · {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button onClick={() => save.mutate()} disabled={name.trim() === '' || save.isPending}>
          {save.isPending ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </>
  )
}

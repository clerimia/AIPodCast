import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { workspaceApi } from '@/lib/api/workspace'
import type { ShowMetadata } from '@/lib/api/types'

const FIELDS = ['outline', 'topic', 'tone', 'terms', 'bannedWords', 'intro'] as const

// 节目元数据表单（CONTEXT.md：整档节目常驻设置，写稿时遵守、跨单集共享）。
// 六字段整单 PUT；本地暂存编辑，服务器值变化（保存成功/失效重拉）后同步。
export function ShowMetadataForm({ wsId, metadata }: { wsId: string; metadata: ShowMetadata }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ShowMetadata>(metadata)
  const [seenMetadata, setSeenMetadata] = useState(metadata)
  if (metadata !== seenMetadata) {
    // 服务器值刷新后采纳（React「渲染期调整 state」惯例，替代 effect）
    setSeenMetadata(metadata)
    setForm(metadata)
  }

  const save = useMutation({
    mutationFn: () => workspaceApi.updateShowMetadata(wsId, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.workspace(wsId) })
      toast.success('节目元数据已保存')
    },
    onError: (e) => toast.error(`保存失败：${apiErrorMessage(e)}`),
  })

  const dirty = FIELDS.some((key) => form[key] !== metadata[key])

  return (
    <Card>
      <CardHeader>
        <CardTitle>节目元数据</CardTitle>
        <CardDescription>大纲 / 主题 / 口吻 / 术语 / 禁词 / 节目简介</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="meta-outline">节目大纲</Label>
          <Textarea
            id="meta-outline"
            rows={3}
            value={form.outline}
            onChange={(e) => setForm({ ...form, outline: e.target.value })}
            placeholder="这档节目整体怎么走"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="meta-topic">主题</Label>
            <Input
              id="meta-topic"
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
              placeholder="每期围绕什么聊"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta-tone">口吻</Label>
            <Input
              id="meta-tone"
              value={form.tone}
              onChange={(e) => setForm({ ...form, tone: e.target.value })}
              placeholder="轻松 / 严谨…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta-terms">术语</Label>
            <Input
              id="meta-terms"
              value={form.terms}
              onChange={(e) => setForm({ ...form, terms: e.target.value })}
              placeholder="领域术语，逗号分隔"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meta-banned">禁词</Label>
            <Input
              id="meta-banned"
              value={form.bannedWords}
              onChange={(e) => setForm({ ...form, bannedWords: e.target.value })}
              placeholder="不想出现的词，逗号分隔"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="meta-intro">节目简介</Label>
          <Textarea
            id="meta-intro"
            rows={3}
            value={form.intro}
            onChange={(e) => setForm({ ...form, intro: e.target.value })}
            placeholder="整档节目的介绍：讲什么、面向谁"
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

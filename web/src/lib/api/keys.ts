// Query key 工厂：脚本行等共享数据的唯一真相是 Query 缓存键（frontend-structure.md）
export const qk = {
  health: () => ['health'] as const,
  workspaces: () => ['workspaces'] as const,
  workspace: (wsId: string) => ['workspace', wsId] as const,
  episodes: (wsId: string) => ['episodes', wsId] as const,
  episode: (episodeId: string) => ['episode', episodeId] as const,
  script: (episodeId: string) => ['script', episodeId] as const,
  /** 写稿历史（页面装载回放气泡；change_set 等 display:false 服务端已过滤） */
  writerHistory: (episodeId: string) => ['writer-history', episodeId] as const,
  /** 素材已作废的行 id（invalidatedLineIds，提交改动后写入；音频区据此亮「需重新合成」，整集合成成功后清除） */
  invalidated: (episodeId: string) => ['invalidated', episodeId] as const,
  artifact: (episodeId: string) => ['artifact', episodeId] as const,
  synthesisJob: (jobId: string) => ['synthesis-job', jobId] as const,
}

// 整集合成任务态（frontend-structure.md stores）：只存「该单集当前关注哪个 jobId」，
// 不镜像任务字段——status/stage/progress 一律以 ['synthesis-job', jobId] Query 缓存为准。
// 存 jobId 是为了让「写稿/后期」视图切换（组件卸载重挂）不丢轮询：hook 重挂时按
// jobId 恢复查询，终态后由 hook 清除。
import { create } from 'zustand'

interface SynthesisJobState {
  jobIds: Record<string, string | null>
  setJobId(episodeId: string, jobId: string): void
  clearJobId(episodeId: string): void
}

export const useSynthesisJobStore = create<SynthesisJobState>((set) => ({
  jobIds: {},
  setJobId: (episodeId, jobId) =>
    set((state) => ({ jobIds: { ...state.jobIds, [episodeId]: jobId } })),
  clearJobId: (episodeId) =>
    set((state) => ({ jobIds: { ...state.jobIds, [episodeId]: null } })),
}))

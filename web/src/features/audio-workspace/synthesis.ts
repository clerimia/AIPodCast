// 合成任务前端纯逻辑（#28）：终态判定 / 轮询间隔 / 阶段文案。与轮询 hook 分离以便
// 单测；状态词汇对照 docs/synthesis-progress-and-cancel.md（interrupted = 重启收场终态）。
import type { SynthesisStage, SynthesisStatus } from '@/lib/api/types'

/** 终态：轮询停止、进度条收场。canceling 是活跃态（等 canceled 两段式收场，M6） */
export function isTerminalJobStatus(status: SynthesisStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'interrupted'
}

/** 活跃态：任务仍在跑（同一单集同时只允许一个活跃任务；canceling 仍在收尾中） */
export function isActiveJobStatus(status: SynthesisStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'canceling'
}

/** useSynthesisJob 的 refetchInterval：活跃态 2s（issue 定案），终态 false 停 */
export function jobRefetchInterval(status: SynthesisStatus): number | false {
  return isTerminalJobStatus(status) ? false : 2000
}

/** 进度条阶段文案（stage 为 null = 已落库尚未开跑，排队中） */
export function stageLabel(stage: SynthesisStage | null): string {
  switch (stage) {
    case null:
      return '排队等待中…'
    case 'tts':
      return '逐行合成语音中'
    case 'post':
      return '拼接与响度归一中'
    case 'verify':
      return '校验产物时间轴中'
    case 'encode':
      return '编码 mp3 中'
  }
}

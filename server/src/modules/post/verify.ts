// 确定性验证（docs/audio-params.md 管线第 6 步）：期望（参数数学）vs 实测（ffprobe）
// 总时长 ≤150 ms 容差 + 行级时间戳单调连续 + 行数一致。不过 → AppError SYNTH_VERIFY_FAILED，
// 编排层据此把任务置 failed、保留旧产物（ADR-0007：整包替换只发生在验证通过后）。
import { AppError } from '../../shared/errors.js'
import { runFfCli } from './ffmpeg.js'
import type { TranscriptEntry } from './pipeline.js'

export const DURATION_TOLERANCE_MS = 150

/** 总时长验证：|实测 − 期望| ≤ 150 ms（mp3 帧粒度 + 逐行渲染舍入的预算） */
export function checkMeasuredDuration(expectedMs: number, measuredMs: number, what: string): void {
  if (!Number.isFinite(measuredMs)) {
    throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：${what} 实测时长无效`, 500)
  }
  const drift = Math.abs(measuredMs - expectedMs)
  if (drift > DURATION_TOLERANCE_MS) {
    throw new AppError(
      'SYNTH_VERIFY_FAILED',
      `确定性验证不过：${what} 期望 ${Math.round(expectedMs)}ms，实测 ${Math.round(measuredMs)}ms（偏差 ${Math.round(drift)}ms > ${DURATION_TOLERANCE_MS}ms 容差）`,
      500,
    )
  }
}

/** 时间戳验证：行数一致、行内起止为正、相邻行单调连续（start_{i+1} ≥ end_i） */
export function checkTranscript(entries: TranscriptEntry[], lineCount: number): void {
  if (entries.length !== lineCount) {
    throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：行数不符，期望 ${lineCount}，得 ${entries.length}`, 500)
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (!(entry.endMs > entry.startMs)) {
      throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：第 ${i + 1} 行起止时刻非正（${entry.startMs}..${entry.endMs}）`, 500)
    }
    if (i > 0 && entry.startMs < entries[i - 1]!.endMs) {
      throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：第 ${i + 1} 行时间戳早于前行结束（非单调）`, 500)
    }
  }
}

/** ffprobe 读容器时长（秒 → ms） */
export async function ffprobeDurationMs(path: string, timeoutMs?: number): Promise<number> {
  const { stdout } = await runFfCli(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
    { timeoutMs },
  )
  let parsed: number | null = null
  try {
    const json = JSON.parse(stdout) as { format?: { duration?: string } }
    const value = Number.parseFloat(json.format?.duration ?? '')
    parsed = Number.isFinite(value) ? value : null
  } catch {
    parsed = null
  }
  if (parsed === null) {
    throw new AppError('SYNTH_VERIFY_FAILED', `ffprobe 读不到时长：${path}`, 500)
  }
  return parsed * 1000
}

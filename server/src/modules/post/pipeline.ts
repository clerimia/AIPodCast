// 后期流水线（M5，docs/audio-params.md「管线顺序」七步，ADR-0007 确定性后期）：
// 1 逐行 atempo → 2 行间静音 gap（anullsrc 24k mono）→ 3 concat demuxer 拼接 →
// 4 loudnorm 两遍线性（-16 LUFS / LRA 7 / TP -1.5 dBTP）→ 5 回填行级时间戳（确定性计算）→
// 6 确定性验证（≤150ms 容差 + 时间戳单调，不过即 SYNTH_VERIFY_FAILED）→ 7 编码 mp3 44.1k mono 128k CBR。
// 纯文件进文件出：无 DB、无 DashScope。全部中间产物落 outDir（任务临时目录，终态由编排层清理）；
// 输入素材固定引擎 wav 24k mono 16-bit。stage 回调映射编排层的任务阶段（1–5=post、6=verify、7=encode）。
import { stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../../shared/errors.js'
import { wavPcmDurationMs } from '../../shared/wav.js'
import { runFfCli } from './ffmpeg.js'
import { checkMeasuredDuration, checkTranscript, ffprobeDurationMs } from './verify.js'

export const LOUDNORM_TARGETS = { I: -16, LRA: 7, TP: -1.5 } as const

/** 行级文稿（产物 transcript.json 的条目；startMs/endMs 由流水线确定性计算） */
export interface TranscriptEntry {
  serial: string
  speakerName: string
  text: string
  startMs: number
  endMs: number
}

export interface PostLineInput {
  lineId: string
  serial: string
  speakerName: string
  text: string
  /** 素材绝对路径（引擎 wav 24k mono 16-bit） */
  assetPath: string
  /** 语速档位系数（慢 0.9 / 正常 1.0 / 快 1.15；1 不挂 atempo） */
  speedFactor: number
  /** 该行开口前的行间静音 ms（首行 0；由后一行 pause 档位决定、换说话人 +400） */
  gapBeforeMs: number
}

export type PostStage = 'post' | 'verify' | 'encode'

export interface PostPipelineOptions {
  /** 阶段回调（编排层据此落库 stage）；回调抛错即中止流水线 */
  onStage?: (stage: PostStage) => void | Promise<void>
  /** 单步 ffmpeg 超时（缺省 runFfCli 默认） */
  stepTimeoutMs?: number
}

export interface PostPipelineResult {
  masterPath: string
  transcript: TranscriptEntry[]
  /** 最终 mp3 实测时长（ffprobe） */
  durationMs: number
  /** 最终 mp3 字节数 */
  size: number
}

/** 预期（参数数学）：rendered_i = 素材 PCM 时长 / 语速系数；start_i = Σ(前面各行 rendered + 行前 gap) */
export function computeTimeline(lines: PostLineInput[], renderedMs: number[]): {
  transcript: TranscriptEntry[]
  totalMs: number
} {
  const transcript: TranscriptEntry[] = []
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const startMs = Math.round(start)
    const endMs = Math.max(Math.round(start + renderedMs[i]!), startMs + 1)
    transcript.push({
      serial: line.serial,
      speakerName: line.speakerName,
      text: line.text,
      startMs,
      endMs,
    })
    start = endMs + (lines[i + 1]?.gapBeforeMs ?? 0)
  }
  return { transcript, totalMs: transcript.at(-1)?.endMs ?? 0 }
}

export async function runPostPipeline(
  lines: PostLineInput[],
  outDir: string,
  opts: PostPipelineOptions = {},
): Promise<PostPipelineResult> {
  const { stepTimeoutMs, onStage } = opts
  if (lines.length === 0) throw new AppError('BAD_REQUEST', '没有可拼接的脚本行', 400)

  // 素材完整预检（验证项「行数/素材完整」的最前置部分）：非 RIFF wav / 头解析失败即验证失败
  const renderedMs: number[] = []
  for (const line of lines) {
    let bytes: Buffer
    try {
      bytes = await readFile(line.assetPath)
    } catch {
      throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：素材缺失（${line.serial}）`, 500)
    }
    const pcmMs = wavPcmDurationMs(bytes)
    if (pcmMs === null || pcmMs <= 0) {
      throw new AppError('SYNTH_VERIFY_FAILED', `确定性验证不过：素材不是有效 PCM wav（${line.serial}）`, 500)
    }
    renderedMs.push(pcmMs / line.speedFactor)
  }

  await onStage?.('post')

  // 步 1+2：逐行渲染（atempo 仅语速 ≠ 正常时挂）+ 行前静音 gap（anullsrc 24k mono）
  const concatEntries: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const segPath = join(outDir, `seg-${pad(i)}.wav`)
    const filters = line.speedFactor !== 1 ? [`atempo=${line.speedFactor}`] : []
    await runFfCli(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-nostats', '-i', line.assetPath,
        ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
        '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', segPath,
      ],
      { timeoutMs: stepTimeoutMs },
    )
    if (line.gapBeforeMs > 0) {
      const gapPath = join(outDir, `gap-${pad(i)}.wav`)
      await runFfCli(
        'ffmpeg',
        [
          '-y', '-hide_banner', '-nostats',
          '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`,
          '-t', (line.gapBeforeMs / 1000).toFixed(3),
          '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', gapPath,
        ],
        { timeoutMs: stepTimeoutMs },
      )
      concatEntries.push(listEntry(gapPath))
    }
    concatEntries.push(listEntry(segPath))
  }

  // 步 3：concat demuxer 按行序拼接（24k mono PCM）
  const concatPath = join(outDir, 'concat.wav')
  await writeFile(join(outDir, 'list.txt'), concatEntries.join('\n'), 'utf8')
  await runFfCli(
    'ffmpeg',
    ['-y', '-hide_banner', '-nostats', '-f', 'concat', '-safe', '0', '-i', join(outDir, 'list.txt'),
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', concatPath],
    { timeoutMs: stepTimeoutMs },
  )

  // 步 4：loudnorm 两遍线性（先测后线性增益，不动动态范围）
  const target = `I=${LOUDNORM_TARGETS.I}:LRA=${LOUDNORM_TARGETS.LRA}:TP=${LOUDNORM_TARGETS.TP}`
  const pass1 = await runFfCli(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', concatPath, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
    { timeoutMs: stepTimeoutMs },
  )
  const measured = parseLoudnormJson(pass1.stderr)
  const normPath = join(outDir, 'norm.wav')
  await runFfCli(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-nostats', '-i', concatPath,
      '-af',
      `loudnorm=${target}:linear=true:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset},aresample=24000`,
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', normPath,
    ],
    { timeoutMs: stepTimeoutMs },
  )

  // 步 5：回填行级时间戳（确定性计算，不测音频）
  const { transcript, totalMs } = computeTimeline(lines, renderedMs)

  // 步 6：确定性验证（期望 vs 实测 ≤150ms、时间戳单调连续、行数一致）
  await onStage?.('verify')
  const normMs = await ffprobeDurationMs(normPath, stepTimeoutMs)
  checkMeasuredDuration(totalMs, normMs, '拼接归一后总时长')
  checkTranscript(transcript, lines.length)

  // 步 7：编码产物 mp3 44.1k mono 128k CBR
  await onStage?.('encode')
  const masterPath = join(outDir, 'master.mp3')
  await runFfCli(
    'ffmpeg',
    ['-y', '-hide_banner', '-nostats', '-i', normPath,
      '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', masterPath],
    { timeoutMs: stepTimeoutMs },
  )
  const durationMs = await ffprobeDurationMs(masterPath, stepTimeoutMs)
  const size = (await stat(masterPath)).size

  return { masterPath, transcript, durationMs, size }
}

/** loudnorm 两遍的第一遍输出（stderr JSON 块）：字段原样回传第二遍（字符串数值） */
function parseLoudnormJson(stderr: string): {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
} {
  const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>
      const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
      if (fields.every((f) => typeof parsed[f] === 'string')) {
        return Object.fromEntries(fields.map((f) => [f, parsed[f] as string])) as ReturnType<
          typeof parseLoudnormJson
        >
      }
    } catch {
      // 落到下面的统一报错
    }
  }
  throw new AppError('SYNTH_POST_FAILED', `loudnorm 第一遍输出解析失败：${stderr.slice(-200)}`, 500)
}

function pad(i: number): string {
  return String(i).padStart(4, '0')
}

/** concat 清单条目：单引号包裹 + 反斜杠换正斜杠（Windows 路径在 demuxer 里的安全写法） */
function listEntry(path: string): string {
  return `file '${path.replace(/\\/g, '/')}'`
}

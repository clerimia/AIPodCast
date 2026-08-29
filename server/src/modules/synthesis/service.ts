// 合成服务（M4 只落单行部分；整集异步编排/任务表 M5 再加）。
// synthesizeLine 是 preview 与批量共用的单行合成入口（ADR-0006）：命中素材直接返回，
// 未命中（或 force）走 TTS → 原子落盘 → upsert audio_assets。TTS 失败原样抛
// SYNTH_FAILED（路由层透传 {error}，不吞 5xx）。
// deps 注入（mediaRoot/tts）由 app.ts 装配（app.mediaRoot / app.tts），测试换 stub。
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { audioAssets, episodes, scriptLines, speakers } from '../../db/schema.js'
import * as asset from './asset.js'
import type { TtsClient } from './tts.js'
import { wavDurationMs } from './wav.js'

export interface SynthesisDeps {
  mediaRoot: string
  tts: TtsClient
}

/** POST /lines/:lineId/preview 响应的 asset 形状（docs/api-and-dataflow.md） */
export interface LineAssetView {
  id: string
  url: string
  durationMs: number | null
}

export interface SynthesizeLineArgs {
  episodeId: string
  lineId: string
  /** 强制重新生成（ADR-0006：显式重写，绕过命中） */
  force?: boolean
}

/**
 * 单行合成：行不存在/已删/不属于该集 → null（404）。
 * 命中 = 已有 audio_assets 行（改台词/指令已作废的行自然未命中）。
 */
export async function synthesizeLine(
  db: Db,
  deps: SynthesisDeps,
  { episodeId, lineId, force = false }: SynthesizeLineArgs,
): Promise<LineAssetView | null> {
  const [line] = await db
    .select({
      text: scriptLines.text,
      instructions: scriptLines.instructions,
      voice: speakers.voice,
      wsId: episodes.wsId,
    })
    .from(scriptLines)
    .innerJoin(episodes, eq(episodes.id, scriptLines.episodeId))
    .innerJoin(speakers, eq(speakers.id, scriptLines.speakerId))
    .where(
      and(
        eq(scriptLines.id, lineId),
        eq(scriptLines.episodeId, episodeId),
        eq(scriptLines.deleted, false),
      ),
    )
  if (!line) return null

  const url = asset.assetMediaUrl(line.wsId, episodeId, lineId)

  if (!force) {
    const [hit] = await db
      .select({ id: audioAssets.id, durationMs: audioAssets.durationMs })
      .from(audioAssets)
      .where(eq(audioAssets.scriptLineId, lineId))
    if (hit) return { id: hit.id, url, durationMs: hit.durationMs }
  }

  const bytes = await deps.tts.synthesize({
    text: line.text,
    voice: line.voice,
    instructions: line.instructions || undefined,
  })
  await asset.writeAssetFile(deps.mediaRoot, line.wsId, episodeId, lineId, bytes)
  const durationMs = wavDurationMs(bytes)
  const row = await asset.upsertAssetRow(
    db,
    lineId,
    asset.assetRelRef(line.wsId, episodeId, lineId),
    durationMs,
  )
  return { id: row.id, url, durationMs }
}

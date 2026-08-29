// 素材文件与 audio_assets 行（ADR-0006/0008）：路径由 id 推导
// `ws-{wsId}/ep-{episodeId}/assets/{lineId}.wav`，DB 只存相对 MEDIA_ROOT 的 audio_ref；
// 写文件先临时再 rename（原子，避免播放/读取读到半截）；行 upsert 冲突 script_line_id 唯一键。
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Db } from '../../db/client.js'
import { audioAssets } from '../../db/schema.js'

/** audio_ref：相对 MEDIA_ROOT 的素材路径（DB 存这个） */
export function assetRelRef(wsId: string, episodeId: string, lineId: string): string {
  return `ws-${wsId}/ep-${episodeId}/assets/${lineId}.wav`
}

/** 试听/播放用的媒体 URL（GET /api/media 流式，支持 Range） */
export function assetMediaUrl(wsId: string, episodeId: string, lineId: string): string {
  return `/api/media/${wsId}/${episodeId}/assets/${lineId}`
}

/** 原子写素材文件：临时文件（同目录，跨盘 rename 不原子）→ rename 覆盖目标 */
export async function writeAssetFile(
  mediaRoot: string,
  wsId: string,
  episodeId: string,
  lineId: string,
  bytes: Buffer,
): Promise<string> {
  const target = join(mediaRoot, assetRelRef(wsId, episodeId, lineId))
  const tmp = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(tmp, bytes)
  await rename(tmp, target)
  return target
}

/** 回填素材行：每行 0..1 份（UNIQUE），重合成 = 覆盖 audio_ref/durationMs */
export async function upsertAssetRow(
  db: Db,
  lineId: string,
  audioRef: string,
  durationMs: number | null,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(audioAssets)
    .values({ scriptLineId: lineId, audioRef, durationMs })
    .onConflictDoUpdate({
      target: audioAssets.scriptLineId,
      set: { audioRef, durationMs },
    })
    .returning({ id: audioAssets.id })
  if (!row) throw new Error('audio_assets upsert returned no row')
  return row
}

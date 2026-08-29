// 产物视图（M5）：GET /episodes/:id/artifact 响应与 synthesis-jobs 快照里的 artifact 字段同形。
// transcript/notes 是合成时的快照文件（ADR-0008）：读 MEDIA_ROOT 文件，不回 DB 按行查；
// 文件读不到（外部删除）时相应字段退化，不抛错。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { artifacts, episodes } from '../../db/schema.js'
import type { TranscriptEntry } from '../post/pipeline.js'

export interface ArtifactView {
  id: string
  createdAt: string
  durationMs: number
  size: number
  audioUrl: string
  transcriptUrl: string
  notesUrl: string
  transcript: TranscriptEntry[]
  notes: string | null
}

export async function getArtifactView(
  db: Db,
  mediaRoot: string,
  episodeId: string,
): Promise<ArtifactView | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.episodeId, episodeId))
  if (!row) return null
  const [ep] = await db
    .select({ wsId: episodes.wsId })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
  if (!ep) return null

  const base = `/api/media/${ep.wsId}/${episodeId}/artifacts`
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    durationMs: row.durationMs ?? 0,
    size: row.size ?? 0,
    audioUrl: `${base}/master.mp3`,
    transcriptUrl: `${base}/transcript.json`,
    notesUrl: `${base}/notes.md`,
    transcript: await readTranscript(mediaRoot, row.transcriptRef),
    notes: await readNotes(mediaRoot, row.notesRef),
  }
}

async function readTranscript(mediaRoot: string, ref: string | null): Promise<TranscriptEntry[]> {
  if (!ref) return []
  try {
    const parsed: unknown = JSON.parse(await readFile(join(mediaRoot, ref), 'utf8'))
    return Array.isArray(parsed) ? (parsed as TranscriptEntry[]) : []
  } catch {
    return []
  }
}

async function readNotes(mediaRoot: string, ref: string | null): Promise<string | null> {
  if (!ref) return null
  try {
    const text = await readFile(join(mediaRoot, ref), 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

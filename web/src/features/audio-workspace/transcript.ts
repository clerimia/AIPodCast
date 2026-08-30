// transcript 时间轴查找（#29 验证项 2）：纯函数，MasterPlayer 的 timeupdate（~4Hz）
// 每次调用用二分代替线性 find——40 行集虽小，长单集（百行级）seek 高亮不再线性扫。
// 时间轴由后处理管线确定性回填（startMs 升序、区间不重叠），行间 gap 无高亮。
import type { TranscriptEntry } from '@/lib/api/types'

/** ms 所在条目：startMs ≤ ms < endMs 命中；落在行间 gap（或轴外）→ null */
export function transcriptEntryAt(entries: TranscriptEntry[], ms: number): TranscriptEntry | null {
  let lo = 0
  let hi = entries.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const entry = entries[mid]!
    if (ms < entry.startMs) hi = mid - 1
    else if (ms >= entry.endMs) lo = mid + 1
    else return entry
  }
  return null
}

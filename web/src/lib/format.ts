// 展示层格式化：时长与字节。三处消费（行内联播放器、产物头部、文稿时间轴），
// 抽出来避免同一个 mm:ss 写三遍且各写各的。

/** 毫秒 → "1:23"；不足一小时不显示小时位（播客单集基本都在一小时内的场景够用） */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 字节 → "3.4 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

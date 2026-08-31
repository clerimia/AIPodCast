// markdown 感知切块（纯函数，可单测）：标题边界分节、节内按段落累积到
// ~target 出块、超长段硬切并带重叠；每块记录标题路径（「第三章 > 3.1 背景」）。
export interface ChunkSpec {
  /** 资源内顺序，从 0 起 */
  seq: number
  /** 标题路径；无标题文档为空串 */
  heading: string
  content: string
}

export interface ChunkOptions {
  targetChars?: number
  overlapChars?: number
}

interface Section {
  heading: string
  paragraphs: string[]
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): ChunkSpec[] {
  const target = opts.targetChars ?? 400
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? 50, target - 1))

  // 1) 按标题分节，节内按空行分段落
  const sections: Section[] = []
  const headingStack: { level: number; text: string }[] = []
  let current: Section | null = null
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0 && current) current.paragraphs.push(paragraph.join('\n'))
    paragraph = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (m) {
      flushParagraph()
      const level = m[1]!.length
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, text: m[2]!.trim() })
      current = { heading: headingStack.map((h) => h.text).join(' > '), paragraphs: [] }
      sections.push(current)
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    if (!current) {
      current = { heading: '', paragraphs: [] }
      sections.push(current)
    }
    paragraph.push(line)
  }
  flushParagraph()

  // 2) 节内累积出块：超 target 即出；超长段硬切（相邻块带重叠）
  const chunks: ChunkSpec[] = []
  for (const section of sections) {
    let buf = ''
    const flush = (keepOverlap: boolean) => {
      const text = buf.trim()
      if (text !== '') chunks.push({ seq: chunks.length, heading: section.heading, content: text })
      buf = keepOverlap ? buf.slice(-overlap) : ''
    }
    for (const para of section.paragraphs) {
      let rest = para
      while (rest.length > target) {
        if (buf.trim() !== '') flush(true)
        chunks.push({ seq: chunks.length, heading: section.heading, content: rest.slice(0, target) })
        rest = rest.slice(target - overlap)
      }
      if (buf.trim() !== '' && buf.length + 1 + rest.length > target) flush(true)
      buf = buf.trim() !== '' ? `${buf}\n${rest}` : rest
    }
    flush(false)
  }
  return chunks
}

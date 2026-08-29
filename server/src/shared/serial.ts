// 行号 serial（docs/api-and-dataflow.md「通用约定」）：L001…，既是序列号也是顺序。
// 插入/重排后按最终顺序整段重编；web 侧 applyOps 另有一份同格式的实现（shared 包本期不抽）。

const SERIAL_RE = /^L(\d{3,})$/

export function formatSerial(n: number): string {
  return `L${String(n).padStart(3, '0')}`
}

/** 非法/缺省 serial 视作 0（排序垫底，下次重编自然归位） */
export function parseSerial(serial: string): number {
  const m = SERIAL_RE.exec(serial)
  return m ? Number.parseInt(m[1]!, 10) : 0
}

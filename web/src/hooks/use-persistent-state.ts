import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// localStorage 持久化的 useState：用于侧栏宽度、面板开合这类「下次进来还该是这样」的
// 界面偏好。读写都吞异常（隐私模式 / 配额满时降级为仅本次会话生效）。
export function usePersistentState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // 存不进就只影响下次进入，不阻断当前交互
    }
  }, [key, value])

  return [value, setValue]
}

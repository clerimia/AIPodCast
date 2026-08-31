// 薄 fetch 封装：JSON 进出、统一错误形状 → ApiError(code, message)（#19「通用约定」）
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** 非 2xx → 解析统一错误形状并抛 ApiError（upload 与 request 共用） */
async function throwApiError(res: Response): Promise<never> {
  let code = String(res.status)
  let message = res.statusText
  try {
    const payload = (await res.json()) as { error?: { code?: string; message?: string } }
    if (payload.error) {
      code = payload.error.code ?? code
      message = payload.error.message ?? message
    }
  } catch {
    // 错误体不是 JSON，保持默认
  }
  throw new ApiError(code, message, res.status)
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  })

  if (!res.ok) {
    await throwApiError(res)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PUT', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'DELETE', signal }),
  /** multipart 上传：浏览器生成 boundary，不能手设 Content-Type */
  upload: async <T>(path: string, formData: FormData, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`/api${path}`, { method: 'POST', body: formData, signal })
    if (!res.ok) await throwApiError(res)
    return (await res.json()) as T
  },
}

/** toast/错误页统一文案来源 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

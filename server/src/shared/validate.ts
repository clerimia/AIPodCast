import { AppError } from './errors.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** 路径参数必须是合法 uuid；非法值视作资源不存在（不可能命中任何行） */
export function requireUuidParam(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new AppError('NOT_FOUND', `${label} not found`, 404)
  }
  return value
}

/** 请求体必须是 JSON 对象 */
export function asBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  throw new AppError('BAD_REQUEST', 'request body must be a JSON object', 400)
}

/** 必填非空字符串（去首尾空白） */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('BAD_REQUEST', `field '${field}' must be a non-empty string`, 400)
  }
  return value.trim()
}

/** 可选字符串；undefined = 不改，非字符串 = 400 */
export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new AppError('BAD_REQUEST', `field '${field}' must be a string`, 400)
  }
  return value
}

/** 请求体字段必须是合法 uuid */
export function requireUuidField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new AppError('BAD_REQUEST', `field '${field}' must be a uuid`, 400)
  }
  return value
}

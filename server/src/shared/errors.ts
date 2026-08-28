// 统一错误形状（docs/api-and-dataflow.md「通用约定」）：{ "error": { "code", "message" } }
export interface ErrorPayload {
  error: { code: string; message: string }
}

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export type OngoingErrorKind = "retryable" | "terminal"

export function classifyHttpStatus(status: number): OngoingErrorKind {
  if (status === 429 || status >= 500) {
    return "retryable"
  }
  return "terminal"
}

export class OngoingApiError extends Error {
  status?: number
  kind: OngoingErrorKind
  retryAfterMs?: number
  body?: unknown

  constructor(
    message: string,
    opts: { status?: number; kind: OngoingErrorKind; retryAfterMs?: number; body?: unknown }
  ) {
    super(message)
    this.name = "OngoingApiError"
    this.status = opts.status
    this.kind = opts.kind
    this.retryAfterMs = opts.retryAfterMs
    this.body = opts.body
  }
}

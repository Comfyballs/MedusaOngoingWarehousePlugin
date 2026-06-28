export type OngoingErrorKind = "retryable" | "terminal"

export function classifyHttpStatus(status: number): OngoingErrorKind {
  if (status === 429 || status >= 500) {
    return "retryable"
  }
  return "terminal"
}

// Classify any thrown value for retry/dead-letter routing. An OngoingApiError carries
// its own kind (terminal for 4xx/validation, retryable for 429/5xx). Anything else is a
// raw/unknown failure — most importantly a network error (ECONNRESET / timeout / DNS / a
// fetch TypeError) — which is transient by nature and must be retried, NOT dead-lettered
// as terminal. See #67.
export function classifyError(err: unknown): OngoingErrorKind {
  return err instanceof OngoingApiError ? err.kind : "retryable"
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

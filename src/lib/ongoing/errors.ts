export type OngoingErrorKind = "retryable" | "terminal"

// Machine-readable sub-classification for a terminal OngoingApiError, for callers/logs
// that need to distinguish WHY beyond the coarse kind. "unexpected_body_shape": doFetch
// received a 2xx response whose Content-Type wasn't application/json, or whose body
// wasn't valid JSON — never cast an unvalidated body to the caller's generic T (#107).
export type OngoingApiErrorReason = "unexpected_body_shape"

export function classifyHttpStatus(status: number): OngoingErrorKind {
  // 408 Request Timeout: some gateways/WAFs emit it on slow client writes; it is
  // transient like 429/5xx, so retry rather than dead-letter (bead gbl).
  if (status === 408 || status === 429 || status >= 500) {
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
  reason?: OngoingApiErrorReason

  constructor(
    message: string,
    opts: {
      status?: number
      kind: OngoingErrorKind
      retryAfterMs?: number
      body?: unknown
      reason?: OngoingApiErrorReason
    }
  ) {
    super(message)
    this.name = "OngoingApiError"
    this.status = opts.status
    this.kind = opts.kind
    this.retryAfterMs = opts.retryAfterMs
    this.body = opts.body
    this.reason = opts.reason
  }
}

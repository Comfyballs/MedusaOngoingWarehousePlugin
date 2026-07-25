/**
 * Maximum number of workflow-level sync re-invocations before a retryable failure is
 * dead-lettered. This is the ceiling on `OngoingOrderSync.retry_count`.
 *
 * NOTE: this is NOT `OngoingClient.maxRetries` (client.ts, default 3), which governs
 * per-HTTP-call transient retries *inside a single sync invocation*. MAX_SYNC_RETRIES
 * counts separate driver passes (workflow-level re-invocations) across the row's
 * lifetime. Different layers — do not conflate them.
 */
export const MAX_SYNC_RETRIES = 5

/**
 * Plain-data input describing a sync row that just failed again. `error_class` mirrors
 * the nullable `OngoingOrderSync.error_class` enum column (`"retryable" | "terminal"`);
 * `null` is treated as retryable (matching `classifyError`'s default).
 */
export type RetryPolicyInput = {
  retry_count: number
  error_class: "retryable" | "terminal" | null
}

/**
 * Plain-data decision returned by {@link resolveRetryOutcome}. Persist `retry_count` and
 * `error_class` via `updateOngoingOrderSyncs`; `dead_lettered` tells the driver whether to
 * stop retrying.
 */
export type RetryOutcome = {
  retry_count: number
  error_class: "retryable" | "terminal"
  dead_lettered: boolean
}

/**
 * Decide whether a just-failed sync row should be retried again or dead-lettered.
 *
 * Pure: takes plain data and returns plain data — no DB, no container, no MedusaService.
 * Call it for a row that **just failed again**, *before* re-invoking the sync.
 *
 * Semantics:
 * - Already `"terminal"`: a deterministic failure that should not be retried at all.
 *   Returns the count unchanged with `dead_lettered: true` (no attempt is spent on it).
 * - `"retryable"` or `null` (null treated as retryable): increments the count by 1.
 *   - If `newCount >= maxRetries`, the cap is reached — flip `error_class` to `"terminal"`
 *     with `dead_lettered: true`. The flip to `"terminal"` is the dead-letter signal: the
 *     retry driver's `sync_state = "error" AND error_class = "retryable"` query then
 *     naturally excludes the row, with zero schema change.
 *   - Else, stay `"retryable"` with `dead_lettered: false`.
 *
 * Uses `>=` so any out-of-range stored count (e.g. already `>= maxRetries`) also
 * dead-letters rather than looping forever.
 *
 * Consumption contract for #39/#112 (`retryFailedSyncs`):
 * 1. Query rows with `sync_state = "error" AND error_class = "retryable"`.
 * 2. For each, before re-invoking, call
 *    `resolveRetryOutcome({ retry_count: row.retry_count, error_class: row.error_class })`.
 * 3. Persist the outcome via the CAS-guarded
 *    `attemptRetrySyncTransition({ id, expected_retry_count: row.retry_count, retry_count:
 *    outcome.retry_count, last_synced_at, error_class: outcome.dead_lettered ? "terminal" :
 *    undefined })` (`src/modules/ongoing/service.ts`) instead of the plain, unguarded
 *    `updateOngoingOrderSyncs` — this prevents two overlapping ticks from double-incrementing
 *    the same row's `retry_count` (#112).
 * 4. If the guarded write returns `false` ("CAS lost" — another tick already processed this
 *    row), skip it: do not re-invoke, do not emit an event.
 * 5. Else if `outcome.dead_lettered`: do NOT re-invoke.
 * 6. Else: re-invoke the sync.
 *
 * @param input      The current `retry_count` and `error_class` of the failed row.
 * @param maxRetries Ceiling on workflow-level re-invocations. Defaults to {@link MAX_SYNC_RETRIES}.
 * @returns The next `retry_count`, the resolved `error_class`, and whether the row is dead-lettered.
 */
export function resolveRetryOutcome(
  input: RetryPolicyInput,
  maxRetries = MAX_SYNC_RETRIES
): RetryOutcome {
  if (input.error_class === "terminal") {
    return {
      retry_count: input.retry_count,
      error_class: "terminal",
      dead_lettered: true,
    }
  }

  const newCount = input.retry_count + 1

  if (newCount >= maxRetries) {
    return {
      retry_count: newCount,
      error_class: "terminal",
      dead_lettered: true,
    }
  }

  return {
    retry_count: newCount,
    error_class: "retryable",
    dead_lettered: false,
  }
}

/**
 * Compute the exponential backoff delay (in ms) before a failed sync row is eligible
 * for re-invocation. The due-check in `retryFailedSyncsJob` is:
 *   `(Date.now() - new Date(row.last_synced_at).getTime()) >= computeRetryBackoffMs(row.retry_count)`
 *
 * Defaults: BASE=300_000 ms (5 min), factor=2, CAP=3_600_000 ms (60 min).
 * Resulting delays for retries 0..4: 5 / 10 / 20 / 40 / 60 min.
 *
 * This is the LEDGER-layer backoff (cron re-sweep of a failed OngoingOrderSync row over
 * minutes/hours). It is a DIFFERENT layer from the transport-layer retry in client.ts
 * (250ms base, a few quick in-request retries for a transient network blip) — don't
 * conflate the two time scales when tuning (bead 8jj).
 *
 * The optional `opts` parameter allows overriding base/cap in unit tests.
 */
export const BASE_RETRY_BACKOFF_MS = 300_000
export const MAX_RETRY_BACKOFF_MS = 3_600_000

export function computeRetryBackoffMs(
  retryCount: number,
  opts: { baseMs?: number; capMs?: number } = {}
): number {
  const base = opts.baseMs ?? BASE_RETRY_BACKOFF_MS
  const cap = opts.capMs ?? MAX_RETRY_BACKOFF_MS
  return Math.min(cap, base * 2 ** retryCount)
}

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { pushOrderToOngoing } from "../workflows"
import {
  resolveRetryOutcome,
  computeRetryBackoffMs,
} from "../lib/ongoing/retry-policy"

// Shape of an OngoingOrderSync row in the error/retryable state.
// Fields are the subset we read or write — matches OngoingOrderSync model
// (src/modules/ongoing/models/order-sync.ts).
type ErrorSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  last_synced_at: Date | string | null
  retry_count: number
  error_class: "retryable" | "terminal" | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: string
    error_class: string
  }) => Promise<ErrorSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    retry_count: number
    last_synced_at?: Date
    error_class?: "terminal"
  }) => Promise<unknown>
}

type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug?: (msg: string) => void
}

/**
 * Returns true when the exponential backoff window for this row has elapsed.
 * null last_synced_at is treated as epoch 0 (always due).
 */
function isRetryDue(row: ErrorSyncRow, now: number): boolean {
  const lastMs =
    row.last_synced_at != null ? new Date(row.last_synced_at).getTime() : 0
  return now - lastMs >= computeRetryBackoffMs(row.retry_count)
}

/**
 * Process a single due error row: dead-letter or increment retry_count + re-invoke.
 * Throws on hard failure — callers wrap each row in try/catch.
 */
async function processRow(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  row: ErrorSyncRow
): Promise<void> {
  if (row.medusa_fulfillment_id == null) {
    logger.warn(
      `[ongoing] retry: row ${row.id} has no medusa_fulfillment_id — skipping (not dead-lettering)`
    )
    return
  }

  const outcome = resolveRetryOutcome({
    retry_count: row.retry_count,
    error_class: row.error_class,
  })

  if (outcome.dead_lettered) {
    await service.updateOngoingOrderSyncs({
      id: row.id,
      retry_count: outcome.retry_count,
      error_class: "terminal",
    })
    logger.info(
      `[ongoing] retry: dead-lettered row ${row.id} after ${outcome.retry_count} attempts`
    )
    return
  }

  // Persist the incremented count AND stamp last_synced_at BEFORE re-invoking.
  //
  // Two crash-safety properties:
  // 1. Count must not regress: persisting before re-invocation means a crash
  //    mid-flight leaves the count incremented (safe to lose one re-invocation).
  // 2. Backoff anchor must advance regardless of workflow outcome: if an early
  //    workflow step throws before recordSync runs, recordSync never stamps
  //    last_synced_at — the row would appear "due" again on the very next tick
  //    and re-fire every minute until dead-lettered, bypassing all exponential
  //    spacing. Stamping here ensures every attempt advances the anchor, so the
  //    full backoff window (5/10/20/40/60 min) is always honoured.
  //
  //    If the workflow succeeds, recordSync may overwrite last_synced_at with a
  //    slightly later timestamp — that is harmless, as a successful run transitions
  //    the row out of error/retryable state entirely.
  await service.updateOngoingOrderSyncs({
    id: row.id,
    retry_count: outcome.retry_count,
    last_synced_at: new Date(),
  })

  await pushOrderToOngoing(container).run({
    input: { fulfillment_id: row.medusa_fulfillment_id },
  })

  logger.info(
    `[ongoing] retry: re-invoked push for row ${row.id} (attempt ${outcome.retry_count})`
  )
}

export default async function retryFailedSyncsJob(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let rows: ErrorSyncRow[]
  try {
    rows = await service.listOngoingOrderSyncs({
      sync_state: "error",
      error_class: "retryable",
    })
  } catch (error) {
    logger.error(
      `[ongoing] retry: failed to list error rows: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()

  for (const row of rows) {
    if (!isRetryDue(row, now)) {
      continue
    }

    try {
      await processRow(container, service, logger, row)
    } catch (error) {
      logger.error(
        `[ongoing] retry: row ${row.id} (ful=${row.medusa_fulfillment_id ?? "null"}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one row's failure must not abort the sweep.
    }
  }
}

export const config = {
  name: "ongoing-retry-failed-syncs",
  schedule: "* * * * *",
}

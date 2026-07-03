import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { pushOrderToOngoing } from "../workflows"
import {
  resolveRetryOutcome,
  computeRetryBackoffMs,
} from "../lib/ongoing/retry-policy"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
import type {
  OrderRetriedPayload,
  OrderDeadLetteredPayload,
} from "../lib/ongoing/events"

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
  attemptRetrySyncTransition: (input: {
    id: string
    expected_retry_count: number
    retry_count: number
    last_synced_at: Date
    error_class?: "terminal"
  }) => Promise<boolean>
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
  const eventBus = (container as any).resolve(Modules.EVENT_BUS)

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

  // Guarded write: only succeeds if `id` still has `sync_state = "error" AND
  // retry_count = row.retry_count` — i.e. nothing else has touched this row
  // since it was listed at the top of the sweep. This closes the residual
  // race from #39: two overlapping ticks (multi-instance deployment, or a
  // slow prior tick still in flight past the next minute boundary) can both
  // list the same due row, but only one of them can win this guarded update.
  const won = await service.attemptRetrySyncTransition({
    id: row.id,
    expected_retry_count: row.retry_count,
    retry_count: outcome.retry_count,
    last_synced_at: new Date(),
    ...(outcome.dead_lettered ? { error_class: "terminal" as const } : {}),
  })

  if (!won) {
    // CAS lost: another tick already advanced this row's retry_count (or the
    // row left `sync_state = "error"` between listing and this call, e.g. a
    // concurrent cancellation). Skipping is correct — the tick/actor that won
    // already persisted the outcome and, for the re-invoke branch, already
    // re-triggered `pushOrderToOngoing`. Re-processing here would double the
    // retry_count and double the Ongoing API calls, which is exactly the bug
    // this guard exists to prevent. Logged at info (not warn/error): this is
    // an expected outcome under multi-instance overlap, not a failure.
    logger.info(
      `[ongoing] retry: row ${row.id} lost the retry_count CAS guard (expected retry_count=${row.retry_count}, sync_state="error") — another tick already processed it; skipping`
    )
    return
  }

  if (outcome.dead_lettered) {
    logger.info(
      `[ongoing] retry: dead-lettered row ${row.id} after ${outcome.retry_count} attempts`
    )
    // Best-effort emit: the dead-letter write above already committed — an
    // event-bus outage here must not surface as a "row failed" log for a row
    // that was actually processed successfully.
    try {
      await eventBus.emit({
        name: ONGOING_EVENTS.ORDER_DEAD_LETTERED,
        data: {
          ongoing_order_sync_id: row.id,
          medusa_fulfillment_id: row.medusa_fulfillment_id,
          retry_count: outcome.retry_count,
        } satisfies OrderDeadLetteredPayload,
      })
    } catch (emitErr) {
      logger.error(
        `[ongoing] retry: failed to emit ${ONGOING_EVENTS.ORDER_DEAD_LETTERED} for row ${row.id}: ${(emitErr as Error).message}`
      )
    }
    return
  }

  await pushOrderToOngoing(container).run({
    input: { fulfillment_id: row.medusa_fulfillment_id },
  })

  logger.info(
    `[ongoing] retry: re-invoked push for row ${row.id} (attempt ${outcome.retry_count})`
  )
  // Best-effort emit: the re-invocation above already ran to completion — an
  // event-bus outage here must not surface as a "row failed" log for a row
  // that was actually processed successfully.
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.ORDER_RETRIED,
      data: {
        ongoing_order_sync_id: row.id,
        medusa_fulfillment_id: row.medusa_fulfillment_id,
        retry_count: outcome.retry_count,
      } satisfies OrderRetriedPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] retry: failed to emit ${ONGOING_EVENTS.ORDER_RETRIED} for row ${row.id}: ${(emitErr as Error).message}`
    )
  }
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

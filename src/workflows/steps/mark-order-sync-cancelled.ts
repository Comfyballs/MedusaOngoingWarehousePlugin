import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer, Logger } from "@medusajs/framework/types"
import { classifyError } from "../../lib/ongoing/errors"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type MarkCancelledInput = {
  orderSyncId: string
}

export const markOrderSyncCancelledHandler = async (
  input: MarkCancelledInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<{ orderSyncId: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  try {
    await ongoing.updateOngoingOrderSyncs({
      id: input.orderSyncId,
      sync_state: "cancelled",
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
      // A successful cancel supersedes any prior refusal (eer) — clear the flag.
      cancel_refused_at: null,
      cancel_refused_reason: null,
    })
  } catch (err) {
    // 98q: client.cancelOrder already succeeded (the Ongoing order was cancelled/
    // deleted) but this ledger write failed. Without this, the row stays at its
    // pre-cancel sync_state (e.g. "sent") forever — retry-failed-syncs never sweeps
    // it and, unlike the shipment path, no webhook/poll re-invokes cancel. Flip it to
    // error/retryable (mirroring push-order-record-sync.ts) so the retry pipeline picks
    // it up: the re-push it triggers hits the x5n canceled_at guard in
    // push-order-record-sync (the order/fulfillment is canceled), which aborts before
    // putOrder and records "cancelled" — converging the ledger to the true state
    // without re-creating a live Ongoing order. Best-effort: if this write also fails,
    // the original error still propagates.
    const errorClass = classifyError(err)
    const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    try {
      await ongoing.updateOngoingOrderSyncs({
        id: input.orderSyncId,
        sync_state: "error",
        error_class: errorClass,
        last_error: (err as Error).message,
        last_synced_at: new Date(),
      })
    } catch (writeErr) {
      logger.error(
        `[ongoing] mark-order-sync-cancelled: failed to record error state for order_sync_id=${input.orderSyncId} after cancel-ledger write failure: ${(writeErr as Error).message}`
      )
    }
    logger.error(
      `[ongoing] mark-order-sync-cancelled: ledger write failed after successful Ongoing cancel for order_sync_id=${input.orderSyncId} error_class=${errorClass} error=${(err as Error).message}`
    )
    throw err
  }

  return new StepResponse({ orderSyncId: input.orderSyncId })
}

export const markOrderSyncCancelledStep = createStep(
  "mark-order-sync-cancelled",
  markOrderSyncCancelledHandler
)

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer, Logger } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type MarkCancelRefusedInput = {
  order_sync_id: string
  reason?: string
}

/**
 * ei4 fallout (eer): record that Ongoing declined a cancel (status not in
 * cancellable_status_codes) while Medusa already committed its own fulfillment
 * cancel. This surfaces the divergence in the order widget so an operator can
 * reconcile it in Ongoing — the async cancel path can no longer veto the Medusa
 * cancel, so a visible flag is the reconciliation hook. Cleared by the
 * mark-order-sync-cancelled step on the next successful cancel.
 */
export const markOrderSyncCancelRefusedHandler = async (
  input: MarkCancelRefusedInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  try {
    await ongoing.updateOngoingOrderSyncs({
      id: input.order_sync_id,
      cancel_refused_at: new Date(),
      cancel_refused_reason: input.reason ?? null,
    })
  } catch (err) {
    // 98q: unlike the successful-cancel path (mark-order-sync-cancelled), a refused
    // row is deliberately NOT routed into the error/retryable retry pipeline. Ongoing
    // REFUSED the cancel, so its order is still live at a non-cancellable status while
    // the Medusa order is canceled (canceled_at set). The generic retry pipeline only
    // re-pushes, and that re-push would hit the x5n canceled_at guard and record the
    // row "cancelled" — falsely reporting the Ongoing order as cancelled and erasing
    // the operator-facing divergence this step exists to surface. Leaving sync_state
    // at its pre-refusal value (e.g. "sent") is strictly more accurate. Log loudly and
    // rethrow so the failure is visible.
    const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    logger.error(
      `[ongoing] mark-order-sync-cancel-refused: failed to record refusal flag for order_sync_id=${input.order_sync_id}; row left at its prior sync_state (NOT flipped to error/retryable — see 98q). error=${(err as Error).message}`
    )
    throw err
  }

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncCancelRefusedStep = createStep(
  "mark-order-sync-cancel-refused",
  markOrderSyncCancelRefusedHandler
)

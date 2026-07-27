import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
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

  await ongoing.updateOngoingOrderSyncs({
    id: input.order_sync_id,
    cancel_refused_at: new Date(),
    cancel_refused_reason: input.reason ?? null,
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncCancelRefusedStep = createStep(
  "mark-order-sync-cancel-refused",
  markOrderSyncCancelRefusedHandler
)

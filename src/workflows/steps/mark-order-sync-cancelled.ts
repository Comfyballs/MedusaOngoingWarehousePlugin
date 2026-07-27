import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
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

  return new StepResponse({ orderSyncId: input.orderSyncId })
}

export const markOrderSyncCancelledStep = createStep(
  "mark-order-sync-cancelled",
  markOrderSyncCancelledHandler
)

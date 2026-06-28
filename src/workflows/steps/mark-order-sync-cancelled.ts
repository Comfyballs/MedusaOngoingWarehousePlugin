import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export type MarkCancelledInput = {
  orderSyncId: string
}

export const markOrderSyncCancelledHandler = async (
  input: MarkCancelledInput,
  { container }: { container: any }
): Promise<StepResponse<{ orderSyncId: string }>> => {
  const ongoing = container.resolve("ongoing") as any

  await ongoing.updateOngoingOrderSyncs({
    id: input.orderSyncId,
    sync_state: "cancelled",
    error_class: null,
    last_error: null,
    last_synced_at: new Date(),
  })

  return new StepResponse({ orderSyncId: input.orderSyncId })
}

export const markOrderSyncCancelledStep = createStep(
  "mark-order-sync-cancelled",
  markOrderSyncCancelledHandler
)

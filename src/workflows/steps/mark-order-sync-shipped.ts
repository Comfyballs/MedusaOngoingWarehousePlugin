import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type MarkShippedInput = {
  order_sync_id: string
  status_code: number
  status_text: string
}

export const markOrderSyncShippedHandler = async (
  input: MarkShippedInput,
  { container }: { container: any }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any

  await ongoing.updateOngoingOrderSyncs({
    id: input.order_sync_id,
    sync_state: "shipped",
    shipped_at: new Date(),
    latest_status_code: input.status_code,
    latest_status_text: input.status_text,
    error_class: null,
    last_error: null,
    last_synced_at: new Date(),
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncShippedStep = createStep(
  "mark-order-sync-shipped",
  markOrderSyncShippedHandler
)

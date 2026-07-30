import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type MarkOrderSyncDoneInput = {
  order_sync_id: string
}

// Stamp done_synced_at so the status poll stops re-syncing an order Ongoing is
// finished with (status code above the done threshold — bead 8rg). The poll calls
// this only after the refresh and any shipment/delivery sync for that tick have
// succeeded, so a half-applied tick is retried rather than frozen.
export const markOrderSyncDoneHandler = async (
  input: MarkOrderSyncDoneInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  await ongoing.updateOngoingOrderSyncs({
    id: input.order_sync_id,
    done_synced_at: new Date(),
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncDoneStep = createStep(
  "mark-order-sync-done",
  markOrderSyncDoneHandler
)

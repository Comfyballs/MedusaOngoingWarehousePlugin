import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { OrderEditCategory } from "./gate-order-edit"

export type MarkEditBlockedInput = {
  order_sync_id: string
  blocked: boolean
  category?: OrderEditCategory
  reason?: string
}

export const markOrderSyncEditBlockedHandler = async (
  input: MarkEditBlockedInput,
  { container }: { container: any }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any

  await ongoing.updateOngoingOrderSyncs({
    id: input.order_sync_id,
    edit_blocked_at: input.blocked ? new Date() : null,
    edit_blocked_category: input.blocked ? (input.category ?? null) : null,
    edit_blocked_reason: input.blocked ? (input.reason ?? null) : null,
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncEditBlockedStep = createStep(
  "mark-order-sync-edit-blocked",
  markOrderSyncEditBlockedHandler
)

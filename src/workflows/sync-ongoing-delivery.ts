import {
  createWorkflow,
  WorkflowResponse,
  transform,
  when,
} from "@medusajs/framework/workflows-sdk"
import {
  loadSyncForDeliveryStep,
  type DeliveryDecision,
} from "./steps/load-sync-for-delivery"
import { applyOrderShipmentStep } from "./steps/apply-order-shipment"
import { markOrderSyncShippedStep } from "./steps/mark-order-sync-shipped"
import { markOrderSyncDeliveredStep } from "./steps/mark-order-sync-delivered"

// Shared input contract — the poll job and the webhook delivery dispatcher both
// call this workflow with EXACTLY this shape (identical to SyncOngoingShipmentInput
// so the same webhook payload mapper feeds both seams).
export type SyncOngoingDeliveryInput = {
  ongoing_order_number: string
  status_code: number
  status_text: string
  tracking_numbers: string[]
  tracking?: Array<{ number: string; url?: string }>
}

// Records a pickup order's collection at the pickup point (Ongoing status 500 /
// stage "delivered"). The normal path is 450 (shipped, Medusa shipment already
// created) -> 500 (delivered). If we reach 500 without ever having seen a shipped
// code (missed poll interval), the first when() backfills the Medusa shipment so
// the fulfillment is never left un-shipped; then delivery is recorded regardless.
// Idempotency lives in loadSyncForDeliveryStep (already_delivered -> skip).
export const syncOngoingDeliveryWorkflow = createWorkflow(
  "sync-ongoing-delivery",
  function (input: SyncOngoingDeliveryInput) {
    const decision = loadSyncForDeliveryStep(
      transform({ input }, (data) => ({
        ongoing_order_number: data.input.ongoing_order_number,
      }))
    )

    // Backfill: reached "delivered" but never recorded a shipment. Create it, then
    // mark the row shipped so shipped_at is set before we stamp delivered_at.
    when(
      "delivery-needs-shipment-backfill",
      decision,
      (d: DeliveryDecision) => !d.skip && d.needs_shipment
    ).then(() => {
      const applyInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        medusa_order_id: data.decision.medusa_order_id as string,
        medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
        tracking_numbers: data.input.tracking_numbers,
        tracking: data.input.tracking,
      }))

      applyOrderShipmentStep(applyInput)

      const markShippedInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        status_code: data.input.status_code,
        status_text: data.input.status_text,
        medusa_order_id: data.decision.medusa_order_id as string,
        medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
        ongoing_order_number: data.input.ongoing_order_number,
        tracking_numbers: data.input.tracking_numbers,
      }))

      markOrderSyncShippedStep(markShippedInput)
    })

    // Record the delivery for every non-skipped row (whether just backfilled above
    // or already shipped on a prior 450).
    when("delivery-not-skipped", decision, (d: DeliveryDecision) => !d.skip).then(() => {
      const markDeliveredInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        status_code: data.input.status_code,
        status_text: data.input.status_text,
        medusa_order_id: data.decision.medusa_order_id as string,
        ongoing_order_number: data.input.ongoing_order_number,
      }))

      markOrderSyncDeliveredStep(markDeliveredInput)
    })

    return new WorkflowResponse(decision)
  }
)

export default syncOngoingDeliveryWorkflow
export type { DeliveryDecision } from "./steps/load-sync-for-delivery"

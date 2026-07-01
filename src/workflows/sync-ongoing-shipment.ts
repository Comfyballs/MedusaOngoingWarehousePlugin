import {
  createWorkflow,
  WorkflowResponse,
  transform,
  when,
} from "@medusajs/framework/workflows-sdk"
import {
  loadSyncForShipmentStep,
  type ShipmentDecision,
} from "./steps/load-sync-for-shipment"
import { applyOrderShipmentStep } from "./steps/apply-order-shipment"
import { markOrderSyncShippedStep } from "./steps/mark-order-sync-shipped"

// Shared input contract — the poll job (#34) and the webhook wiring (#36) both call
// this workflow with EXACTLY this shape. Keep it byte-identical across those issues.
export type SyncOngoingShipmentInput = {
  ongoing_order_number: string
  status_code: number
  status_text: string
  tracking_numbers: string[]
}

export const syncOngoingShipmentWorkflow = createWorkflow(
  "sync-ongoing-shipment",
  function (input: SyncOngoingShipmentInput) {
    const decision = loadSyncForShipmentStep(
      transform({ input }, (data) => ({
        ongoing_order_number: data.input.ongoing_order_number,
      }))
    )

    when(decision, (d: ShipmentDecision) => !d.skip).then(() => {
      const applyInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        medusa_order_id: data.decision.medusa_order_id as string,
        medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
        tracking_numbers: data.input.tracking_numbers,
      }))

      applyOrderShipmentStep(applyInput)

      const markInput = transform({ decision, input }, (data) => ({
        order_sync_id: data.decision.order_sync_id as string,
        status_code: data.input.status_code,
        status_text: data.input.status_text,
        medusa_order_id: data.decision.medusa_order_id as string,
        medusa_fulfillment_id: data.decision.medusa_fulfillment_id as string,
        ongoing_order_number: data.input.ongoing_order_number,
        tracking_numbers: data.input.tracking_numbers,
      }))

      markOrderSyncShippedStep(markInput)
    })

    return new WorkflowResponse(decision)
  }
)

export default syncOngoingShipmentWorkflow
export type { ShipmentDecision } from "./steps/load-sync-for-shipment"

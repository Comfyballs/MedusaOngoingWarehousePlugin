import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type LoadSyncForShipmentInput = {
  ongoing_order_number: string
}

export type ShipmentDecisionReason =
  | "ok"
  | "no_sync_row"
  | "already_shipped"
  | "no_fulfillment_id"

export type ShipmentDecision = {
  skip: boolean
  reason: ShipmentDecisionReason
  order_sync_id?: string
  medusa_order_id?: string
  medusa_fulfillment_id?: string
}

export const loadSyncForShipmentHandler = async (
  input: LoadSyncForShipmentInput,
  { container }: { container: any }
): Promise<StepResponse<ShipmentDecision>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any

  const syncs = await ongoing.listOngoingOrderSyncs({
    ongoing_order_number: input.ongoing_order_number,
  })
  const sync = syncs?.[0]

  if (!sync) {
    return new StepResponse({ skip: true, reason: "no_sync_row" })
  }

  if (sync.shipped_at) {
    return new StepResponse({
      skip: true,
      reason: "already_shipped",
      order_sync_id: sync.id,
    })
  }

  if (
    sync.medusa_fulfillment_id === null ||
    sync.medusa_fulfillment_id === undefined
  ) {
    return new StepResponse({
      skip: true,
      reason: "no_fulfillment_id",
      order_sync_id: sync.id,
    })
  }

  return new StepResponse({
    skip: false,
    reason: "ok",
    order_sync_id: sync.id,
    medusa_order_id: sync.medusa_order_id,
    medusa_fulfillment_id: sync.medusa_fulfillment_id,
  })
}

export const loadSyncForShipmentStep = createStep(
  "load-sync-for-shipment",
  loadSyncForShipmentHandler
)

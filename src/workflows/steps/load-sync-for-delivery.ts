import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type LoadSyncForDeliveryInput = {
  ongoing_order_number: string
}

export type DeliveryDecisionReason = "ok" | "no_sync_row" | "already_delivered"

// Decision returned by loadSyncForDeliveryStep and consumed by the delivery
// workflow's when() branches.
//
// `needs_shipment` covers the case where an order reaches "delivered" (500)
// without us ever having observed a "shipped" code (450/451) — a missed poll
// interval or a webhook that skipped straight to pickup. When true (and a
// fulfillment id exists) the workflow backfills the Medusa shipment before
// recording delivery, so the fulfillment is never left un-shipped.
export type DeliveryDecision = {
  skip: boolean
  reason: DeliveryDecisionReason
  needs_shipment: boolean
  order_sync_id?: string
  medusa_order_id?: string
  medusa_fulfillment_id?: string
}

export const loadSyncForDeliveryHandler = async (
  input: LoadSyncForDeliveryInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<DeliveryDecision>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  const syncs = await ongoing.listOngoingOrderSyncs({
    ongoing_order_number: input.ongoing_order_number,
  })
  const sync = syncs?.[0]

  if (!sync) {
    return new StepResponse({ skip: true, reason: "no_sync_row", needs_shipment: false })
  }

  // Idempotency: a repeated 500 (poll re-sees the order, or Ongoing re-delivers
  // the webhook) is a no-op once delivered_at is set.
  if (sync.delivered_at) {
    return new StepResponse({
      skip: true,
      reason: "already_delivered",
      needs_shipment: false,
      order_sync_id: sync.id,
    })
  }

  const hasFulfillment =
    sync.medusa_fulfillment_id !== null && sync.medusa_fulfillment_id !== undefined

  return new StepResponse({
    skip: false,
    reason: "ok",
    // Backfill the shipment only when we never recorded one AND we have a
    // fulfillment to ship. Without a fulfillment id there is nothing to create a
    // Medusa shipment against, so we still record the delivery but skip the
    // shipment step (mirrors loadSyncForShipmentStep's no_fulfillment_id guard).
    needs_shipment: !sync.shipped_at && hasFulfillment,
    order_sync_id: sync.id,
    medusa_order_id: sync.medusa_order_id,
    // Coalesce null -> undefined to match DeliveryDecision (string | undefined).
    medusa_fulfillment_id: sync.medusa_fulfillment_id ?? undefined,
  })
}

export const loadSyncForDeliveryStep = createStep(
  "load-sync-for-delivery",
  loadSyncForDeliveryHandler
)

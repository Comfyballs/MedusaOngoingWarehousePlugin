import type { RecordReturnStatusInput } from "../../../../workflows/steps/record-return-status"

/**
 * The subset of the verified Ongoing webhook payload (WebhookOrderPayload) that
 * return-status detection consumes. Declared structurally, mirroring
 * map-payload-to-shipment-input.ts's WebhookShipmentSource, so this mapper does not
 * depend on the full payload type.
 */
export type WebhookReturnStatusSource = {
  goodsOwnerOrderId?: string
  orderStatus: { number: number; text?: string }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
  parcels?: Array<{ parcelNumber?: string; isReturnParcel?: boolean }>
}

export type ReturnStatusMapResult =
  | {
      hasReturnActivity: true
      input: Omit<RecordReturnStatusInput, "integration_id">
    }
  | { hasReturnActivity: false }

/**
 * Detect return-flagged tracking/parcel entries in a verified Ongoing order-status
 * webhook payload and, if present, derive the input for recordReturnStatusStep.
 *
 * Ongoing's order-status webhook is scoped to the ORIGINAL order (goodsOwnerOrderId)
 * — a return-order-specific identifier (returnOrderNumber) is never present on this
 * payload. Individual tracking/parcel entries instead carry isReturn / isReturnParcel
 * flags. This mapper is deliberately conservative: it only DETECTS return activity
 * and collects the return waybills/parcel numbers for the event payload; it does not
 * attempt to resolve which specific Medusa `return` fulfillment the activity belongs
 * to (the webhook carries no data to disambiguate that when an order has more than
 * one return in flight) — see record-return-status.ts and
 * docs/wiki/Dev-Architecture.md for the full rationale.
 */
export function mapWebhookPayloadToReturnStatusInput(
  payload: WebhookReturnStatusSource
): ReturnStatusMapResult {
  const returnWaybills = (payload.tracking ?? [])
    .filter((entry) => entry.isReturn === true)
    .map((entry) => entry.waybill ?? "")

  const returnParcelNumbers = (payload.parcels ?? [])
    .filter((entry) => entry.isReturnParcel === true)
    .map((entry) => entry.parcelNumber ?? "")

  if (returnWaybills.length === 0 && returnParcelNumbers.length === 0) {
    return { hasReturnActivity: false }
  }

  return {
    hasReturnActivity: true,
    input: {
      ongoing_order_number: payload.goodsOwnerOrderId ?? "",
      status_code: payload.orderStatus.number,
      status_text: payload.orderStatus.text ?? "",
      return_tracking_numbers: returnWaybills,
      return_parcel_numbers: returnParcelNumbers,
    },
  }
}

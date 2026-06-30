import type { SyncOngoingShipmentInput } from "../../../../workflows"

/**
 * The subset of the verified Ongoing webhook payload (#35's WebhookOrderPayload)
 * that the shipment mapping consumes. Declared structurally so this mapper does
 * not depend on #35's full payload type; field optionality mirrors #35's real
 * type (goodsOwnerOrderId?, tracking[].waybill?, tracking[].isReturn?) so the
 * real payload is assignable without a TS2345 error at build.
 */
export type WebhookShipmentSource = {
  goodsOwnerOrderId?: string
  orderStatus: { number: number }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
}

/**
 * Derive the idempotent shipment-sync input from a verified, in-band ("shipped"
 * status) Ongoing webhook payload.
 *
 * - ongoing_order_number := goodsOwnerOrderId ?? "" (Ongoing's external order id =
 *   the client ref we set as orderNumber when pushing the order). A missing id
 *   yields "", which #33's loadSyncForShipmentStep resolves to no_sync_row — a
 *   safe no-op under the always-200, downstream-idempotent contract.
 * - status_code := orderStatus.number.
 * - tracking_numbers := outbound parcel waybills only (return parcels excluded);
 *   a missing waybill coalesces to "".
 * - status_text := "" — the webhook payload carries no status text; the poll job
 *   (#34) supplies real text and syncOngoingShipmentWorkflow tolerates empty.
 */
export function mapWebhookPayloadToShipmentInput(
  payload: WebhookShipmentSource
): SyncOngoingShipmentInput {
  return {
    ongoing_order_number: payload.goodsOwnerOrderId ?? "",
    status_code: payload.orderStatus.number,
    status_text: "",
    tracking_numbers: (payload.tracking ?? [])
      .filter((parcel) => !parcel.isReturn)
      .map((parcel) => parcel.waybill ?? ""),
  }
}

import { MedusaError } from "@medusajs/framework/utils"

export type OngoingOrderNumberInput = {
  displayId: number | string
  fulfillmentId: string
}

/**
 * Build the `ongoing_order_number` upsert key for a Medusa fulfillment.
 *
 * Format: `<order.display_id>-<fulfillment.id>` using the FULL fulfillment id.
 * - Deterministic: same inputs -> same key, so a retried `PUT /api/v1/orders`
 *   upserts the same Ongoing order instead of creating a duplicate.
 * - Unique per Ongoing order: distinct fulfillments of one Medusa order yield
 *   distinct keys (one Ongoing order each).
 * - Non-empty: satisfies Ongoing OpenAPI `orderNumber` minLength 1.
 *
 * This is the value persisted to `OngoingOrderSync.ongoing_order_number` (the
 * `.unique()` column) before the PUT. `ongoing_order_id` is captured separately
 * from the PUT response `orderId`; the response does not echo `orderNumber`.
 */
export function buildOngoingOrderNumber(input: OngoingOrderNumberInput): string {
  const displayId = input?.displayId
  if (displayId === undefined || displayId === null || `${displayId}` === "") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] cannot build order number: order display_id is missing"
    )
  }

  const fulfillmentId = input?.fulfillmentId
  if (!fulfillmentId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] cannot build order number: fulfillment id is missing"
    )
  }

  return `${displayId}-${fulfillmentId}`
}

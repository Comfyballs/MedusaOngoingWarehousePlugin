import { MedusaError } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"

// Shape of a raw `fulfillment.items[]` entry as returned by `query.graph` for the
// `items.quantity`/`items.sku`/`items.barcode`/`items.title`/`items.line_item_id` field
// selection below -- only the fields this function actually reads.
type RawReturnFulfillmentItem = {
  quantity: number
  sku?: string | null
  barcode?: string | null
  title?: string | null
  line_item_id?: string | null
}

export type QueriedReturnFulfillment = {
  return_fulfillment_id: string
  location_id: string
  items: Array<{
    quantity: number
    sku: string | null
    barcode: string | null
    title: string | null
    line_item_id: string | null
  }>
}

/**
 * Re-query a RETURN fulfillment fresh by id, mirroring `reQueryFulfillmentOrder`.
 *
 * Unlike an outbound fulfillment, a return fulfillment has NO direct `order` relation
 * (Medusa's `createReturnFulfillment` module-service method destructures `order` out of
 * the input before creating the fulfillment row, and links the return fulfillment to the
 * order only indirectly via `order_return.fulfillment_id` — see
 * `create-return-fulfillment.js`/`confirm-return-request.js`). So this helper deliberately
 * does NOT attempt an `order.*` field selection here; the calling step instead resolves
 * the original order from one of `items[].line_item_id` (see
 * `resolve-return-origin.ts`), using the SAME-module `order.items` relation.
 */
export async function reQueryReturnFulfillment(
  query: Omit<RemoteQueryFunction, symbol>,
  returnFulfillmentId: string
): Promise<QueriedReturnFulfillment> {
  const { data } = await query.graph({
    entity: "fulfillment",
    fields: [
      "id",
      "location_id",
      "items.quantity",
      "items.sku",
      "items.barcode",
      "items.title",
      "items.line_item_id",
    ],
    filters: { id: returnFulfillmentId },
  })

  const fulfillment = data[0]
  if (!fulfillment) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] return fulfillment "${returnFulfillmentId}" not found when pushing to Ongoing`
    )
  }

  return {
    return_fulfillment_id: fulfillment.id,
    location_id: fulfillment.location_id,
    items: (fulfillment.items ?? []).map((i: RawReturnFulfillmentItem) => ({
      quantity: i.quantity,
      sku: i.sku ?? null,
      barcode: i.barcode ?? null,
      title: i.title ?? null,
      line_item_id: i.line_item_id ?? null,
    })),
  }
}

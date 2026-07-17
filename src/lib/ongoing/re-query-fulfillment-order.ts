import { MedusaError } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import type { CodeNamePair, PostOrderTransporter } from "./types"
import { extractOngoingCarrier } from "./way-of-delivery"

// Shape of a raw `fulfillment.items[]` entry as returned by `query.graph` for the
// `items.quantity`/`items.sku`/`items.barcode`/`items.title`/`items.line_item_id`
// field selection above -- only the fields this function actually reads.
type RawFulfillmentItem = {
  quantity: number
  sku?: string | null
  barcode?: string | null
  title?: string | null
  line_item_id?: string | null
}

// Shape of a raw `order.items[]` entry. `id` here IS the order line item id and
// matches `fulfillment.items[].line_item_id` above (confirmed against Medusa
// core's createOrderFulfillmentWorkflow, which keys fulfillment items off
// `order.items[].id` from this same query.graph shape -- see
// @medusajs/core-flows/order/workflows/create-fulfillment). `unit_price` is a
// same-module field on the order line item; `variant.weight` is a cross-module
// join into the Product module -- both are valid `query.graph` field paths on
// the "order" entity's "items" relation (@medusajs/core-flows requests
// `items.variant.weight` itself when building fulfillment data).
type RawOrderLineItem = {
  id: string
  unit_price?: number | null
  variant?: { weight?: number | null } | null
}

export type QueriedFulfillmentOrder = {
  fulfillment_id: string
  location_id: string
  // Ongoing carrier assignment resolved from the fulfillment's
  // shipping_option.data (static, durable across retries). Undefined when the
  // option carries no carrier config.
  way_of_delivery?: CodeNamePair
  transporter?: PostOrderTransporter
  items: Array<{
    quantity: number
    sku: string | null
    barcode: string | null
    title: string | null
    line_item_id: string | null
  }>
  order: {
    id: string
    display_id: number
    currency_code: string
    email: string | null
    shipping_address: {
      first_name: string | null
      last_name: string | null
      address_1: string | null
      address_2: string | null
      city: string | null
      postal_code: string | null
      country_code: string | null
      phone: string | null
      company: string | null
    } | null
    // Order line items keyed later (in query-fulfillment-order.ts) by id ==
    // fulfillment.items[].line_item_id, to attach weight/unit_price per Ongoing
    // order line (customs/invoice data -- see order-mapper.ts mapLine()).
    line_items: Array<{
      id: string
      unit_price: number | null
      weight: number | null
    }>
  }
}

// Shared helper OWNED by #26 and imported by #27. Plain async fn (not a step) so both can reuse it.
// `Omit<RemoteQueryFunction, symbol>` (not the plain `RemoteQueryFunction`) — this is
// the exact type Medusa's own container typing (@medusajs/framework's container.d.ts)
// declares for `ContainerRegistrationKeys.QUERY`. `RemoteQueryFunction` itself is a
// callable type (has call signatures), which `Omit` strips, so every real call site
// (`container.resolve(ContainerRegistrationKeys.QUERY)` on a typed `MedusaContainer`,
// e.g. query-fulfillment-order.ts and upsert-ongoing-order-edit.ts) produces exactly
// this narrower type and would otherwise fail to satisfy a `RemoteQueryFunction`
// parameter here.
export async function reQueryFulfillmentOrder(
  query: Omit<RemoteQueryFunction, symbol>,
  fulfillmentId: string
): Promise<QueriedFulfillmentOrder> {
  const { data } = await query.graph({
    entity: "fulfillment",
    fields: [
      "id",
      "location_id",
      "shipping_option.data",
      "items.quantity",
      "items.sku",
      "items.barcode",
      "items.title",
      "items.line_item_id",
      "order.id",
      "order.display_id",
      "order.currency_code",
      "order.email",
      "order.shipping_address.first_name",
      "order.shipping_address.last_name",
      "order.shipping_address.address_1",
      "order.shipping_address.address_2",
      "order.shipping_address.city",
      "order.shipping_address.postal_code",
      "order.shipping_address.country_code",
      "order.shipping_address.phone",
      "order.shipping_address.company",
      "order.items.id",
      "order.items.unit_price",
      "order.items.variant.weight",
    ],
    filters: { id: fulfillmentId },
  })

  const fulfillment = data[0]
  if (!fulfillment) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] fulfillment "${fulfillmentId}" not found when pushing to Ongoing`
    )
  }

  const order = fulfillment.order
  if (!order) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] fulfillment "${fulfillmentId}" has no linked order when pushing to Ongoing`
    )
  }

  const carrier = extractOngoingCarrier(fulfillment.shipping_option?.data)

  return {
    fulfillment_id: fulfillment.id,
    location_id: fulfillment.location_id,
    way_of_delivery: carrier.wayOfDelivery,
    transporter: carrier.transporter,
    items: (fulfillment.items ?? []).map((i: RawFulfillmentItem) => ({
      quantity: i.quantity,
      sku: i.sku ?? null,
      barcode: i.barcode ?? null,
      title: i.title ?? null,
      line_item_id: i.line_item_id ?? null,
    })),
    order: {
      id: order.id,
      display_id: order.display_id,
      currency_code: order.currency_code,
      email: order.email ?? null,
      shipping_address: order.shipping_address ?? null,
      line_items: (order.items ?? []).map((i: RawOrderLineItem) => ({
        id: i.id,
        unit_price: typeof i.unit_price === "number" ? i.unit_price : null,
        weight: typeof i.variant?.weight === "number" ? i.variant.weight : null,
      })),
    },
  }
}

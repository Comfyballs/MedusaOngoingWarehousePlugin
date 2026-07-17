import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MapOrderInput, PostOrderModel } from "../../lib/ongoing/types"
import type { QueriedFulfillmentOrderWithLines } from "./query-fulfillment-order"
import { mapOrderToPostOrderModel } from "../../lib/ongoing/order-mapper"
import { buildOngoingOrderNumber } from "../../lib/ongoing/order-number"

export type MapOrderStepInput = {
  queried: QueriedFulfillmentOrderWithLines
  goods_owner_id: number
}
export type MapOrderOutput = { model: PostOrderModel; ongoing_order_number: string }

// Exported handler so the step can be unit-tested directly (the createStep wrapper
// does not expose its invoke fn).
export async function mapOrderToOngoingHandler(input: MapOrderStepInput): Promise<MapOrderOutput> {
  const { queried, goods_owner_id } = input

  // #25 — single object arg.
  const ongoingOrderNumber = buildOngoingOrderNumber({
    displayId: queried.order.display_id,
    fulfillmentId: queried.fulfillment_id,
  })

  // #24 — build ONE flat MapOrderInput; lines already carry resolved article_number
  // (Task 3) plus weight/unit_price resolved by query-fulfillment-order.ts (dl3) for
  // Ongoing-side customs/invoice/weight logic (order-mapper.ts mapLine()).
  const mapInput: MapOrderInput = {
    goods_owner_id,
    order_number: ongoingOrderNumber,
    delivery_date: new Date().toISOString(),
    currency_code: queried.order.currency_code,
    email: queried.order.email ?? undefined,
    shipping_address: queried.order.shipping_address,
    // Carrier resolved by query-fulfillment-order from shipping_option.data (R6).
    way_of_delivery: queried.way_of_delivery ?? null,
    transporter: queried.transporter ?? null,
    lines: queried.resolvedLines.map((l) => ({
      article_number: l.article_number,
      quantity: l.quantity,
      weight: l.weight,
      unit_price: l.unit_price,
      // No per-line currency_code: the mapper falls back to the order-level
      // currency_code (set above) when a line doesn't carry its own.
    })),
  }

  // Mapper is PURE and sets orderNumber/goodsOwnerId from MapOrderInput — no re-stamping here.
  const model = mapOrderToPostOrderModel(mapInput)

  return { model, ongoing_order_number: ongoingOrderNumber }
}

export const mapOrderToOngoingStep = createStep(
  "map-order-to-ongoing",
  async (input: MapOrderStepInput) => {
    const output = await mapOrderToOngoingHandler(input)
    return new StepResponse(output)
  }
)

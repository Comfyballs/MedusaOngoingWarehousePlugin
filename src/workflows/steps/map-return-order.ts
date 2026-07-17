import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MapReturnOrderInput, OngoingOrderLineDetail, PostReturnOrderModel } from "../../lib/ongoing/types"
import type { ResolvedReturnLine } from "./query-return-fulfillment"
import { mapReturnOrderToPostReturnOrderModel } from "../../lib/ongoing/return-order-mapper"
import { buildOngoingReturnOrderNumber } from "../../lib/ongoing/order-number"

export type MapReturnOrderStepInput = {
  return_fulfillment_id: string
  display_id: number
  goods_owner_id: number
  ongoing_order_id: number
  resolvedLines: ResolvedReturnLine[]
  original_order_lines: OngoingOrderLineDetail[]
}
export type MapReturnOrderOutput = { model: PostReturnOrderModel; return_order_number: string }

// Exported handler so the step can be unit-tested directly (the createStep wrapper does
// not expose its invoke fn).
export function mapReturnOrderHandler(input: MapReturnOrderStepInput): MapReturnOrderOutput {
  const returnOrderNumber = buildOngoingReturnOrderNumber({
    displayId: input.display_id,
    returnFulfillmentId: input.return_fulfillment_id,
  })

  // Date-only string (see PostReturnOrderModel.inDate) — built here (execution time),
  // inside the step handler, not inside createWorkflow's composition function.
  const inDate = new Date().toISOString().slice(0, 10)

  const mapInput: MapReturnOrderInput = {
    goods_owner_id: input.goods_owner_id,
    return_order_number: returnOrderNumber,
    ongoing_order_id: input.ongoing_order_id,
    in_date: inDate,
    lines: input.resolvedLines.map((l) => ({
      article_number: l.article_number,
      quantity: l.quantity,
    })),
    original_order_lines: input.original_order_lines,
  }

  const model = mapReturnOrderToPostReturnOrderModel(mapInput)

  return { model, return_order_number: returnOrderNumber }
}

export const mapReturnOrderStep = createStep(
  "map-return-order",
  async (input: MapReturnOrderStepInput) => {
    const output = mapReturnOrderHandler(input)
    return new StepResponse(output)
  }
)

import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { queryReturnFulfillmentStep } from "./steps/query-return-fulfillment"
import { resolveReturnOriginStep } from "./steps/resolve-return-origin"
import { resolveIntegrationContextStep } from "./steps/resolve-integration-context"
import { fetchOngoingOrderLinesStep } from "./steps/fetch-ongoing-order-lines"
import { mapReturnOrderStep } from "./steps/map-return-order"
import { pushReturnOrderStep } from "./steps/push-return-order"

export type PushReturnOrderToOngoingInput = { return_fulfillment_id: string }
export type PushReturnOrderToOngoingOutput = { ongoingReturnOrderId: number; returnOrderNumber: string }

/**
 * Push a Medusa return fulfillment to Ongoing as a return order (PUT /returnOrders).
 *
 * Mirrors `push-order-to-ongoing.ts`'s shape (query -> resolve integration -> map ->
 * push), with two extra resolution steps a return needs that an outbound push doesn't:
 * `resolveReturnOriginStep` (find the ORIGINAL order + its already-synced Ongoing order,
 * since a return fulfillment carries no direct order reference) and
 * `fetchOngoingOrderLinesStep` (fetch that original order's Ongoing-internal line ids,
 * since `PostReturnOrderLine.customerOrderLine.orderLineId` references Ongoing's own
 * order-line id, not our articleNumber/rowNumber).
 */
export const pushReturnOrderToOngoing = createWorkflow(
  "push-return-order-to-ongoing",
  function (input: PushReturnOrderToOngoingInput) {
    const queried = queryReturnFulfillmentStep({ return_fulfillment_id: input.return_fulfillment_id })

    const ctx = resolveIntegrationContextStep(
      transform({ queried }, (d) => ({ location_id: d.queried.location_id }))
    )

    const originInput = transform({ queried }, (d) => {
      const first = d.queried.resolvedLines[0]
      return { line_item_id: first ? first.line_item_id : null }
    })

    const origin = resolveReturnOriginStep(originInput)

    const originalLines = fetchOngoingOrderLinesStep(
      transform({ origin, ctx }, (d) => ({
        ongoing_order_id: d.origin.ongoing_order_id,
        credential_key: d.ctx.credential_key,
      }))
    )

    const mapped = mapReturnOrderStep(
      transform({ queried, origin, ctx, originalLines }, (d) => ({
        return_fulfillment_id: d.queried.return_fulfillment_id,
        display_id: d.origin.display_id,
        goods_owner_id: d.ctx.goods_owner_id,
        ongoing_order_id: d.origin.ongoing_order_id,
        resolvedLines: d.queried.resolvedLines,
        original_order_lines: d.originalLines.lines,
      }))
    )

    const pushed = pushReturnOrderStep(
      transform({ queried, origin, ctx, mapped }, (d) => ({
        model: d.mapped.model,
        return_order_number: d.mapped.return_order_number,
        credential_key: d.ctx.credential_key,
        integration_id: d.ctx.integration_id,
        medusa_order_id: d.origin.medusa_order_id,
        medusa_return_fulfillment_id: d.queried.return_fulfillment_id,
        ongoing_order_id: d.origin.ongoing_order_id,
      }))
    )

    return new WorkflowResponse(
      transform({ pushed }, (d) => ({
        ongoingReturnOrderId: d.pushed.ongoingReturnOrderId,
        returnOrderNumber: d.pushed.returnOrderNumber,
      }))
    )
  }
)

export default pushReturnOrderToOngoing

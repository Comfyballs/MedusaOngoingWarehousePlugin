import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { queryFulfillmentOrderStep } from "./steps/query-fulfillment-order"
import { mapOrderToOngoingStep } from "./steps/map-order-to-ongoing"
import { resolveIntegrationContextStep } from "./steps/resolve-integration-context"
import { pushOrderRecordSyncStep } from "./steps/push-order-record-sync"
import type { PostOrderModel } from "../lib/ongoing/types"

export type PushOrderToOngoingInput = { fulfillment_id: string }
export type PushOrderToOngoingOutput = { ongoingOrderId: number; orderNumber: string }

export const pushOrderToOngoing = createWorkflow(
  "push-order-to-ongoing",
  function (input: PushOrderToOngoingInput) {
    const queried = queryFulfillmentOrderStep({ fulfillment_id: input.fulfillment_id })

    const ctx = resolveIntegrationContextStep(
      transform({ queried }, (d) => ({ location_id: d.queried.location_id }))
    )

    const mapped = mapOrderToOngoingStep(
      transform({ queried, ctx }, (d) => ({
        queried: d.queried,
        goods_owner_id: d.ctx.goods_owner_id,
      }))
    )

    const pushed = pushOrderRecordSyncStep(
      transform({ queried, ctx, mapped }, (d) => ({
        model: d.mapped.model as PostOrderModel,
        ongoing_order_number: d.mapped.ongoing_order_number,
        credential_key: d.ctx.credential_key,
        integration_id: d.ctx.integration_id,
        goods_owner_id: d.ctx.goods_owner_id,
        medusa_order_id: d.queried.order.id,
        medusa_fulfillment_id: d.queried.fulfillment_id,
      }))
    )

    return new WorkflowResponse(
      transform({ pushed }, (d) => ({
        ongoingOrderId: d.pushed.ongoingOrderId,
        orderNumber: d.pushed.orderNumber,
      }))
    )
  }
)

export default pushOrderToOngoing

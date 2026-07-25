import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { pushOrderToOngoing } from "../../../../../../workflows"
import { ONGOING_MODULE } from "../../../../../../modules/ongoing"

export type RepushRequestBody = { fulfillment_id?: unknown }

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    medusa_order_id: string
    medusa_fulfillment_id: string
    sync_kind?: "order" | "return"
  }) => Promise<Array<{ id: string }>>
}

export async function POST(
  req: MedusaRequest<RepushRequestBody>,
  res: MedusaResponse
): Promise<void> {
  const fulfillmentId = req.body?.fulfillment_id

  if (typeof fulfillmentId !== "string" || fulfillmentId.trim().length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] fulfillment_id is required to re-push an order to Ongoing"
    )
  }

  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  const orderId = req.params.orderId
  // sync_kind:"order" (8p8): this route runs the ORDER push, so it must only match
  // an outbound order row — never a return row that happens to share the id space.
  const syncs = await ongoing.listOngoingOrderSyncs({
    medusa_order_id: orderId,
    medusa_fulfillment_id: fulfillmentId,
    sync_kind: "order",
  })

  if (syncs.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] no Ongoing sync record found for order ${orderId} and fulfillment ${fulfillmentId}`
    )
  }

  const { result } = await pushOrderToOngoing(req.scope).run({
    input: { fulfillment_id: fulfillmentId },
  })

  res.status(200).json({
    ongoing_order_id: result.ongoingOrderId,
    ongoing_order_number: result.orderNumber,
  })
}

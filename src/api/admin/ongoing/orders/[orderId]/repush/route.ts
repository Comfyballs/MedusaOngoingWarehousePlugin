import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { pushOrderToOngoing } from "../../../../../../workflows"

export type RepushRequestBody = { fulfillment_id?: unknown }

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

  const { result } = await pushOrderToOngoing(req.scope).run({
    input: { fulfillment_id: fulfillmentId },
  })

  res.status(200).json({
    ongoing_order_id: result.ongoingOrderId,
    ongoing_order_number: result.orderNumber,
  })
}

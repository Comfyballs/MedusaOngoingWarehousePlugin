import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { cancelOngoingOrderWorkflow } from "../workflows/cancel-ongoing-order"

type OrderSyncRow = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  medusa_fulfillment_id?: string
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (
    filter: { medusa_order_id: string },
    config?: { select?: string[] }
  ) => Promise<OrderSyncRow[]>
}

function mapRowToInput(orderId: string, row: OrderSyncRow) {
  return {
    medusa_order_id: orderId,
    medusa_fulfillment_id: row.medusa_fulfillment_id ?? undefined,
    ongoing_order_number: row.ongoing_order_number,
  }
}

export default async function orderCanceledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = data.id

  let rows: OrderSyncRow[]
  try {
    const ongoingService = container.resolve(
      ONGOING_MODULE
    ) as OngoingServiceLike
    rows = await ongoingService.listOngoingOrderSyncs(
      { medusa_order_id: orderId },
      { select: ["id", "ongoing_order_number", "medusa_fulfillment_id"] }
    )
  } catch (error) {
    logger.error(
      `[ongoing] order.canceled: failed to load sync rows for order ${orderId}: ${
        (error as Error).message
      }`
    )
    return
  }

  if (!rows?.length) {
    logger.info(
      `[ongoing] order.canceled: no Ongoing sync rows for order ${orderId}, nothing to cancel`
    )
    return
  }

  // Cancel every Ongoing order tied to this Medusa order. The workflow is
  // status-gated and idempotent, so a per-row no-op is safe and expected.
  for (const row of rows) {
    try {
      const { result } = await cancelOngoingOrderWorkflow(container).run({
        input: mapRowToInput(orderId, row),
      })
      logger.info(
        `[ongoing] order.canceled: ${row.ongoing_order_number} (order ${orderId}) -> ${
          result?.reason ?? "done"
        }`
      )
    } catch (error) {
      logger.error(
        `[ongoing] order.canceled: cancelOngoingOrderWorkflow failed for ${row.ongoing_order_number} (order ${orderId}): ${
          (error as Error).message
        }`
      )
      // Continue with the remaining rows; never throw from a subscriber.
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}

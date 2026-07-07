import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IEventBusModuleService } from "@medusajs/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { cancelOngoingOrderWorkflow } from "../workflows/cancel-ongoing-order"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
import type { OrderCancelledPayload } from "../lib/ongoing/events"
import { emitDomainEvent } from "../lib/ongoing/emit-domain-event"

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
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
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
      if (result?.shouldCancel === true) {
        // Persist-then-emit (#116): the workflow above already committed the
        // cancel. Route the emit through the isolated helper so an event-bus
        // outage here is not caught by this row's catch and mis-logged as
        // "cancelOngoingOrderWorkflow failed".
        await emitDomainEvent(
          eventBus,
          logger,
          ONGOING_EVENTS.ORDER_CANCELLED,
          {
            medusa_order_id: orderId,
            ongoing_order_number: row.ongoing_order_number,
            ongoing_order_sync_id: row.id,
            reason: result?.reason ?? "ok",
          } satisfies OrderCancelledPayload,
          `order.canceled order=${orderId} sync=${row.id}`
        )
      }
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

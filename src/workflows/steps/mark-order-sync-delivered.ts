import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, IEventBusModuleService, Logger } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { OrderDeliveredPayload } from "../../lib/ongoing/events"

export type MarkDeliveredInput = {
  order_sync_id: string
  status_code: number
  status_text: string
  medusa_order_id: string
  ongoing_order_number: string
}

// Records the pickup-point collection (Ongoing status 500 / stage "delivered")
// on the sync row: sync_state -> "delivered", delivered_at stamped, latest status
// mirrored. Mirrors markOrderSyncShippedStep's write-then-best-effort-emit shape
// so an event-bus outage never turns a committed delivery into a thrown error.
export const markOrderSyncDeliveredHandler = async (
  input: MarkDeliveredInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

  try {
    await ongoing.updateOngoingOrderSyncs({
      id: input.order_sync_id,
      sync_state: "delivered",
      delivered_at: new Date(),
      latest_status_code: input.status_code,
      latest_status_text: input.status_text,
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
    })
  } catch (err) {
    logger.error(
      `[ongoing] mark-order-sync-delivered: failed ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} ongoing_order_number=${input.ongoing_order_number} error=${(err as Error).message}`
    )
    throw err
  }

  logger.info(
    `[ongoing] mark-order-sync-delivered: applied ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} ongoing_order_number=${input.ongoing_order_number} status_code=${input.status_code}`
  )

  // Best-effort emit: the sync row is already committed as "delivered" above.
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.ORDER_DELIVERED,
      data: {
        medusa_order_id: input.medusa_order_id,
        ongoing_order_sync_id: input.order_sync_id,
        ongoing_order_number: input.ongoing_order_number,
        status_code: input.status_code,
        status_text: input.status_text,
      } satisfies OrderDeliveredPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] mark-order-sync-delivered: failed to emit ${ONGOING_EVENTS.ORDER_DELIVERED} ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} error=${(emitErr as Error).message}`
    )
  }

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncDeliveredStep = createStep(
  "mark-order-sync-delivered",
  markOrderSyncDeliveredHandler
)

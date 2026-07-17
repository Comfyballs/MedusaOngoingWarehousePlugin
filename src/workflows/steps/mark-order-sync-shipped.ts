import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, IEventBusModuleService, Logger } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { ShipmentAppliedPayload } from "../../lib/ongoing/events"

export type MarkShippedInput = {
  order_sync_id: string
  status_code: number
  status_text: string
  medusa_order_id: string
  medusa_fulfillment_id: string
  ongoing_order_number: string
  tracking_numbers: string[]
}

export const markOrderSyncShippedHandler = async (
  input: MarkShippedInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

  try {
    await ongoing.updateOngoingOrderSyncs({
      id: input.order_sync_id,
      sync_state: "shipped",
      shipped_at: new Date(),
      latest_status_code: input.status_code,
      latest_status_text: input.status_text,
      error_class: null,
      last_error: null,
      last_synced_at: new Date(),
    })
  } catch (err) {
    logger.error(
      `[ongoing] mark-order-sync-shipped: failed ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(err as Error).message}`
    )
    throw err
  }

  logger.info(
    `[ongoing] mark-order-sync-shipped: applied ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} tracking_numbers=${input.tracking_numbers.join(",")}`
  )
  // Best-effort emit: the sync row is already committed as "shipped" above — an
  // event-bus outage here must not turn a real successful write into a thrown
  // error.
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.SHIPMENT_APPLIED,
      data: {
        medusa_order_id: input.medusa_order_id,
        medusa_fulfillment_id: input.medusa_fulfillment_id,
        ongoing_order_sync_id: input.order_sync_id,
        ongoing_order_number: input.ongoing_order_number,
        tracking_numbers: input.tracking_numbers,
      } satisfies ShipmentAppliedPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] mark-order-sync-shipped: failed to emit ${ONGOING_EVENTS.SHIPMENT_APPLIED} ongoing_order_sync_id=${input.order_sync_id} medusa_order_id=${input.medusa_order_id} error=${(emitErr as Error).message}`
    )
  }

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncShippedStep = createStep(
  "mark-order-sync-shipped",
  markOrderSyncShippedHandler
)

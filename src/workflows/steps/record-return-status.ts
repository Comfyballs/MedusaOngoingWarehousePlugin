import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, IEventBusModuleService, Logger } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { ReturnStatusReceivedPayload } from "../../lib/ongoing/events"
import { emitDomainEvent } from "../../lib/ongoing/emit-domain-event"

export type RecordReturnStatusInput = {
  ongoing_order_number: string
  integration_id: string
  status_code: number
  status_text: string
  return_tracking_numbers: string[]
  return_parcel_numbers: string[]
}

export type RecordReturnStatusOutput = {
  recorded: boolean
  reason?: "no_order_number" | "no_sync_row"
}

type OrderSyncRow = { id: string; medusa_order_id: string }

/**
 * Records an inbound return-status signal extracted from the Ongoing order-status
 * webhook (isReturn / isReturnParcel entries — see
 * ../../api/ongoing/webhooks/[credentialKey]/map-payload-to-return-status-input.ts).
 *
 * There is no persisted return-sync ledger (see push-return-order.ts's comment and
 * Dev-Architecture.md's "Return-sync ledger decision" section) and the webhook
 * payload carries no return-order-specific identifier (no `returnOrderNumber`), so
 * this step deliberately does NOT attempt to mutate a specific Medusa `return`
 * record (e.g. via core's receive-return workflows) — doing so would require
 * guessing (a) which of an order's returns the activity belongs to when more than
 * one is in flight, and (b) which Ongoing status codes mean "received", which is
 * unverified against a live sandbox (see bead MedusaOngoingWarehousePlugin-2a6).
 *
 * Instead it resolves the ORIGINAL order via the existing OngoingOrderSync row
 * (read-only lookup, same table/shape as refresh-order-sync-status.ts) and emits
 * ONGOING_EVENTS.RETURN_STATUS_RECEIVED plus a clear log line, so the activity is
 * durably observable (event + log) instead of being silently dropped the way the
 * shipment mapper's `isReturn` filter drops it from outbound shipment application.
 * Promoting this to an automatic Medusa-side return-receive mutation is tracked as
 * follow-up work once the live sandbox confirms real status codes.
 */
export async function recordReturnStatusHandler(
  input: RecordReturnStatusInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<RecordReturnStatusOutput>> {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

  const orderNumber = input.ongoing_order_number?.trim()
  if (!orderNumber) {
    logger.warn(
      `[ongoing] record-return-status: webhook return activity carried no goodsOwnerOrderId; ` +
        `dropping (return_tracking_numbers=${input.return_tracking_numbers.join(",")} ` +
        `return_parcel_numbers=${input.return_parcel_numbers.join(",")})`
    )
    return new StepResponse({ recorded: false, reason: "no_order_number" })
  }

  // ongoing_order_number is globally unique; scope by integration_id too as
  // defense-in-depth so one credential's webhook can never touch another's row
  // (mirrors refresh-order-sync-status.ts).
  const [row] = (await ongoing.listOngoingOrderSyncs({
    ongoing_order_number: orderNumber,
    integration_id: input.integration_id,
  })) as OrderSyncRow[]

  if (!row) {
    logger.warn(
      `[ongoing] record-return-status: no OngoingOrderSync row for ongoing_order_number=${orderNumber}; ` +
        `dropping return activity (status_code=${input.status_code} ` +
        `return_tracking_numbers=${input.return_tracking_numbers.join(",")} ` +
        `return_parcel_numbers=${input.return_parcel_numbers.join(",")})`
    )
    return new StepResponse({ recorded: false, reason: "no_sync_row" })
  }

  logger.info(
    `[ongoing] record-return-status: recorded return activity medusa_order_id=${row.medusa_order_id} ` +
      `ongoing_order_number=${orderNumber} status_code=${input.status_code} status_text=${input.status_text} ` +
      `return_tracking_numbers=${input.return_tracking_numbers.join(",")} ` +
      `return_parcel_numbers=${input.return_parcel_numbers.join(",")}`
  )

  await emitDomainEvent(
    eventBus,
    logger,
    ONGOING_EVENTS.RETURN_STATUS_RECEIVED,
    {
      medusa_order_id: row.medusa_order_id,
      ongoing_order_number: orderNumber,
      ongoing_order_sync_id: row.id,
      integration_id: input.integration_id,
      status_code: input.status_code,
      status_text: input.status_text,
      return_tracking_numbers: input.return_tracking_numbers,
      return_parcel_numbers: input.return_parcel_numbers,
    } satisfies ReturnStatusReceivedPayload,
    "record-return-status"
  )

  return new StepResponse({ recorded: true })
}

export const recordReturnStatusStep = createStep(
  "record-return-status",
  recordReturnStatusHandler
)

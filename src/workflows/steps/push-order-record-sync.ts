import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { classifyError } from "../../lib/ongoing/errors"
import type { PostOrderModel } from "../../lib/ongoing/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { OrderPushedPayload, PushFailedPayload } from "../../lib/ongoing/events"

export type PushOrderInput = {
  model: PostOrderModel
  ongoing_order_number: string
  credential_key: string
  integration_id: string
  goods_owner_id: number
  medusa_order_id: string
  medusa_fulfillment_id: string
}

export type PushOrderOutput = { ongoingOrderId: number; orderNumber: string }

// Exported handler so the step can be unit-tested directly (the createStep wrapper
// does not expose its invoke fn).
//
// Error capture lives INSIDE invoke (record-then-rethrow), not in a compensation
// function: when a step's invoke throws it returns no StepResponse, so Medusa runs
// its compensation with `undefined` — the classified error is unavailable there.
// Recording in the catch block guarantees the OngoingOrderSync error row is written
// with error_class/last_error while still rejecting so the caller (#21) sees failure.
export async function pushOrderRecordSyncHandler(
  input: PushOrderInput,
  { container }: { container: any }
): Promise<PushOrderOutput> {
  const service: any = container.resolve(ONGOING_MODULE)
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus: any = container.resolve(Modules.EVENT_BUS)

  // Persist the order number BEFORE the PUT so a retry upserts the same Ongoing order.
  // Clear any error columns from a prior failed attempt so a retry starts clean.
  await service.recordSync({
    ongoing_order_number: input.ongoing_order_number,
    integration_id: input.integration_id,
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    sync_state: "pending",
    error_class: null,
    last_error: null,
  })

  let ongoingOrderId: number
  try {
    // getClient() is inside the try so a misconfigured credential_key is also
    // recorded as an error row (it never leaves the sync stuck in "pending").
    const client = service.getClient(input.credential_key)
    const res = await client.putOrder(input.model)
    ongoingOrderId = res.ongoingOrderId
  } catch (err) {
    // #67: classifyError defaults a non-OngoingApiError (network/unknown) failure to
    // "retryable" so a brief outage is retried by #21, not dead-lettered as terminal.
    const errorClass = classifyError(err)
    await service.recordSync({
      ongoing_order_number: input.ongoing_order_number,
      integration_id: input.integration_id,
      medusa_order_id: input.medusa_order_id,
      medusa_fulfillment_id: input.medusa_fulfillment_id,
      sync_state: "error",
      error_class: errorClass,
      last_error: (err as Error).message,
    })
    logger.error(
      `[ongoing] push-order-record-sync: failed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} integration_id=${input.integration_id} error_class=${errorClass} error=${(err as Error).message}`
    )
    // Best-effort emit: a failing event bus must not mask the real error (which
    // is what the caller and the recorded error row are for).
    try {
      await eventBus.emit({
        name: ONGOING_EVENTS.PUSH_FAILED,
        data: {
          medusa_order_id: input.medusa_order_id,
          medusa_fulfillment_id: input.medusa_fulfillment_id,
          ongoing_order_number: input.ongoing_order_number,
          integration_id: input.integration_id,
          error_class: errorClass,
          error_message: (err as Error).message,
        } satisfies PushFailedPayload,
      })
    } catch (emitErr) {
      logger.error(
        `[ongoing] push-order-record-sync: failed to emit ${ONGOING_EVENTS.PUSH_FAILED} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(emitErr as Error).message}`
      )
    }
    throw err
  }

  await service.recordSync({
    ongoing_order_number: input.ongoing_order_number,
    integration_id: input.integration_id,
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    sync_state: "sent",
    ongoing_order_id: ongoingOrderId,
    error_class: null,
    last_error: null,
  })

  logger.info(
    `[ongoing] push-order-record-sync: pushed medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} ongoing_order_number=${input.ongoing_order_number} ongoing_order_id=${ongoingOrderId} integration_id=${input.integration_id}`
  )
  // Best-effort emit: the order has already been recorded as "sent" above — an
  // event-bus outage here must not turn a real successful push into a thrown
  // error (pushOrderToOngoing runs synchronously inside createFulfillment, so a
  // thrown emit would otherwise make Medusa treat a successful fulfillment as
  // failed).
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.ORDER_PUSHED,
      data: {
        medusa_order_id: input.medusa_order_id,
        medusa_fulfillment_id: input.medusa_fulfillment_id,
        ongoing_order_number: input.ongoing_order_number,
        ongoing_order_id: ongoingOrderId,
        integration_id: input.integration_id,
      } satisfies OrderPushedPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] push-order-record-sync: failed to emit ${ONGOING_EVENTS.ORDER_PUSHED} medusa_order_id=${input.medusa_order_id} medusa_fulfillment_id=${input.medusa_fulfillment_id} error=${(emitErr as Error).message}`
    )
  }

  return { ongoingOrderId, orderNumber: input.ongoing_order_number }
}

export const pushOrderRecordSyncStep = createStep(
  "push-order-record-sync",
  async (input: PushOrderInput, context) => {
    const output = await pushOrderRecordSyncHandler(input, context as any)
    return new StepResponse(output)
  }
)

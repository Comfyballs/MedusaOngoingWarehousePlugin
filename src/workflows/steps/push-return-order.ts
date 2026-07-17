import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, IEventBusModuleService, Logger } from "@medusajs/framework/types"
import { classifyError } from "../../lib/ongoing/errors"
import type { PostReturnOrderModel } from "../../lib/ongoing/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import { ONGOING_EVENTS } from "../../lib/ongoing/events"
import type { ReturnOrderPushedPayload, ReturnOrderPushFailedPayload } from "../../lib/ongoing/events"
import { emitDomainEvent } from "../../lib/ongoing/emit-domain-event"

export type PushReturnOrderInput = {
  model: PostReturnOrderModel
  return_order_number: string
  credential_key: string
  integration_id: string
  medusa_order_id: string
  medusa_return_fulfillment_id: string
  ongoing_order_id: number
}

export type PushReturnOrderOutput = { ongoingReturnOrderId: number; returnOrderNumber: string }

// Exported handler so the step can be unit-tested directly (the createStep wrapper does
// not expose its invoke fn).
//
// Unlike push-order-record-sync.ts, there is no dedicated return-sync ledger table (no
// migration was added for this feature — see Dev-Architecture.md), so this step's only
// durable trail is the ONGOING_EVENTS emit below plus application logs; a failure here
// throws (no compensation) and Medusa's core createReturnFulfillment module-service
// method deletes the just-created return fulfillment row on any provider throw, so the
// return fulfillment itself never lands in an orphaned "half pushed" state.
export async function pushReturnOrderHandler(
  input: PushReturnOrderInput,
  { container }: { container: MedusaContainer }
): Promise<PushReturnOrderOutput> {
  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

  let ongoingReturnOrderId: number
  try {
    const client = service.getClient(input.credential_key)
    const res = await client.putReturnOrder(input.model)
    ongoingReturnOrderId = res.ongoingReturnOrderId
  } catch (err) {
    const errorClass = classifyError(err)
    logger.error(
      `[ongoing] push-return-order: failed medusa_order_id=${input.medusa_order_id} medusa_return_fulfillment_id=${input.medusa_return_fulfillment_id} return_order_number=${input.return_order_number} integration_id=${input.integration_id} error_class=${errorClass} error=${(err as Error).message}`
    )
    await emitDomainEvent(
      eventBus,
      logger,
      ONGOING_EVENTS.RETURN_ORDER_PUSH_FAILED,
      {
        medusa_order_id: input.medusa_order_id,
        medusa_return_fulfillment_id: input.medusa_return_fulfillment_id,
        return_order_number: input.return_order_number,
        integration_id: input.integration_id,
        error_class: errorClass,
        error_message: (err as Error).message,
      } satisfies ReturnOrderPushFailedPayload,
      "push-return-order"
    )
    throw err
  }

  logger.info(
    `[ongoing] push-return-order: pushed medusa_order_id=${input.medusa_order_id} medusa_return_fulfillment_id=${input.medusa_return_fulfillment_id} return_order_number=${input.return_order_number} ongoing_return_order_id=${ongoingReturnOrderId} integration_id=${input.integration_id}`
  )
  await emitDomainEvent(
    eventBus,
    logger,
    ONGOING_EVENTS.RETURN_ORDER_PUSHED,
    {
      medusa_order_id: input.medusa_order_id,
      medusa_return_fulfillment_id: input.medusa_return_fulfillment_id,
      return_order_number: input.return_order_number,
      ongoing_return_order_id: ongoingReturnOrderId,
      ongoing_order_id: input.ongoing_order_id,
      integration_id: input.integration_id,
    } satisfies ReturnOrderPushedPayload,
    "push-return-order"
  )

  return { ongoingReturnOrderId, returnOrderNumber: input.return_order_number }
}

export const pushReturnOrderStep = createStep(
  "push-return-order",
  async (input: PushReturnOrderInput, context) => {
    const output = await pushReturnOrderHandler(input, context)
    return new StepResponse(output)
  }
)

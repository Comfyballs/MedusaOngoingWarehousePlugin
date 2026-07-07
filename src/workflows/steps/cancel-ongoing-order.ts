import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { OngoingApiError } from "../../lib/ongoing/errors"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type CancelStepInput = {
  ongoingOrderId: number
  credentialKey: string
}

export type CancelStepResult = {
  cancelled: boolean
  swallowed: boolean
}

export const cancelOngoingOrderHandler = async (
  input: CancelStepInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<CancelStepResult>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const client = ongoing.getClient(input.credentialKey)

  try {
    await client.cancelOrder(input.ongoingOrderId)
    logger.info(
      `[ongoing] cancel-ongoing-order: cancelled ongoing_order_id=${input.ongoingOrderId}`
    )
    return new StepResponse({ cancelled: true, swallowed: false })
  } catch (err) {
    if (err instanceof OngoingApiError && err.kind === "terminal") {
      // 4xx — Ongoing already cancelled / cannot cancel: idempotent success.
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled/terminal ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
    logger.error(
      `[ongoing] cancel-ongoing-order: failed ongoing_order_id=${input.ongoingOrderId} error=${(err as Error).message}`
    )
    throw err
  }
}

export const cancelOngoingOrderStep = createStep(
  "cancel-ongoing-order",
  cancelOngoingOrderHandler
)

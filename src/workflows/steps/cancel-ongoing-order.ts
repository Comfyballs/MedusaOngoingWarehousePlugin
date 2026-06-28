import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { OngoingApiError } from "../../lib/ongoing/errors"

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
  { container }: { container: any }
): Promise<StepResponse<CancelStepResult>> => {
  const ongoing = container.resolve("ongoing") as any
  const client = ongoing.getClient(input.credentialKey)

  try {
    await client.cancelOrder(input.ongoingOrderId)
    return new StepResponse({ cancelled: true, swallowed: false })
  } catch (err) {
    if (err instanceof OngoingApiError && err.kind === "terminal") {
      // 4xx — Ongoing already cancelled / cannot cancel: idempotent success.
      return new StepResponse({ cancelled: false, swallowed: true })
    }
    throw err
  }
}

export const cancelOngoingOrderStep = createStep(
  "cancel-ongoing-order",
  cancelOngoingOrderHandler
)

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type DeleteOngoingIntegrationInput = { id: string }
export type DeleteOngoingIntegrationOutput = { id: string; object: "integration"; deleted: true }

export const deleteOngoingIntegrationHandler = async (
  input: DeleteOngoingIntegrationInput,
  { container }: { container: any }
): Promise<StepResponse<DeleteOngoingIntegrationOutput>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  await ongoing.deleteOngoingIntegrations(input.id)
  return new StepResponse({ id: input.id, object: "integration", deleted: true })
}

// No compensation function — mirrors cancelOngoingOrderStep
// (src/workflows/steps/cancel-ongoing-order.ts:33-36): this is the terminal
// step of its own single-step workflow, so there is nothing after it that
// could fail and require rolling this delete back.
export const deleteOngoingIntegrationStep = createStep(
  "delete-ongoing-integration",
  deleteOngoingIntegrationHandler
)

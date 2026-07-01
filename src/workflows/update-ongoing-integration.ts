import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  updateOngoingIntegrationStep,
  type UpdateOngoingIntegrationInput,
} from "./steps/update-ongoing-integration"

export type { UpdateOngoingIntegrationInput }

export const updateOngoingIntegrationWorkflow = createWorkflow(
  "update-ongoing-integration",
  function (input: UpdateOngoingIntegrationInput) {
    const integration = updateOngoingIntegrationStep(input)
    return new WorkflowResponse(integration)
  }
)

export default updateOngoingIntegrationWorkflow

import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deleteOngoingIntegrationStep,
  type DeleteOngoingIntegrationInput,
} from "./steps/delete-ongoing-integration"

export type { DeleteOngoingIntegrationInput }

export const deleteOngoingIntegrationWorkflow = createWorkflow(
  "delete-ongoing-integration",
  function (input: DeleteOngoingIntegrationInput) {
    const result = deleteOngoingIntegrationStep(input)
    return new WorkflowResponse(result)
  }
)

export default deleteOngoingIntegrationWorkflow

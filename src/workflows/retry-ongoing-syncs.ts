import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  retryOngoingSyncsStep,
  type RetryOngoingSyncsInput,
} from "./steps/retry-ongoing-syncs"

export const retryOngoingSyncsWorkflow = createWorkflow(
  "retry-ongoing-syncs",
  function (input: RetryOngoingSyncsInput) {
    const result = retryOngoingSyncsStep(input)
    return new WorkflowResponse(result)
  }
)

export default retryOngoingSyncsWorkflow

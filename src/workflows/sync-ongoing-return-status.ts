import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  recordReturnStatusStep,
  type RecordReturnStatusInput,
} from "./steps/record-return-status"

// Wraps the return-status event-recording in a workflow so the webhook route
// mutates state (event emission via recordReturnStatusStep) through the workflow
// layer (arch-workflow-required) rather than calling steps/services directly.
// Mirrors refresh-ongoing-order-status.ts's single-step shape.
export const syncOngoingReturnStatusWorkflow = createWorkflow(
  "sync-ongoing-return-status",
  function (input: RecordReturnStatusInput) {
    const result = recordReturnStatusStep(input)

    return new WorkflowResponse(result)
  }
)

export default syncOngoingReturnStatusWorkflow
export type {
  RecordReturnStatusInput,
  RecordReturnStatusOutput,
} from "./steps/record-return-status"

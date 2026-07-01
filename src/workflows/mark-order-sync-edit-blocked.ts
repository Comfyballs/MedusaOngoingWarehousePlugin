import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  markOrderSyncEditBlockedStep,
  type MarkEditBlockedInput,
} from "./steps/mark-order-sync-edit-blocked"

export const markOrderSyncEditBlockedWorkflow = createWorkflow(
  "mark-order-sync-edit-blocked",
  function (input: MarkEditBlockedInput) {
    const result = markOrderSyncEditBlockedStep(input)
    return new WorkflowResponse(result)
  }
)

export default markOrderSyncEditBlockedWorkflow
export type { MarkEditBlockedInput } from "./steps/mark-order-sync-edit-blocked"

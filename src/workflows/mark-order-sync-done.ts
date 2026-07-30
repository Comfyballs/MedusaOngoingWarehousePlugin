import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  markOrderSyncDoneStep,
  type MarkOrderSyncDoneInput,
} from "./steps/mark-order-sync-done"

export const markOrderSyncDoneWorkflow = createWorkflow(
  "mark-order-sync-done",
  function (input: MarkOrderSyncDoneInput) {
    const result = markOrderSyncDoneStep(input)
    return new WorkflowResponse(result)
  }
)

export default markOrderSyncDoneWorkflow
export type { MarkOrderSyncDoneInput } from "./steps/mark-order-sync-done"

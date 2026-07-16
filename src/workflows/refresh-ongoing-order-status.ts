import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  refreshOrderSyncStatusStep,
  type RefreshOrderSyncStatusInput,
} from "./steps/refresh-order-sync-status"

// Wraps the own-module status-refresh write in a workflow so the webhook route
// mutates state through the workflow layer (arch-workflow-required) rather than
// calling the module service directly.
export const refreshOngoingOrderStatusWorkflow = createWorkflow(
  "refresh-ongoing-order-status",
  function (input: RefreshOrderSyncStatusInput) {
    const result = refreshOrderSyncStatusStep(input)
    return new WorkflowResponse(result)
  }
)

export default refreshOngoingOrderStatusWorkflow
export type {
  RefreshOrderSyncStatusInput,
  RefreshOrderSyncStatusOutput,
} from "./steps/refresh-order-sync-status"

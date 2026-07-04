import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  flagOrphanedOrderSyncsStep,
  type FlagOrphanedOrderSyncsInput,
} from "./steps/flag-orphaned-order-syncs"

export const flagOrphanedOrderSyncsWorkflow = createWorkflow(
  "flag-orphaned-order-syncs",
  function (input: FlagOrphanedOrderSyncsInput) {
    const result = flagOrphanedOrderSyncsStep(input)
    return new WorkflowResponse(result)
  }
)

export default flagOrphanedOrderSyncsWorkflow

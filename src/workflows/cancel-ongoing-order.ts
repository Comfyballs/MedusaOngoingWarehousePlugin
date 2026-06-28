import {
  createWorkflow,
  WorkflowResponse,
  transform,
  when,
} from "@medusajs/framework/workflows-sdk"
import {
  decideOngoingCancelStep,
  type DecideCancelInput,
  type CancelDecision,
} from "./steps/decide-ongoing-cancel"
import { cancelOngoingOrderStep } from "./steps/cancel-ongoing-order"
import { markOrderSyncCancelledStep } from "./steps/mark-order-sync-cancelled"

export type CancelOngoingOrderInput = DecideCancelInput

export const cancelOngoingOrderWorkflow = createWorkflow(
  "cancel-ongoing-order",
  function (input: CancelOngoingOrderInput) {
    const decision = decideOngoingCancelStep(input)

    when(decision, (d: CancelDecision) => d.shouldCancel).then(() => {
      const cancelInput = transform({ decision }, (data) => ({
        ongoingOrderId: data.decision.ongoingOrderId as number,
        credentialKey: data.decision.credentialKey as string,
      }))

      cancelOngoingOrderStep(cancelInput)

      const markInput = transform({ decision }, (data) => ({
        orderSyncId: data.decision.orderSyncId as string,
      }))

      markOrderSyncCancelledStep(markInput)
    })

    return new WorkflowResponse(decision)
  }
)

export default cancelOngoingOrderWorkflow

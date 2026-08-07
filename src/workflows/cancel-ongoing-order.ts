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
import { markOrderSyncCancelRefusedStep } from "./steps/mark-order-sync-cancel-refused"

export type CancelOngoingOrderInput = DecideCancelInput

export const cancelOngoingOrderWorkflow = createWorkflow(
  "cancel-ongoing-order",
  function (input: CancelOngoingOrderInput) {
    const decision = decideOngoingCancelStep(input)

    when("cancel-should-cancel", decision, (d: CancelDecision) => d.shouldCancel).then(() => {
      const cancelInput = transform({ decision }, (data) => ({
        ongoingOrderId: data.decision.ongoingOrderId as number,
        credentialKey: data.decision.credentialKey as string,
        goodsOwnerId: data.decision.goodsOwnerId as number,
      }))

      cancelOngoingOrderStep(cancelInput)

      const markInput = transform({ decision }, (data) => ({
        orderSyncId: data.decision.orderSyncId as string,
      }))

      markOrderSyncCancelledStep(markInput)
    })

    // ei4 fallout (eer): Ongoing refused the cancel (status not cancellable) but
    // Medusa already committed its own cancel. Flag the divergence for operators.
    when(
      "cancel-refused-status-not-cancellable",
      decision,
      (d: CancelDecision) => d.reason === "status_not_cancellable"
    ).then(
      () => {
        const refusedInput = transform({ decision }, (data) => ({
          order_sync_id: data.decision.orderSyncId as string,
          reason: data.decision.refusedReason,
        }))

        markOrderSyncCancelRefusedStep(refusedInput)
      }
    )

    return new WorkflowResponse(decision)
  }
)

export default cancelOngoingOrderWorkflow

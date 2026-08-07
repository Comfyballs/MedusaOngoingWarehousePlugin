import { createWorkflow, WorkflowResponse, transform, when } from "@medusajs/framework/workflows-sdk"
import { gateOrderEditStep, type GateInput } from "./steps/gate-order-edit"
import { upsertOngoingOrderEditStep } from "./steps/upsert-ongoing-order-edit"

export type SyncOrderEditResult = {
  synced: boolean
  blocked: boolean
  reason: string
}

const syncOrderEditToOngoing = createWorkflow(
  "sync-order-edit-to-ongoing",
  function (input: GateInput) {
    const decision = gateOrderEditStep(input)

    // Only run the upsert when the gate allows it. when() replaces the
    // forbidden inline conditional in workflow composition.
    const upsert = when("order-edit-sync-allowed", decision, (d) => d.allowed).then(() => {
      return upsertOngoingOrderEditStep(decision)
    })

    const result = transform({ decision, upsert }, (data): SyncOrderEditResult => {
      const allowed = data.decision.allowed
      return {
        synced: allowed && !!data.upsert,
        blocked: !allowed,
        reason: data.decision.reason,
      }
    })

    return new WorkflowResponse(result)
  }
)

export default syncOrderEditToOngoing
export { syncOrderEditToOngoing }

import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk"
import { fetchOngoingInventoryStep } from "./steps/fetch-ongoing-inventory"
import { reconcileInventoryLevelsStep } from "./steps/reconcile-inventory-levels"

export type SyncOngoingInventoryInput = {
  integration_id: string
  credential_key: string
  stock_location_id: string
  goods_owner_id: number
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

export const syncOngoingInventoryWorkflow = createWorkflow(
  "sync-ongoing-inventory",
  function (input: SyncOngoingInventoryInput) {
    const rows = fetchOngoingInventoryStep(
      transform({ input }, (data) => ({ credential_key: data.input.credential_key }))
    )

    const result = reconcileInventoryLevelsStep(
      transform({ rows, input }, (data) => ({
        rows: data.rows,
        integration_id: data.input.integration_id,
        stock_location_id: data.input.stock_location_id,
        stock_reconcile_mode: data.input.stock_reconcile_mode,
      }))
    )

    return new WorkflowResponse(result)
  }
)

export default syncOngoingInventoryWorkflow

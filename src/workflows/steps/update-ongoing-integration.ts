import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { StockReconcileMode } from "../../lib/ongoing/types"

export type UpdateOngoingIntegrationInput = {
  id: string
  enabled?: boolean
  stock_sync_enabled?: boolean
  stock_sync_interval?: string | null
  status_poll_interval?: string | null
  stock_reconcile_mode?: StockReconcileMode
  edit_sync_rules?: Record<string, unknown> | null
  shipped_status_codes?: number[] | null
  cancellable_status_codes?: number[] | null
}

type PreviousIntegrationState = {
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

export type UpdateOngoingIntegrationCompensation = {
  id: string
  previous: PreviousIntegrationState
}

export const updateOngoingIntegrationHandler = async (
  input: UpdateOngoingIntegrationInput,
  { container }: { container: any }
): Promise<StepResponse<Record<string, unknown>, UpdateOngoingIntegrationCompensation>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any
  const existing = await ongoing.retrieveOngoingIntegration(input.id)
  const previous: PreviousIntegrationState = {
    enabled: existing.enabled,
    stock_sync_enabled: existing.stock_sync_enabled,
    stock_sync_interval: existing.stock_sync_interval,
    status_poll_interval: existing.status_poll_interval,
    stock_reconcile_mode: existing.stock_reconcile_mode,
    edit_sync_rules: existing.edit_sync_rules,
    shipped_status_codes: existing.shipped_status_codes,
    cancellable_status_codes: existing.cancellable_status_codes,
  }

  const updated = await ongoing.updateOngoingIntegrations(input)
  return new StepResponse(updated, { id: input.id, previous })
}

// This compensation is currently unreachable: updateOngoingIntegrationWorkflow
// (src/workflows/update-ongoing-integration.ts) is a single terminal step, and
// Medusa saga semantics only run a step's compensation when a LATER step in
// the same workflow fails — never when the step itself throws. It is kept
// intentionally (not removed) as defense-in-depth in case a step is ever
// appended after this one in that workflow, at which point it would become
// live. This differs from deleteOngoingIntegrationStep
// (src/workflows/steps/delete-ongoing-integration.ts), which omits
// compensation entirely rather than defining an unreachable one — delete has
// no restorable prior state at all, so there is nothing a compensation could
// ever restore, reachable or not.
export const compensateOngoingIntegrationHandler = async (
  compensation: UpdateOngoingIntegrationCompensation | undefined,
  { container }: { container: any }
): Promise<void> => {
  if (!compensation) {
    return
  }
  const ongoing = container.resolve(ONGOING_MODULE) as any
  await ongoing.updateOngoingIntegrations({ id: compensation.id, ...compensation.previous })
}

export const updateOngoingIntegrationStep = createStep(
  "update-ongoing-integration",
  updateOngoingIntegrationHandler,
  compensateOngoingIntegrationHandler
)

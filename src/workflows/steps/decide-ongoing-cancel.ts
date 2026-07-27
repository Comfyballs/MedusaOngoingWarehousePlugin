import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type DecideCancelInput = {
  medusa_order_id?: string
  medusa_fulfillment_id?: string
  ongoing_order_number?: string
}

export type CancelDecisionReason =
  | "ok"
  | "status_unknown_attempt"
  | "no_sync_row"
  | "already_cancelled"
  | "no_ongoing_order_id"
  | "status_not_cancellable"

export type CancelDecision = {
  shouldCancel: boolean
  reason: CancelDecisionReason
  orderSyncId?: string
  ongoingOrderId?: number
  credentialKey?: string
  // Operator-facing explanation, set only when reason is "status_not_cancellable".
  refusedReason?: string
}

// Every branch pins sync_kind:"order" (8p8): return rows now live in this ledger
// (sync_kind="return") keyed by their returnOrderNumber / return fulfillment id /
// original order id. Without this filter, canceling an order (order-canceled.ts) or a
// return fulfillment (fulfillment-canceled.ts) would resolve a return row, DELETE the
// RETURN order in Ongoing, and flip the return ledger row to "cancelled" while emitting
// a bogus ORDER_CANCELLED. Only outbound order rows are cancellable through this workflow.
function buildFilter(input: DecideCancelInput): Record<string, string> {
  if (input.ongoing_order_number) {
    return { ongoing_order_number: input.ongoing_order_number, sync_kind: "order" }
  }
  if (input.medusa_fulfillment_id) {
    return { medusa_fulfillment_id: input.medusa_fulfillment_id, sync_kind: "order" }
  }
  if (input.medusa_order_id) {
    return { medusa_order_id: input.medusa_order_id, sync_kind: "order" }
  }
  // lgs: with none of the three lookup keys we cannot build a scoped filter. Never
  // fall through to `{}` — listOngoingOrderSyncs({}) returns EVERY sync row (across
  // credential keys and both sync_kinds), and syncs?.[0] could then pick an unrelated
  // row — including a sync_kind="return" row, the exact leak class 8p8 closed for the
  // populated paths. Both callers always populate at least one key today, so reaching
  // here is a caller-contract violation: fail loud rather than silently mis-resolve.
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "decide-ongoing-cancel requires at least one of ongoing_order_number, medusa_fulfillment_id, or medusa_order_id"
  )
}

export const decideOngoingCancelHandler = async (
  input: DecideCancelInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<CancelDecision>> => {
    const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

    const filter = buildFilter(input)
    const syncs = await ongoing.listOngoingOrderSyncs(filter)
    const sync = syncs?.[0]

    if (!sync) {
      return new StepResponse({ shouldCancel: false, reason: "no_sync_row" })
    }

    if (sync.sync_state === "cancelled") {
      return new StepResponse({
        shouldCancel: false,
        reason: "already_cancelled",
        orderSyncId: sync.id,
      })
    }

    if (sync.ongoing_order_id === null || sync.ongoing_order_id === undefined) {
      return new StepResponse({
        shouldCancel: false,
        reason: "no_ongoing_order_id",
        orderSyncId: sync.id,
      })
    }

    const [integration] = await ongoing.listOngoingIntegrations({
      id: sync.integration_id,
    })

    const raw = integration?.cancellable_status_codes
    const codes: number[] = Array.isArray(raw) ? raw : []
    const status = sync.latest_status_code
    const statusKnown = status !== null && status !== undefined

    // M2: latest_status_code is NULL until the status-poll milestone (M3/M4).
    // When the status is unknown, ATTEMPT the cancel — the DELETE + terminal-4xx
    // swallow (cancel step) gives idempotent safety. The strict
    // cancellable_status_codes gate only applies once the status is known.
    if (statusKnown && !codes.includes(status)) {
      const statusLabel = sync.latest_status_text
        ? `${status} (${sync.latest_status_text})`
        : `${status}`
      return new StepResponse({
        shouldCancel: false,
        reason: "status_not_cancellable",
        orderSyncId: sync.id,
        refusedReason: `Ongoing status ${statusLabel} is not in cancellable_status_codes — the Ongoing order was not cancelled and may still ship. Reconcile it in Ongoing.`,
      })
    }

    return new StepResponse({
      shouldCancel: true,
      reason: statusKnown ? "ok" : "status_unknown_attempt",
      orderSyncId: sync.id,
      ongoingOrderId: sync.ongoing_order_id,
      credentialKey: integration?.credential_key,
    })
}

export const decideOngoingCancelStep = createStep(
  "decide-ongoing-cancel",
  decideOngoingCancelHandler
)

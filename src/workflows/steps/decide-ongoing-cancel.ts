import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
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
}

function buildFilter(input: DecideCancelInput): Record<string, string> {
  if (input.ongoing_order_number) {
    return { ongoing_order_number: input.ongoing_order_number }
  }
  if (input.medusa_fulfillment_id) {
    return { medusa_fulfillment_id: input.medusa_fulfillment_id }
  }
  if (input.medusa_order_id) {
    return { medusa_order_id: input.medusa_order_id }
  }
  return {}
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
      return new StepResponse({
        shouldCancel: false,
        reason: "status_not_cancellable",
        orderSyncId: sync.id,
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

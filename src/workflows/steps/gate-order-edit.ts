import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type OrderEditCategory = "address_contact" | "line_items"

export type GateInput = {
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  order_sync_id?: string
  category: OrderEditCategory
}

export type GateDecision = {
  allowed: boolean
  reason: string
  order_sync_id?: string
  integration_id?: string
  ongoing_order_number?: string
  latest_status_code?: number | null
  medusa_order_id: string
  medusa_fulfillment_id?: string | null
  category: OrderEditCategory
}

type SyncRow = {
  id: string
  integration_id: string
  ongoing_order_number: string
  latest_status_code: number | null
  medusa_fulfillment_id?: string | null
}

type IntegrationRow = {
  edit_sync_rules: Record<string, number[]> | null
}

/**
 * Pure gate decision. Exported for direct unit testing (no container needed).
 * Blocked unless the sync row + integration exist, the integration has
 * edit_sync_rules for the category, the order's cached latest_status_code is
 * known, and that code is in the allow list for the edit category.
 */
export function decideOrderEditGate(args: {
  input: GateInput
  sync?: SyncRow
  integration?: IntegrationRow
}): GateDecision {
  const { input, sync, integration } = args
  const base = {
    medusa_order_id: input.medusa_order_id,
    medusa_fulfillment_id: input.medusa_fulfillment_id,
    category: input.category,
  }

  if (!sync) {
    return { allowed: false, reason: "no_sync_row", ...base }
  }

  const carried = {
    order_sync_id: sync.id,
    integration_id: sync.integration_id,
    ongoing_order_number: sync.ongoing_order_number,
    latest_status_code: sync.latest_status_code,
    ...base,
    // The sync row's own fulfillment id is AUTHORITATIVE for the re-query: the gate
    // may be entered by order id (no input fulfillment id), but the upsert must
    // re-query the fulfillment that was originally pushed. Prefer the row, fall back
    // to the input so the two steps never disagree.
    medusa_fulfillment_id: sync.medusa_fulfillment_id ?? input.medusa_fulfillment_id,
  }

  const rules = integration?.edit_sync_rules
  if (!rules) {
    return { allowed: false, reason: "no_edit_rules", ...carried }
  }

  if (sync.latest_status_code === null || sync.latest_status_code === undefined) {
    return { allowed: false, reason: "status_unknown", ...carried }
  }

  const allowedCodes = rules[input.category] ?? []
  if (!allowedCodes.includes(sync.latest_status_code)) {
    return { allowed: false, reason: "status_blocked", ...carried }
  }

  return { allowed: true, reason: "allowed", ...carried }
}

export const gateOrderEditStep = createStep(
  // eslint-disable-next-line @medusajs/step-id-kebab-case -- the rule wants the id to match the exported step's kebab-cased name; we keep the explicit `ongoing-` prefix so this plugin's steps stay greppable in the host app's combined workflow-execution logs. Renaming is safe (these steps use no async/compensation/persisted transaction state), but the prefix is kept intentionally.
  "ongoing-gate-order-edit",
  async (input: GateInput, { container }) => {
    const service = container.resolve(ONGOING_MODULE) as {
      listOngoingOrderSyncs: (filters: Record<string, unknown>) => Promise<SyncRow[]>
      retrieveOngoingIntegration: (id: string) => Promise<IntegrationRow>
    }

    // Three-way priority (#72): the sync row's own id is authoritative and resolves
    // to exactly one row, so multi-row null-fulfillment orders never collapse to
    // row[0]. Fall back to fulfillment id (#31/#54), then order id (last resort).
    const filters: Record<string, unknown> = input.order_sync_id
      ? { id: input.order_sync_id }
      : input.medusa_fulfillment_id
        ? { medusa_fulfillment_id: input.medusa_fulfillment_id }
        : { medusa_order_id: input.medusa_order_id }

    const [sync] = await service.listOngoingOrderSyncs(filters)
    const integration = sync
      ? await service.retrieveOngoingIntegration(sync.integration_id)
      : undefined

    const decision = decideOrderEditGate({ input, sync, integration })
    return new StepResponse(decision)
  }
)

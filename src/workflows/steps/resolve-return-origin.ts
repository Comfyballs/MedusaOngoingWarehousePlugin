import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type ResolveReturnOriginInput = {
  // One of the return fulfillment's items' `line_item_id` — a return fulfillment (as
  // handed to the provider) carries no direct `order_id`, only line items pointing back
  // at the ORIGINAL order's line items (see re-query-return-fulfillment.ts). Nullable
  // because it's threaded through from the queried return fulfillment's (possibly empty)
  // item list.
  line_item_id: string | null
}

export type ResolveReturnOriginOutput = {
  medusa_order_id: string
  display_id: number
  // The original outbound OngoingOrderSync row this return belongs to.
  ongoing_order_sync_id: string
  ongoing_order_id: number
}

type OngoingOrderSyncRow = {
  id: string
  ongoing_order_id: number | null
  sync_state: "pending" | "sent" | "shipped" | "delivered" | "cancelled" | "error"
  last_synced_at: Date | string | null
}

// Exported handler so the step can be unit-tested directly (the createStep wrapper does
// not expose its invoke fn).
export async function resolveReturnOriginHandler(
  input: ResolveReturnOriginInput,
  { container }: { container: MedusaContainer }
): Promise<ResolveReturnOriginOutput> {
  const lineItemId = input.line_item_id
  if (!lineItemId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] cannot resolve the original order for a return: the return fulfillment has no items"
    )
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // Same-module relation filter (order.items is native to the order module) —
  // resolves the ORIGINAL Medusa order from one of the return's line_item_ids.
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id"],
    filters: { items: { id: lineItemId } },
  })

  const order = orders[0]
  if (!order) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] cannot resolve the original order for return line_item "${lineItemId}"`
    )
  }

  const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
  // sync_kind:"order" is essential (8p8): return pushes now write their OWN
  // OngoingOrderSync rows (sync_kind="return") under this same medusa_order_id,
  // with a fresh last_synced_at and the RETURN order's id in ongoing_order_id.
  // Without this filter the 2nd+ return on an order would resolve a prior return
  // row as its origin and send the wrong customerOrder.orderId to Ongoing. Only
  // outbound order rows are valid return origins.
  const rows: OngoingOrderSyncRow[] = await service.listOngoingOrderSyncs(
    { medusa_order_id: order.id, sync_kind: "order" },
    { order: { last_synced_at: "DESC" } }
  )

  // A return can only be pushed once the ORIGINAL order actually reached Ongoing
  // (sent) or has already shipped there — pick the most recently synced row in
  // either state that carries a usable ongoing_order_id. Rows still `pending`,
  // `error`, or `cancelled` are not eligible origins.
  const origin = rows.find(
    (r) => (r.sync_state === "shipped" || r.sync_state === "sent") && typeof r.ongoing_order_id === "number"
  )

  if (!origin || typeof origin.ongoing_order_id !== "number") {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] order "${order.id}" has no sent/shipped Ongoing order to return against ` +
        `(cannot resolve customerOrder.orderId for the return)`
    )
  }

  return {
    medusa_order_id: order.id,
    display_id: order.display_id,
    ongoing_order_sync_id: origin.id,
    ongoing_order_id: origin.ongoing_order_id,
  }
}

export const resolveReturnOriginStep = createStep(
  "resolve-return-origin",
  async (input: ResolveReturnOriginInput, context) => {
    const output = await resolveReturnOriginHandler(input, context)
    return new StepResponse(output)
  }
)

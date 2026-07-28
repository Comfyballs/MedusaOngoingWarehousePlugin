import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../../../../../modules/ongoing"

export type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: "pending" | "sent" | "shipped" | "delivered" | "cancelled" | "error"
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | Date | null
  last_error: string | null
  retry_count: number
  shipped_at: string | Date | null
  edit_blocked_at: string | Date | null
  edit_blocked_category: "address_contact" | "line_items" | null
  edit_blocked_reason: string | null
  cancel_refused_at: string | Date | null
  cancel_refused_reason: string | null
}

export type OngoingOrderSyncTracking = {
  tracking_number: string
  tracking_url: string | null
}

export type OngoingOrderSyncWithTracking = OngoingOrderSyncRow & {
  tracking: OngoingOrderSyncTracking[]
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    medusa_order_id: string
    sync_kind?: "order" | "return"
  }) => Promise<OngoingOrderSyncRow[]>
}

type QueryLike = {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }) => Promise<{
    data: Array<{
      id: string
      labels?: Array<{ tracking_number: string | null; tracking_url: string | null }>
    }>
  }>
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  // Only outbound order rows: the order-detail widget's Re-push button runs the
  // ORDER push, which would be wrong for a return row (8p8 stores return pushes in
  // this same ledger keyed by the original order id). Return rows are still visible
  // and retryable via the syncs dashboard, whose bulk-retry routes through the
  // retry job's sync_kind-aware re-push.
  const syncs = await ongoing.listOngoingOrderSyncs({
    medusa_order_id: req.params.orderId,
    sync_kind: "order",
  })

  if (syncs.length === 0) {
    res.status(200).json({ syncs: [] })
    return
  }

  const fulfillmentIds = Array.from(
    new Set(
      syncs
        .map((s) => s.medusa_fulfillment_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  )

  const trackingByFulfillment = new Map<string, OngoingOrderSyncTracking[]>()

  if (fulfillmentIds.length > 0) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as QueryLike
    const { data } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "labels.tracking_number", "labels.tracking_url"],
      filters: { id: fulfillmentIds },
    })

    for (const fulfillment of data) {
      const tracking = (fulfillment.labels ?? [])
        .filter(
          (label): label is { tracking_number: string; tracking_url: string | null } =>
            typeof label.tracking_number === "string" && label.tracking_number.length > 0
        )
        .map((label) => ({
          tracking_number: label.tracking_number,
          tracking_url: label.tracking_url || null,
        }))
      trackingByFulfillment.set(fulfillment.id, tracking)
    }
  }

  const enriched: OngoingOrderSyncWithTracking[] = syncs.map((s) => ({
    ...s,
    tracking: s.medusa_fulfillment_id
      ? trackingByFulfillment.get(s.medusa_fulfillment_id) ?? []
      : [],
  }))

  res.status(200).json({ syncs: enriched })
}

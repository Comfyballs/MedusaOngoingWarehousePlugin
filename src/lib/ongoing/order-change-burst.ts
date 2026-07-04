// Shared burst-window helpers for classifying Medusa `order_change` rows
// produced by `updateOrderWorkflow`. Medusa's OrderModuleService.registerOrderChange_
// inserts ONE order_change DB row per changed field via a single
// `orderChangeService_.create(array)` call
// (node_modules/@medusajs/order/dist/services/order-module-service.js:1223-1242,
// confirmed against Medusa 2.16.0 core source in issue #110's review) — never one row
// with multiple actions. Consumers must union detail types across all rows created in
// the same updateOrderWorkflow call ("burst"), not read a single row (issue #110).

// spec §13.3 — verify this set against a live update_order order-change during
// integration testing.
export const ADDRESS_CONTACT_DETAIL_TYPES = new Set([
  "shipping_address",
  "billing_address",
  "email",
  "contact",
])

// updateOrderWorkflow
// (node_modules/@medusajs/core-flows/dist/order/workflows/update-order.js:125-193,
// Medusa 2.16.0) pushes at most 5 change entries per call today (shipping_address,
// billing_address, email, metadata, locale). take:20 gives generous headroom for future
// Medusa versions adding more per-call update fields without missing any row in a burst.
export const ORDER_CHANGE_BURST_QUERY_LIMIT = 20

// All rows from one updateOrderWorkflow call are inserted via a single
// orderChangeService_.create(array) call (one INSERT batch), so their created_at values
// are generated within, at most, a handful of synchronous JS statements of each other —
// well under a second in practice. 2s is a generous safety margin against clock/ORM
// jitter while still excluding a genuinely separate, later admin edit on the same order.
export const ORDER_CHANGE_BURST_WINDOW_MS = 2000

export type OrderChangeActionRow = {
  id?: string
  created_at: string | Date
  actions?: Array<{ id?: string; details?: { type?: string } }> | null
}

// Given order_change rows already sorted `created_at DESC` (as returned by
// `query.graph`'s `order: { created_at: "DESC" }`), returns the deduped union of
// `actions[].details.type` across every row within `burstWindowMs` of the newest row —
// i.e. every field changed by the single updateOrderWorkflow call that fired this
// order.updated event, not just whichever row a `take: 1` query happened to return (#110).
export function deriveBurstChangedTypes(
  changes: OrderChangeActionRow[] | null | undefined,
  burstWindowMs: number = ORDER_CHANGE_BURST_WINDOW_MS
): string[] {
  const rows = changes ?? []
  const newest = rows[0]
  if (!newest) {
    return []
  }
  const newestTime = new Date(newest.created_at).getTime()

  const types = new Set<string>()
  for (const row of rows) {
    const rowTime = new Date(row.created_at).getTime()
    if (newestTime - rowTime > burstWindowMs) {
      continue
    }
    for (const action of row.actions ?? []) {
      const type = action?.details?.type
      if (typeof type === "string") {
        types.add(type)
      }
    }
  }
  return [...types]
}

export function hasAddressContactChange(changedTypes: string[]): boolean {
  return changedTypes.some((t) => ADDRESS_CONTACT_DETAIL_TYPES.has(t))
}

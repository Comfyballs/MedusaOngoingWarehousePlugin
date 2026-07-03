import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import orderUpdatedHandler from "../subscribers/order-updated"
import {
  ORDER_CHANGE_BURST_WINDOW_MS,
  deriveBurstChangedTypes,
  hasAddressContactChange,
} from "../lib/ongoing/order-change-burst"

// One-off data-repair script for #110: before the fix, order-updated.ts's
// `take: 1` order_change query could silently drop a real address/contact
// change bundled with another field edit (locale/metadata/etc.) in the same
// updateOrderWorkflow call, so the order's OngoingOrderSync row(s) were never
// re-synced. This scans recent `update_order` order_change history, finds
// every order whose burst *could* have hit that bug (>=2 rows in one burst,
// including an address/contact type — we cannot know in hindsight which row
// the DB's take:1 query actually returned, so every such burst is treated as
// a candidate), and replays the now-fixed order-updated subscriber against
// each one. Replaying is safe to run more than once: orderUpdatedHandler
// re-derives the current changedTypes and re-gates on edit_sync_rules /
// latest_status_code exactly as it would for a live event, so an order that
// turns out not to be affected (or is no longer allowed to sync) is a no-op.
//
// Usage: copy this file into a consuming Medusa app's own `src/scripts/` (or
// point at `.medusa/server/src/scripts/resync-dropped-address-changes.js`
// inside this plugin's package once built) and run:
//   npx medusa exec ./src/scripts/resync-dropped-address-changes.ts [--since-days=90] [--dry-run]

export type OrderChangeRow = {
  id: string
  order_id: string
  created_at: string | Date
  actions?: Array<{ id?: string; details?: { type?: string } }> | null
}

const DEFAULT_SINCE_DAYS = 90
const PAGE_SIZE = 500

function parseArgs(args: string[]): { sinceDays: number; dryRun: boolean } {
  const sinceDaysArg = args.find((a) => a.startsWith("--since-days="))
  const parsed = sinceDaysArg ? parseInt(sinceDaysArg.split("=")[1], 10) : NaN
  const sinceDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SINCE_DAYS
  const dryRun = args.includes("--dry-run")
  return { sinceDays, dryRun }
}

// Groups already-fetched order_change rows (any order's update_order history)
// into per-order bursts using the same window as the production fix
// (deriveBurstChangedTypes), and returns the order_ids where at least one
// burst both (a) has more than one row and (b) its unioned changedTypes
// include an address/contact type.
export function findCandidateOrderIds(rows: OrderChangeRow[]): string[] {
  const byOrder = new Map<string, OrderChangeRow[]>()
  for (const row of rows) {
    const list = byOrder.get(row.order_id) ?? []
    list.push(row)
    byOrder.set(row.order_id, list)
  }

  const candidates = new Set<string>()
  for (const [orderId, orderRows] of byOrder) {
    // Sort DESC by created_at to match deriveBurstChangedTypes's contract.
    const sorted = [...orderRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    let burst: OrderChangeRow[] = []
    const flushBurst = () => {
      if (burst.length > 1 && hasAddressContactChange(deriveBurstChangedTypes(burst))) {
        candidates.add(orderId)
      }
      burst = []
    }
    for (const row of sorted) {
      if (burst.length === 0) {
        burst.push(row)
        continue
      }
      const burstNewestTime = new Date(burst[0].created_at).getTime()
      const rowTime = new Date(row.created_at).getTime()
      if (burstNewestTime - rowTime <= ORDER_CHANGE_BURST_WINDOW_MS) {
        burst.push(row)
      } else {
        flushBurst()
        burst.push(row)
      }
    }
    flushBurst()
  }
  return [...candidates]
}

export default async function resyncDroppedAddressChanges({
  container,
  args,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { sinceDays, dryRun } = parseArgs(args)
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

  logger.info(
    `[ongoing] resync-dropped-address-changes: scanning update_order order_change rows since ${sinceDate.toISOString()}${dryRun ? " (dry run)" : ""}`
  )

  const rows: OrderChangeRow[] = []
  let skip = 0
  for (;;) {
    const { data } = await query.graph({
      entity: "order_change",
      fields: ["id", "order_id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        change_type: "update_order",
        created_at: { $gte: sinceDate.toISOString() },
      },
      pagination: { take: PAGE_SIZE, skip, order: { created_at: "DESC" } },
    })
    rows.push(...(data as OrderChangeRow[]))
    if (!data || data.length < PAGE_SIZE) {
      break
    }
    skip += PAGE_SIZE
  }

  const candidateOrderIds = findCandidateOrderIds(rows)
  logger.info(
    `[ongoing] resync-dropped-address-changes: found ${candidateOrderIds.length} candidate order(s)`
  )

  if (dryRun) {
    for (const orderId of candidateOrderIds) {
      logger.info(
        `[ongoing] resync-dropped-address-changes: (dry run) would replay order.updated for ${orderId}`
      )
    }
    return
  }

  for (const orderId of candidateOrderIds) {
    await orderUpdatedHandler({
      event: { name: "order.updated", data: { id: orderId } },
      container,
      pluginOptions: {},
    })
  }

  logger.info(
    `[ongoing] resync-dropped-address-changes: replayed order.updated for ${candidateOrderIds.length} order(s)`
  )
}

import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { ONGOING_EVENTS } from "../lib/ongoing/events"

// ChangeActionType values that order-edit.confirmed carries: only line-item /
// shipping mutations appear on this event (address/contact/email go through
// order.updated -> #54). We classify any of these as the spec §8 "line_items"
// edit category. See spec §13.3 — verify this set against a live order-edit
// during integration testing; the exact enum strings are ITEM_*/SHIPPING_*.
const LINE_ITEM_ACTION_TYPES = new Set<string>([
  "ITEM_ADD",
  "ITEM_UPDATE",
  "ITEM_REMOVE",
  "SHIPPING_ADD",
  "SHIPPING_UPDATE",
  "SHIPPING_REMOVE",
])

type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  integration_id: string
  latest_status_code: number | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    medusa_order_id: string
  }) => Promise<OngoingOrderSyncRow[]>
  retrieveOngoingIntegration: (
    id: string
  ) => Promise<{ edit_sync_rules: Record<string, number[]> | null } | null>
}

type OrderChangeAction = { action?: string }

export default async function orderEditConfirmedHandler({
  event,
  container,
}: SubscriberArgs<{ order_id: string; actions: OrderChangeAction[] }>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = event.data.order_id

  try {
    // 1. Classify the edit from actions[] (carried directly on the event).
    //    order-edit.confirmed only contains ITEM_*/SHIPPING_* actions; we keep
    //    this filter defensive so unexpected action types are ignored.
    const actions = event.data.actions ?? []
    const hasLineItemChange = actions.some(
      (a) => typeof a?.action === "string" && LINE_ITEM_ACTION_TYPES.has(a.action)
    )

    if (!hasLineItemChange) {
      const seen = actions.map((a) => a?.action).filter(Boolean).join(", ")
      logger.info(
        `[ongoing] order-edit.confirmed for ${orderId}: no line-item/shipping change (actions: ${seen || "none"}), skipping`
      )
      return
    }

    // 2. Resolve the OngoingOrderSync rows for this order (0..N, one per fulfillment).
    const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike
    const syncRows: OngoingOrderSyncRow[] = await service.listOngoingOrderSyncs({
      medusa_order_id: orderId,
    })

    if (!syncRows.length) {
      logger.info(`[ongoing] order-edit.confirmed for ${orderId}: no sync rows, skipping`)
      return
    }

    const eventBus = container.resolve(Modules.EVENT_BUS)

    const emitBlocked = (row: OngoingOrderSyncRow) =>
      eventBus.emit({
        name: ONGOING_EVENTS.EDIT_BLOCKED,
        data: {
          medusa_order_id: orderId,
          ongoing_order_sync_id: row.id,
          category: "line_items",
          latest_status_code: row.latest_status_code,
        },
      })

    // 3. For each sync row, gate on edit_sync_rules.line_items and re-sync.
    //    Each row is isolated: a failure on one fulfillment never drops the
    //    re-sync of the others (matches order-canceled.ts), and the handler
    //    still never throws (outer catch is the backstop).
    for (const row of syncRows) {
      try {
        const integration = await service.retrieveOngoingIntegration(row.integration_id)
        const rules: Record<string, number[]> | null = integration?.edit_sync_rules ?? null
        const allowedCodes = rules?.line_items ?? []
        const code = row.latest_status_code

        const allowed =
          code !== null && code !== undefined && allowedCodes.includes(code)

        if (!allowed) {
          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await emitBlocked(row)
          continue
        }

        // The workflow re-gates against the latest snapshot (per fulfillment) and
        // is the source of truth: honour its decision so a row the workflow blocks
        // is reported as blocked, never as a false success.
        const { result } = await syncOrderEditToOngoing(container).run({
          input: {
            medusa_order_id: orderId,
            medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
            order_sync_id: row.id,
            category: "line_items",
          },
        })

        if (result?.blocked) {
          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items re-sync blocked by workflow for sync ${row.id} (reason: ${result.reason})`
          )
          await emitBlocked(row)
          continue
        }

        logger.info(
          `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
        )
      } catch (error) {
        // Subscribers never throw (spec §8): log this row and keep going.
        const message = error instanceof Error ? error.message : String(error)
        logger.error(
          `[ongoing] order-edit.confirmed handler failed for ${orderId} (sync ${row.id}): ${message}`
        )
      }
    }
  } catch (error) {
    // Backstop so the handler never throws (spec §8) on errors outside the loop.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      `[ongoing] order-edit.confirmed handler failed for ${orderId}: ${message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order-edit.confirmed",
}

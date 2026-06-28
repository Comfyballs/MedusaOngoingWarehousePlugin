import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"

// Order-change action detail types (set by Medusa's updateOrderWorkflow) that we
// classify as the spec §8 "address_contact" edit category. See spec §13.3 — verify
// this set against a live `update_order` order-change during integration testing.
const ADDRESS_CONTACT_DETAIL_TYPES = new Set([
  "shipping_address",
  "billing_address",
  "email",
  "contact",
])

type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  latest_status_code: number | null
  medusa_fulfillment_id: string | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (
    filter: { medusa_order_id: string },
    config?: { select?: string[] }
  ) => Promise<OngoingOrderSyncRow[]>
}

export default async function orderUpdatedHandler({
  event,
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = event.data.id

  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // 1. Inspect the latest update_order order-change to see what changed.
    //    Payload carries only { id }, so we re-query. We read the actions'
    //    details.type and keep only address/contact/email changes.
    const { data: changes } = await query.graph({
      entity: "order_change",
      fields: ["id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        order_id: orderId,
        change_type: "update_order",
      },
      pagination: {
        take: 1,
        order: { created_at: "DESC" },
      },
    })

    const latestChange = changes?.[0]
    const changedTypes: string[] = (latestChange?.actions ?? [])
      .map((a: { details?: { type?: string } }) => a?.details?.type)
      .filter((t: unknown): t is string => typeof t === "string")

    const hasAddressContactChange = changedTypes.some((t) =>
      ADDRESS_CONTACT_DETAIL_TYPES.has(t)
    )

    if (!hasAddressContactChange) {
      logger.info(
        `[ongoing] order.updated for ${orderId}: no address/contact/email change (types: ${changedTypes.join(", ") || "none"}), skipping`
      )
      return
    }

    // 2. Resolve the OngoingOrderSync rows for this order (0..N).
    const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike
    const syncRows: OngoingOrderSyncRow[] = await service.listOngoingOrderSyncs(
      { medusa_order_id: orderId },
      {
        // medusa_fulfillment_id is required for per-row targeting of #27's gate
        // workflow (passed as input.medusa_fulfillment_id, mirroring #31).
        select: [
          "id",
          "integration_id",
          "latest_status_code",
          "medusa_fulfillment_id",
        ],
      }
    )

    if (!syncRows.length) {
      logger.info(`[ongoing] order.updated for ${orderId}: no sync rows, skipping`)
      return
    }

    // 3. Load the edit_sync_rules for the integrations referenced by the rows.
    const integrationIds = [...new Set(syncRows.map((r) => r.integration_id))]
    const { data: integrations } = await query.graph({
      entity: "ongoing_integration",
      fields: ["id", "edit_sync_rules"],
      filters: { id: integrationIds },
    })
    const rulesByIntegration = new Map<string, Record<string, number[]> | null>(
      (integrations ?? []).map(
        (i: { id: string; edit_sync_rules?: Record<string, number[]> | null }) => [
          i.id,
          i.edit_sync_rules ?? null,
        ]
      )
    )

    const eventBus = container.resolve(Modules.EVENT_BUS)

    // 4. For each sync row, gate on edit_sync_rules.address_contact and re-sync.
    //    Each row is isolated in its own try/catch so one row's failure never
    //    aborts the rest (spec §8: subscribers complete gracefully per row).
    for (const row of syncRows) {
      try {
        const rules = rulesByIntegration.get(row.integration_id)
        const allowedCodes = rules?.address_contact ?? []
        const code = row.latest_status_code

        const allowed =
          code !== null && code !== undefined && allowedCodes.includes(code)

        if (!allowed) {
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await eventBus.emit({
            name: "ongoing.sync.edit_blocked",
            data: {
              medusa_order_id: orderId,
              ongoing_order_sync_id: row.id,
              category: "address_contact",
              latest_status_code: code,
            },
          })
          continue
        }

        const { result } = await syncOrderEditToOngoing(container).run({
          input: {
            medusa_order_id: orderId,
            // Per-row targeting via fulfillment id (mirrors #31); #27 ignores
            // ongoing_order_sync_id, so passing it would mis-target multi-row orders.
            medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
            category: "address_contact",
          },
        })

        // The workflow re-gates internally (gateOrderEditStep). Report what it
        // actually did rather than assuming success, so the log never lies if the
        // workflow's own gate blocked (e.g. status changed between query and gate).
        if (result?.synced) {
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
        } else {
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact re-sync not applied for sync ${row.id} (workflow: ${result?.reason ?? "unknown"})`
          )
        }
      } catch (rowError) {
        // Never throw from a subscriber; isolate the failure to this row.
        const rowMessage =
          rowError instanceof Error ? rowError.message : String(rowError)
        logger.error(
          `[ongoing] order.updated for ${orderId}: failed to process sync ${row.id}: ${rowMessage}`
        )
      }
    }
  } catch (error) {
    // Subscribers never throw (spec §8): log + record, complete gracefully.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[ongoing] order.updated handler failed for ${orderId}: ${message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.updated",
}

import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IEventBusModuleService } from "@medusajs/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../workflows/mark-order-sync-edit-blocked"
import { ONGOING_EVENTS, type EditBlockedPayload } from "../lib/ongoing/events"
import { emitDomainEvent } from "../lib/ongoing/emit-domain-event"
import {
  ORDER_CHANGE_BURST_QUERY_LIMIT,
  deriveBurstChangedTypes,
  hasAddressContactChange,
} from "../lib/ongoing/order-change-burst"

type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  latest_status_code: number | null
  medusa_fulfillment_id: string | null
  edit_blocked_at: string | Date | null
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

    // 1. Inspect all update_order order-changes from the burst that fired this
    //    event. Payload carries only { id }, so we re-query. Medusa's
    //    registerOrderChange_ inserts ONE order_change row per changed field
    //    (never one row with multiple actions), so we union detail types across
    //    every row within the burst window, not just the newest row — otherwise
    //    an address change bundled with e.g. locale/metadata in the same
    //    updateOrderWorkflow call is silently dropped (#110).
    const { data: changes } = await query.graph({
      entity: "order_change",
      fields: ["id", "change_type", "created_at", "actions.id", "actions.details"],
      filters: {
        order_id: orderId,
        change_type: "update_order",
      },
      pagination: {
        take: ORDER_CHANGE_BURST_QUERY_LIMIT,
        order: { created_at: "DESC" },
      },
    })

    const changedTypes = deriveBurstChangedTypes(changes)

    if (!hasAddressContactChange(changedTypes)) {
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
          "edit_blocked_at",
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

    const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

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
          // Mirrors gate-order-edit.ts's decideOrderEditGate reason precedence
          // (no_edit_rules checked before status_unknown before status_blocked)
          // so the persisted reason vocabulary matches #27's gate exactly (#91).
          const reason = !rules
            ? "no_edit_rules"
            : code === null || code === undefined
              ? "status_unknown"
              : "status_blocked"

          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          // Persist first, then emit (#116): if the emit threw before the
          // workflow ran, the edit_blocked_* fields would never be written.
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: {
              order_sync_id: row.id,
              blocked: true,
              category: "address_contact",
              reason,
            },
          })
          await emitDomainEvent(
            eventBus,
            logger,
            ONGOING_EVENTS.EDIT_BLOCKED,
            {
              medusa_order_id: orderId,
              ongoing_order_sync_id: row.id,
              category: "address_contact",
              latest_status_code: code,
            } satisfies EditBlockedPayload,
            `order.updated order=${orderId} sync=${row.id}`
          )
          continue
        }

        const { result } = await syncOrderEditToOngoing(container).run({
          input: {
            medusa_order_id: orderId,
            // Per-row targeting by the sync row's own id (#72): order_sync_id is the
            // gate's primary key, with medusa_fulfillment_id as the secondary fallback.
            order_sync_id: row.id,
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
          // Clear a stale edit-blocked flag now that the edit re-synced. Guarded
          // on edit_blocked_at so never-blocked rows take no DB write. The step
          // nulls all three edit_blocked_* fields on blocked:false (#91). (#103)
          if (row.edit_blocked_at) {
            await markOrderSyncEditBlockedWorkflow(container).run({
              input: { order_sync_id: row.id, blocked: false },
            })
          }
        } else if (result?.blocked) {
          // Mirrors order-edit-confirmed.ts's post-workflow blocked branch: the
          // workflow's own gate is authoritative, so a row it blocks must be
          // persisted as blocked even though the subscriber's own pre-check
          // gate (above) allowed it — this is exactly the race #94 closes.
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact re-sync blocked by workflow for sync ${row.id} (reason: ${result.reason})`
          )
          // Persist first, then emit (#116).
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: {
              order_sync_id: row.id,
              blocked: true,
              category: "address_contact",
              reason: result.reason ?? "status_blocked",
            },
          })
          await emitDomainEvent(
            eventBus,
            logger,
            ONGOING_EVENTS.EDIT_BLOCKED,
            {
              medusa_order_id: orderId,
              ongoing_order_sync_id: row.id,
              category: "address_contact",
              latest_status_code: code,
            } satisfies EditBlockedPayload,
            `order.updated order=${orderId} sync=${row.id}`
          )
        } else {
          // Defensive fallback: result is present but neither synced nor
          // blocked (should not happen given SyncOrderEditResult's derivation
          // in sync-order-edit-to-ongoing.ts, but keep the prior behavior
          // rather than silently dropping an unrecognized shape).
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

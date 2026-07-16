import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer, IEventBusModuleService } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOngoingInventoryWorkflow } from "../workflows"
import { ONGOING_EVENTS } from "../lib/ongoing/events"
import type { InventorySyncedPayload } from "../lib/ongoing/events"

// Local structural types — no runtime import of the model class (mirrors status-poll.ts pattern).
type IntegrationRow = {
  id: string
  credential_key: string
  stock_location_id: string
  stock_sync_interval: string | null
  last_stock_sync_at: Date | string | null
  last_stock_delta_cursor: string | null
  last_full_stock_sync_at: Date | string | null
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

type OngoingServiceLike = {
  listOngoingIntegrations: (filter: {
    enabled: boolean
    stock_sync_enabled: boolean
  }) => Promise<IntegrationRow[]>
  getCredentials: (credentialKey: string) => { goodsOwnerId: number }
  getDefaultStockSyncIntervalMs: () => number
  acquireSyncLock: (integrationId: string, ttlMs: number) => Promise<boolean>
  releaseSyncLock: (integrationId: string) => Promise<void>
  updateOngoingIntegrations: (data: {
    id: string
    last_stock_sync_at?: Date
    last_stock_delta_cursor?: string
    last_full_stock_sync_at?: Date
  }) => Promise<unknown>
}

// How often to run a FULL (non-delta) sweep as a reconciliation fallback, so any stock
// change a delta tick might have missed (clock skew, a dropped webhook on Ongoing's side)
// self-heals. Between full sweeps, ticks pull only stockInfoChangedFrom deltas (bead sw8).
const FULL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

// stockInfoChangedFrom is evaluated by Ongoing against OUR timestamp, but the change times
// it compares against are stamped by ONGOING's clock. If our host clock runs ahead of
// Ongoing's, a change could fall just before the cursor we store and be skipped until the
// next full sweep. Rewinding the stored cursor by this buffer creates deliberate overlap
// that absorbs clock skew + in-flight latency; the reconcile is idempotent, so re-reading a
// few already-seen articles each tick is harmless (PR#135 review).
const DELTA_CURSOR_OVERLAP_MS = 120 * 1000 // 2 minutes

type Logger = {
  info: (message: string) => void
  warn?: (message: string) => void
  error: (message: string) => void
  debug?: (message: string) => void
}

function resolveStockSyncIntervalMs(
  service: OngoingServiceLike,
  integration: IntegrationRow
): number {
  if (integration.stock_sync_interval != null) {
    const parsed = parseInt(integration.stock_sync_interval, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return service.getDefaultStockSyncIntervalMs()
}

function isStockSyncDue(
  integration: IntegrationRow,
  intervalMs: number,
  now: number
): boolean {
  if (integration.last_stock_sync_at == null) {
    return true
  }
  const last = new Date(integration.last_stock_sync_at).getTime()
  return now - last >= intervalMs
}

// A full sweep runs when we've never delta-synced (no cursor), never full-swept, or the
// last full sweep is older than FULL_SWEEP_INTERVAL_MS; otherwise the tick pulls deltas.
function isFullSweepDue(integration: IntegrationRow, now: number): boolean {
  if (integration.last_stock_delta_cursor == null || integration.last_full_stock_sync_at == null) {
    return true
  }
  const lastFull = new Date(integration.last_full_stock_sync_at).getTime()
  return now - lastFull >= FULL_SWEEP_INTERVAL_MS
}

async function syncIntegration(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  now: number
): Promise<void> {
  const intervalMs = resolveStockSyncIntervalMs(service, integration)
  if (!isStockSyncDue(integration, intervalMs, now)) {
    return
  }

  const acquired = await service.acquireSyncLock(integration.id, intervalMs)
  if (!acquired) {
    logger.debug?.(
      `[ongoing] stock-sync: integration ${integration.id} is locked by another run, skipping`
    )
    return
  }

  const doFullSweep = isFullSweepDue(integration, now)
  // Anchor the next delta cursor to just BEFORE the fetch, minus an overlap buffer for clock
  // skew (see DELTA_CURSOR_OVERLAP_MS), so any stock change during the sync — or stamped by
  // Ongoing's slightly-behind clock — is re-caught next tick (at-least-once; reconcile is
  // idempotent). Advanced only on success below — never in the finally — so a failed tick
  // can't skip changes.
  const syncStartedAt = new Date(now - DELTA_CURSOR_OVERLAP_MS).toISOString()

  try {
    const { goodsOwnerId } = service.getCredentials(integration.credential_key)
    const { result } = await syncOngoingInventoryWorkflow(container).run({
      input: {
        integration_id: integration.id,
        credential_key: integration.credential_key,
        stock_location_id: integration.stock_location_id,
        goods_owner_id: goodsOwnerId,
        stock_reconcile_mode: integration.stock_reconcile_mode,
        changed_since: doFullSweep ? null : integration.last_stock_delta_cursor,
      },
    })
    // #37 returns { written, skipped } expressly for the dispatcher to log (operational visibility).
    logger.info(
      `[ongoing] stock-sync: integration ${integration.id} ${doFullSweep ? "full" : "delta"} sync reconciled ${result.written} level(s), skipped ${result.skipped}`
    )
    // Advance the delta cursor (and, on a full sweep, the full-sweep clock) only now that the
    // sync succeeded. Separate from the finally's last_stock_sync_at stamp, which records the
    // attempt regardless of outcome. A cursor-write failure is logged, not fatal — next tick
    // re-syncs from the old cursor (idempotent), so no stock change is lost.
    try {
      await service.updateOngoingIntegrations({
        id: integration.id,
        last_stock_delta_cursor: syncStartedAt,
        ...(doFullSweep ? { last_full_stock_sync_at: new Date() } : {}),
      })
    } catch (cursorErr) {
      logger.error(
        `[ongoing] stock-sync: failed to advance delta cursor for ${integration.id}: ${(cursorErr as Error).message}`
      )
    }
    const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
    // Best-effort emit: the reconcile above already ran to completion — an
    // event-bus outage here must not surface as an "integration failed" log for
    // an integration that actually synced successfully.
    try {
      await eventBus.emit({
        name: ONGOING_EVENTS.INVENTORY_SYNCED,
        data: {
          integration_id: integration.id,
          credential_key: integration.credential_key,
          stock_location_id: integration.stock_location_id,
          written: result.written,
          skipped: result.skipped,
        } satisfies InventorySyncedPayload,
      })
    } catch (emitErr) {
      logger.error(
        `[ongoing] stock-sync: failed to emit ${ONGOING_EVENTS.INVENTORY_SYNCED} for integration ${integration.id}: ${(emitErr as Error).message}`
      )
    }
  } finally {
    try {
      await service.updateOngoingIntegrations({
        id: integration.id,
        last_stock_sync_at: new Date(),
      })
    } catch (error) {
      logger.error(
        `[ongoing] stock-sync: failed to stamp last_stock_sync_at for ${integration.id}: ${
          (error as Error).message
        }`
      )
    }
    await service.releaseSyncLock(integration.id)
  }
}

export default async function ongoingStockSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let integrations: IntegrationRow[]
  try {
    integrations = await service.listOngoingIntegrations({
      enabled: true,
      stock_sync_enabled: true,
    })
  } catch (error) {
    logger.error(
      `[ongoing] stock-sync: failed to list integrations: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()
  for (const integration of integrations) {
    try {
      await syncIntegration(container, service, logger, integration, now)
    } catch (error) {
      logger.error(
        `[ongoing] stock-sync: integration ${integration.id} (${integration.credential_key}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one integration's failure must not kill the tick.
    }
  }
}

export const config = {
  name: "ongoing-stock-sync",
  schedule: "* * * * *",
}

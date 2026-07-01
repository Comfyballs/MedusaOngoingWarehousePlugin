import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOngoingInventoryWorkflow } from "../workflows"
import { ONGOING_EVENTS } from "../lib/ongoing/events"

// Local structural types — no runtime import of the model class (mirrors status-poll.ts pattern).
type IntegrationRow = {
  id: string
  credential_key: string
  stock_location_id: string
  stock_sync_interval: string | null
  last_stock_sync_at: Date | string | null
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
    last_stock_sync_at: Date
  }) => Promise<unknown>
}

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

  try {
    const { goodsOwnerId } = service.getCredentials(integration.credential_key)
    const { result } = await syncOngoingInventoryWorkflow(container).run({
      input: {
        integration_id: integration.id,
        credential_key: integration.credential_key,
        stock_location_id: integration.stock_location_id,
        goods_owner_id: goodsOwnerId,
        stock_reconcile_mode: integration.stock_reconcile_mode,
      },
    })
    // #37 returns { written, skipped } expressly for the dispatcher to log (operational visibility).
    logger.info(
      `[ongoing] stock-sync: integration ${integration.id} reconciled ${result.written} level(s), skipped ${result.skipped}`
    )
    const eventBus: any = container.resolve(Modules.EVENT_BUS)
    await eventBus.emit({
      name: ONGOING_EVENTS.INVENTORY_SYNCED,
      data: {
        integration_id: integration.id,
        credential_key: integration.credential_key,
        stock_location_id: integration.stock_location_id,
        written: result.written,
        skipped: result.skipped,
      },
    })
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

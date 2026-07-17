import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { refreshOngoingOrderStatusWorkflow, syncOngoingShipmentWorkflow } from "../workflows"

// Ongoing order-status sweep. Wide on purpose: the poll keeps latest_status_code
// fresh for order-edit gating AND detects shipment, so it must see every active
// order — not only shipped ones. 100 (preliminary) .. 999 spans Ongoing's active
// + shipped status range. (Spec §7.)
const ONGOING_ACTIVE_STATUS_FROM = 100
const ONGOING_ACTIVE_STATUS_TO = 999

// Sync states for which polling is finished: no further status refresh / shipment.
const TERMINAL_SYNC_STATES = new Set(["shipped", "cancelled"])

type TrackedOrder = {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
  tracking: { number: string; url?: string }[]
}

type OngoingClientLike = {
  getOrdersByStatus: (from: number, to: number) => Promise<TrackedOrder[]>
}

type IntegrationRow = {
  id: string
  credential_key: string
  status_poll_interval: string | null
  last_status_poll_at: Date | string | null
  shipped_status_codes: number[] | null
}

type OrderSyncRow = {
  id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | string | null
}

type OngoingServiceLike = {
  listOngoingIntegrations: (filter: { enabled: boolean }) => Promise<IntegrationRow[]>
  getClient: (credentialKey: string) => OngoingClientLike
  getDefaultStatusPollIntervalMs: () => number
  acquireSyncLock: (integrationId: string, ttlMs: number, lockName?: "status_poll") => Promise<boolean>
  releaseSyncLock: (integrationId: string, lockName?: "status_poll") => Promise<void>
  listOngoingOrderSyncs: (filter: { integration_id: string }) => Promise<OrderSyncRow[]>
  updateOngoingIntegrations: (data: { id: string; last_status_poll_at: Date }) => Promise<unknown>
}

type Logger = {
  info: (message: string) => void
  error: (message: string) => void
  debug?: (message: string) => void
}

function resolveIntervalMs(service: OngoingServiceLike, integration: IntegrationRow): number {
  if (integration.status_poll_interval != null) {
    const parsed = parseInt(integration.status_poll_interval, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return service.getDefaultStatusPollIntervalMs()
}

function isDue(integration: IntegrationRow, intervalMs: number, now: number): boolean {
  if (integration.last_status_poll_at == null) {
    return true
  }
  const last = new Date(integration.last_status_poll_at).getTime()
  return now - last >= intervalMs
}

async function pollAndApply(
  container: MedusaContainer,
  service: OngoingServiceLike,
  integration: IntegrationRow
): Promise<void> {
  const client = service.getClient(integration.credential_key)
  const orders = await client.getOrdersByStatus(
    ONGOING_ACTIVE_STATUS_FROM,
    ONGOING_ACTIVE_STATUS_TO
  )

  // Limit in-memory work to this integration's still-open tracked orders.
  const rows = await service.listOngoingOrderSyncs({ integration_id: integration.id })
  const tracked = new Map<string, OrderSyncRow>()
  for (const row of rows) {
    if (!TERMINAL_SYNC_STATES.has(row.sync_state)) {
      tracked.set(row.ongoing_order_number, row)
    }
  }

  const shippedCodes = Array.isArray(integration.shipped_status_codes)
    ? integration.shipped_status_codes
    : []

  for (const order of orders) {
    const row = tracked.get(order.orderNumber)
    if (!row) {
      continue
    }

    // Route the per-order status refresh through the same workflow the
    // out-of-band webhook path uses (bead jzm), rather than mutating the
    // module service directly (arch-workflow-required).
    await refreshOngoingOrderStatusWorkflow(container).run({
      input: {
        ongoing_order_number: order.orderNumber,
        integration_id: integration.id,
        status_code: order.statusNumber,
        status_text: order.statusText,
      },
    })

    if (shippedCodes.includes(order.statusNumber) && row.shipped_at == null) {
      // #33 owns the shipped_at idempotency re-check; a redundant call is a no-op.
      await syncOngoingShipmentWorkflow(container).run({
        input: {
          ongoing_order_number: order.orderNumber,
          status_code: order.statusNumber,
          status_text: order.statusText,
          tracking_numbers: order.trackingNumbers,
          tracking: order.tracking,
        },
      })
    }
  }
}

async function pollIntegration(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  now: number
): Promise<void> {
  const intervalMs = resolveIntervalMs(service, integration)
  if (!isDue(integration, intervalMs, now)) {
    return
  }

  const acquired = await service.acquireSyncLock(integration.id, intervalMs, "status_poll")
  if (!acquired) {
    logger.debug?.(
      `[ongoing] status-poll: integration ${integration.id} is locked by another run, skipping`
    )
    return
  }

  try {
    await pollAndApply(container, service, integration)
  } finally {
    try {
      await service.updateOngoingIntegrations({
        id: integration.id,
        last_status_poll_at: new Date(),
      })
    } catch (error) {
      logger.error(
        `[ongoing] status-poll: failed to stamp last_status_poll_at for ${integration.id}: ${
          (error as Error).message
        }`
      )
    }
    await service.releaseSyncLock(integration.id, "status_poll")
  }
}

export default async function ongoingStatusPollJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let integrations: IntegrationRow[]
  try {
    integrations = await service.listOngoingIntegrations({ enabled: true })
  } catch (error) {
    logger.error(
      `[ongoing] status-poll: failed to list integrations: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()
  for (const integration of integrations) {
    try {
      await pollIntegration(container, service, logger, integration, now)
    } catch (error) {
      logger.error(
        `[ongoing] status-poll: integration ${integration.id} (${integration.credential_key}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one integration's failure must not kill the tick.
    }
  }
}

export const config = {
  name: "ongoing-status-poll",
  schedule: "* * * * *",
}

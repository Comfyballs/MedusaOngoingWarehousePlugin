import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import {
  refreshOngoingOrderStatusWorkflow,
  syncOngoingShipmentWorkflow,
  syncOngoingDeliveryWorkflow,
  markOrderSyncDoneWorkflow,
} from "../workflows"
import { isDoneStatusCode, resolveShipmentStage } from "../lib/ongoing/status-semantics"

// Ongoing order-status sweep. Wide on purpose: the poll keeps latest_status_code
// fresh for order-edit gating AND detects shipment, so it must see every active
// order — not only shipped ones. 100 (preliminary) .. 999 spans Ongoing's active
// + shipped status range. (Spec §7.)
const ONGOING_ACTIVE_STATUS_FROM = 100
const ONGOING_ACTIVE_STATUS_TO = 999

// Sync states for which polling is finished: no further status refresh / shipment.
// "shipped" is intentionally NOT terminal — a pickup order advances shipped (450)
// -> delivered (500), and dropping shipped rows here would swallow that 500 signal
// (bead 18m). Only "delivered" and "cancelled" end the lifecycle.
const TERMINAL_SYNC_STATES = new Set(["delivered", "cancelled"])

// --- daily done-order safety sweep (bead t36) ---
//
// Once an order is stamped done_synced_at (status above the done threshold — bead 8rg)
// the 15-minute sweep above never looks at it again, so a LATE change in Ongoing would go
// unseen: a pickup order advancing 451 (Klar til henting) -> 500 (Hentet), a 475 (Retur),
// an annulment, corrected tracking. This low-frequency reconciliation pass is the catch-net:
// once a day it re-asks Ongoing for done orders whose status changed recently and runs them
// through the same per-order apply path. Every workflow it drives is idempotent
// (shipped_at / delivered_at / done_synced_at guards), so a redundant re-sync is a no-op.
const DONE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

// Minimum lookback, used when there is no previous sweep to measure from. Wider than the
// interval on purpose: the sweep can only fire on a poll tick, so the real gap between two
// sweeps is DONE_SWEEP_INTERVAL_MS plus up to one poll interval.
const DONE_SWEEP_MIN_LOOKBACK_MS = DONE_SWEEP_INTERVAL_MS + 2 * 60 * 60 * 1000 // 26 hours

// Added on top of the measured gap since the last sweep. Absorbs clock skew between us and
// Ongoing — whose clock, not ours, stamps the change times `orderStatusChangedTimeFrom`
// compares against — plus the latency of the sweep already in flight.
const DONE_SWEEP_OVERLAP_MS = 2 * 60 * 60 * 1000 // 2 hours

// Ceiling on the measured lookback. Without one, an integration that has not swept for
// months would ask Ongoing for its entire finished-order history in a single query on the
// first tick after coming back. Ongoing imposes no age limit on orderStatusChangedTimeFrom
// (verified live — unlike stockInfoChangedFrom's hard 24h), so this is about the size of
// the RESULT SET, not about the request being rejected: past this horizon the sweep gives
// up on catching a change rather than melting the tick that resumes it.
const DONE_SWEEP_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// How far back this sweep asks Ongoing to look.
//
// Derived from the ACTUAL gap since the last sweep, never from the nominal interval: the
// sweep is due at 24h but only RUNS on a poll tick that reaches it, and an Ongoing outage,
// an app restart, a paused worker or a large status_poll_interval can all stretch the real
// gap well past a day. A fixed 26h window would then leave everything older than 26h
// unexamined by any sweep, ever — silently losing exactly the late changes this pass exists
// to catch. Measuring the gap instead means a delayed sweep widens its own window to cover
// the whole outage (bounded by DONE_SWEEP_MAX_LOOKBACK_MS). Re-examining orders an earlier
// sweep already saw is free: the apply path is idempotent.
function resolveSweepLookbackMs(integration: IntegrationRow, now: number): number {
  if (integration.last_done_sweep_at == null) {
    return DONE_SWEEP_MIN_LOOKBACK_MS
  }
  const elapsed = now - new Date(integration.last_done_sweep_at).getTime()
  const measured = elapsed + DONE_SWEEP_OVERLAP_MS
  return Math.min(
    Math.max(DONE_SWEEP_MIN_LOOKBACK_MS, measured),
    DONE_SWEEP_MAX_LOOKBACK_MS
  )
}

// Upper bound of the sweep's status query. Unlike the 15-minute poll (100..999) this DOES
// include 1000 (Annullert): a late annulment of an already-done order is exactly the kind
// of change the sweep exists to catch.
const ONGOING_DONE_STATUS_TO = 1000

// Minimum advisory-lock TTL held while sweeping. The regular poll locks for one poll
// interval (default 1 minute), which is far too short to cover a sweep — a second instance
// could pick the same integration up mid-sweep and duplicate every call. The sweep's work is
// idempotent, so this is about not wasting Ongoing's rate limit, not about correctness.
const DONE_SWEEP_LOCK_TTL_MS = 15 * 60 * 1000

type TrackedOrder = {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
  tracking: { number: string; url?: string }[]
}

type OngoingClientLike = {
  getOrdersByStatus: (
    from: number,
    to: number,
    statusChangedSince?: string
  ) => Promise<TrackedOrder[]>
}

type IntegrationRow = {
  id: string
  credential_key: string
  status_poll_interval: string | null
  last_status_poll_at: Date | string | null
  last_done_sweep_at: Date | string | null
  shipped_status_codes: number[] | null
  delivered_status_codes: number[] | null
}

type OrderSyncRow = {
  id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | string | null
  done_synced_at: Date | string | null
}

type OngoingServiceLike = {
  listOngoingIntegrations: (filter: { enabled: boolean }) => Promise<IntegrationRow[]>
  getClient: (credentialKey: string) => OngoingClientLike
  getDefaultStatusPollIntervalMs: () => number
  getDoneStatusThreshold: () => number
  acquireSyncLock: (integrationId: string, ttlMs: number, lockName?: "status_poll") => Promise<boolean>
  releaseSyncLock: (integrationId: string, lockName?: "status_poll") => Promise<void>
  listOngoingOrderSyncs: (filter: { integration_id: string }) => Promise<OrderSyncRow[]>
  updateOngoingIntegrations: (data: {
    id: string
    last_status_poll_at?: Date
    last_done_sweep_at?: Date
  }) => Promise<unknown>
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

// Apply one Ongoing order's current status to its sync row: refresh the stored status,
// then act on the semantic stage, then (if Ongoing is finished with it) stamp it done.
// Shared by the 15-minute poll and the daily done-order sweep so both paths interpret a
// status the same way.
async function applyTrackedOrder(
  container: MedusaContainer,
  integration: IntegrationRow,
  row: OrderSyncRow,
  order: TrackedOrder,
  stageConfig: { shippedCodes: number[] | null; deliveredCodes: number[] | null },
  doneThreshold: number
): Promise<void> {
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

  // Interpret the code semantically rather than by a flat membership test
  // (bead 18m): "shipped" creates the Medusa shipment (once, guarded by
  // shipped_at); "delivered" records the pickup-point collection (450 -> 500)
  // and, if we never saw the shipped code, backfills the shipment first.
  const stage = resolveShipmentStage(order.statusNumber, stageConfig)

  if (stage === "shipped" && row.shipped_at == null) {
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
  } else if (stage === "delivered") {
    // Idempotency (delivered_at re-check) lives in loadSyncForDeliveryStep; a
    // redundant call on an already-delivered row is a no-op.
    await syncOngoingDeliveryWorkflow(container).run({
      input: {
        ongoing_order_number: order.orderNumber,
        status_code: order.statusNumber,
        status_text: order.statusText,
        tracking_numbers: order.trackingNumbers,
        tracking: order.tracking,
      },
    })
  }

  // Ongoing is finished with anything above the threshold (451 Klar til henting,
  // 475 Retur, 500 Hentet, 1000 Annullert), so this tick is its last: stamp the row
  // and let later ticks skip it (bead 8rg). Stamped LAST on purpose — if the refresh
  // or the shipment/delivery sync above threw, this never runs and the next tick
  // retries the order instead of freezing it half-synced. Late Ongoing changes to a
  // done order are the daily safety-check sweep's job (bead t36), not this poll's.
  // (Re-stamping an already-stamped row from the sweep is a harmless overwrite.)
  if (isDoneStatusCode(order.statusNumber, doneThreshold)) {
    await markOrderSyncDoneWorkflow(container).run({
      input: { order_sync_id: row.id },
    })
  }
}

function isDoneSweepDue(integration: IntegrationRow, now: number): boolean {
  if (integration.last_done_sweep_at == null) {
    return true
  }
  const last = new Date(integration.last_done_sweep_at).getTime()
  return now - last >= DONE_SWEEP_INTERVAL_MS
}

// The daily catch-net (bead t36). Asks Ongoing only for orders ABOVE the done threshold
// whose STATUS CHANGED within the lookback window (`orderStatusChangedTimeFrom`), so the
// query stays bounded no matter how much finished history the goods owner has, and runs
// each match through the same apply path as the poll. Uses the integration's shared
// OngoingClient, hence the same per-credential-key throttle as every other call.
async function sweepDoneOrders(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  client: OngoingClientLike,
  // Every non-terminal row of this integration, keyed by Ongoing order number — including
  // the done-stamped ones the poll pass skips, which are the whole point of the sweep.
  sweepableRows: Map<string, OrderSyncRow>,
  alreadyApplied: Set<string>,
  stageConfig: { shippedCodes: number[] | null; deliveredCodes: number[] | null },
  doneThreshold: number,
  now: number
): Promise<void> {
  // A threshold at/above the top of Ongoing's status range leaves nothing for the sweep to
  // ask about (and would send an inverted from > to). defaultDoneStatusThreshold is only
  // validated as a non-negative integer, so this is reachable by configuration.
  const statusFrom = doneThreshold + 1
  if (statusFrom > ONGOING_DONE_STATUS_TO) {
    logger.debug?.(
      `[ongoing] status-poll: done-sweep for integration ${integration.id} skipped — ` +
        `done threshold ${doneThreshold} leaves no status above it`
    )
    return
  }

  const changedSince = new Date(now - resolveSweepLookbackMs(integration, now)).toISOString()
  const orders = await client.getOrdersByStatus(statusFrom, ONGOING_DONE_STATUS_TO, changedSince)

  let applied = 0
  let failed = 0
  for (const order of orders) {
    // Skip anything the poll pass already handled this tick — an order that crossed the
    // threshold moments ago needs no second identical round-trip.
    if (alreadyApplied.has(order.orderNumber)) {
      continue
    }
    const row = sweepableRows.get(order.orderNumber)
    if (!row) {
      continue
    }
    try {
      await applyTrackedOrder(container, integration, row, order, stageConfig, doneThreshold)
      applied++
    } catch (error) {
      // Per-order isolation, unlike the poll pass: one unsyncable done order must not abort
      // the sweep and leave it unstamped, which would re-run this whole pass on every
      // 15-minute tick.
      //
      // NOT self-healing, and the log says so: the sweep is stamped anyway, and the next
      // sweep's window starts at that stamp — so unless this order's status changes again in
      // Ongoing, its change is dropped here. That is the deliberate trade (a dropped
      // reconciliation for one order, versus a poison row re-running the pass forever);
      // a per-order retry ledger for the sweep is filed as follow-up bead t36.1.
      failed++
      logger.error(
        `[ongoing] status-poll: done-sweep failed for order ${order.orderNumber} ` +
          `(integration ${integration.id}): ${(error as Error).message} — this reconciliation ` +
          `is dropped and will only be retried if the order changes again in Ongoing`
      )
    }
  }

  logger.info(
    `[ongoing] status-poll: done-sweep for integration ${integration.id} re-synced ${applied} ` +
      `order(s) changed since ${changedSince}${failed > 0 ? `, ${failed} failed` : ""}`
  )

  // Stamped only after the sweep ran to completion (a per-order failure above is already
  // isolated), so a sweep that died early — e.g. the Ongoing query threw — is retried on
  // the next tick rather than waiting another day.
  await service.updateOngoingIntegrations({
    id: integration.id,
    last_done_sweep_at: new Date(),
  })
}

async function pollAndApply(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  now: number,
  sweepDue: boolean
): Promise<void> {
  const client = service.getClient(integration.credential_key)
  const orders = await client.getOrdersByStatus(
    ONGOING_ACTIVE_STATUS_FROM,
    ONGOING_ACTIVE_STATUS_TO
  )

  // Limit in-memory work to this integration's still-open tracked orders. A row
  // already synced at a done status (done_synced_at stamped below) is excluded for
  // the same reason a terminal sync_state is: nothing further is expected from it —
  // it is the daily sweep, not this pass, that revisits those (`sweepableRows`).
  const rows = await service.listOngoingOrderSyncs({ integration_id: integration.id })
  const tracked = new Map<string, OrderSyncRow>()
  const sweepableRows = new Map<string, OrderSyncRow>()
  for (const row of rows) {
    if (TERMINAL_SYNC_STATES.has(row.sync_state)) {
      continue
    }
    sweepableRows.set(row.ongoing_order_number, row)
    if (row.done_synced_at == null) {
      tracked.set(row.ongoing_order_number, row)
    }
  }

  const stageConfig = {
    shippedCodes: integration.shipped_status_codes,
    deliveredCodes: integration.delivered_status_codes,
  }
  const doneThreshold = service.getDoneStatusThreshold()

  const applied = new Set<string>()
  // The poll loop deliberately still aborts this integration's tick on the first per-order
  // failure (unchanged behaviour — the next tick retries it). The daily sweep, however, must
  // NOT be collateral damage: a row that throws deterministically (an orphaned sync row, a
  // deleted fulfillment) can never be stamped done, so it would throw on every tick and
  // silently keep the safety net switched off forever. Capture the failure, run the sweep,
  // then rethrow so the caller logs the integration failure exactly as before.
  let pollError: unknown
  try {
    for (const order of orders) {
      const row = tracked.get(order.orderNumber)
      if (!row) {
        continue
      }
      await applyTrackedOrder(container, integration, row, order, stageConfig, doneThreshold)
      applied.add(order.orderNumber)
    }
  } catch (error) {
    pollError = error
  }

  if (sweepDue) {
    try {
      await sweepDoneOrders(
        container,
        service,
        logger,
        integration,
        client,
        sweepableRows,
        applied,
        stageConfig,
        doneThreshold,
        now
      )
    } catch (sweepError) {
      if (pollError === undefined) {
        throw sweepError
      }
      // Both passes failed: the poll error is the one the caller reports, so log this one
      // here rather than letting it silently replace the other.
      logger.error(
        `[ongoing] status-poll: done-sweep for integration ${integration.id} also failed: ` +
          `${(sweepError as Error).message}`
      )
    }
  }

  if (pollError !== undefined) {
    throw pollError
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

  // A tick that also runs the daily sweep holds the lock longer than one poll interval
  // (see DONE_SWEEP_LOCK_TTL_MS), so a second instance can't start the same sweep mid-run.
  const sweepDue = isDoneSweepDue(integration, now)
  const lockTtlMs = sweepDue ? Math.max(intervalMs, DONE_SWEEP_LOCK_TTL_MS) : intervalMs

  const acquired = await service.acquireSyncLock(integration.id, lockTtlMs, "status_poll")
  if (!acquired) {
    logger.debug?.(
      `[ongoing] status-poll: integration ${integration.id} is locked by another run, skipping`
    )
    return
  }

  try {
    await pollAndApply(container, service, logger, integration, now, sweepDue)
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
  schedule: "*/15 * * * *",
}

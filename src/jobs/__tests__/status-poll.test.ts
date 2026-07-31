import type { MedusaContainer } from "@medusajs/framework/types"

// Mock the workflows barrel: named exports are factories (container) => { run }.
const run = jest.fn().mockResolvedValue({ result: {} })
const deliveryRun = jest.fn().mockResolvedValue({ result: {} })
const refreshRun = jest.fn().mockResolvedValue({ result: {} })
const markDoneRun = jest.fn().mockResolvedValue({ result: {} })
jest.mock("../../workflows", () => ({
  __esModule: true,
  syncOngoingShipmentWorkflow: jest.fn(() => ({ run })),
  syncOngoingDeliveryWorkflow: jest.fn(() => ({ run: deliveryRun })),
  refreshOngoingOrderStatusWorkflow: jest.fn(() => ({ run: refreshRun })),
  markOrderSyncDoneWorkflow: jest.fn(() => ({ run: markDoneRun })),
}))

beforeEach(() => {
  run.mockClear()
  run.mockResolvedValue({ result: {} })
  deliveryRun.mockClear()
  refreshRun.mockClear()
  markDoneRun.mockClear()
})

import ongoingStatusPollJob, { config } from "../status-poll"

type TrackedOrder = {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
  tracking?: { number: string; url?: string }[]
}

type Integration = {
  id: string
  credential_key: string
  enabled: boolean
  status_poll_interval: string | null
  last_status_poll_at: Date | null
  // Null/absent means the daily done-order sweep (bead t36) is due; the default
  // integ() below sets it recent so only the tests that opt in run the sweep.
  last_done_sweep_at: Date | null
  shipped_status_codes: number[] | null
  delivered_status_codes: number[] | null
}

type Row = {
  id: string
  integration_id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | null
  // Stamped once the poll has synced the order at a done status (bead 8rg); absent
  // on the rows that model a still-active order.
  done_synced_at?: Date | null
}

function makeHarness(opts: {
  integrations: Integration[]
  rowsByIntegration?: Record<string, Row[]>
  ordersByKey?: Record<string, TrackedOrder[]>
  getOrdersImpl?: (
    credentialKey: string,
    from: number,
    to: number,
    statusChangedSince?: string
  ) => Promise<TrackedOrder[]>
  // Orders the done-order sweep's changed-since query returns, per credential key. The
  // default ordersByKey answers the sweep query too (mirroring a warehouse where the
  // done orders are simply part of the same list), so only sweep-specific tests set this.
  sweepOrdersByKey?: Record<string, TrackedOrder[]>
  acquireImpl?: (id: string, ttlMs: number) => Promise<boolean>
  defaultIntervalMs?: number
  doneThreshold?: number
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const clients: Record<string, { getOrdersByStatus: jest.Mock }> = {}
  for (const integ of opts.integrations) {
    clients[integ.credential_key] = {
      getOrdersByStatus: jest.fn(async (from: number, to: number, changedSince?: string) => {
        if (opts.getOrdersImpl) {
          return opts.getOrdersImpl(integ.credential_key, from, to, changedSince)
        }
        if (changedSince !== undefined && opts.sweepOrdersByKey) {
          return opts.sweepOrdersByKey[integ.credential_key] ?? []
        }
        return opts.ordersByKey?.[integ.credential_key] ?? []
      }),
    }
  }

  const service = {
    listOngoingIntegrations: jest.fn(async () => opts.integrations),
    getClient: jest.fn((key: string) => clients[key]),
    getDefaultStatusPollIntervalMs: jest.fn(() => opts.defaultIntervalMs ?? 60000),
    getDoneStatusThreshold: jest.fn(() => opts.doneThreshold ?? 450),
    acquireSyncLock: jest.fn(opts.acquireImpl ?? (async () => true)),
    releaseSyncLock: jest.fn(async () => undefined),
    listOngoingOrderSyncs: jest.fn(
      async ({ integration_id }: { integration_id: string }) =>
        opts.rowsByIntegration?.[integration_id] ?? []
    ),
    updateOngoingIntegrations: jest.fn(async () => ({})),
  }

  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  } as unknown as MedusaContainer

  return { container, service, logger, clients }
}

const integ = (over: Partial<Integration> = {}): Integration => ({
  id: "int_1",
  credential_key: "wh-a",
  enabled: true,
  status_poll_interval: "60000",
  last_status_poll_at: null,
  last_done_sweep_at: new Date(),
  shipped_status_codes: [400],
  delivered_status_codes: null,
  ...over,
})

describe("ongoing status-poll job", () => {
  it("registers the dispatcher to run every 15 minutes", () => {
    expect(config).toEqual({ name: "ongoing-status-poll", schedule: "*/15 * * * *" })
  })

  it("skips a locked integration without polling or releasing", async () => {
    const h = makeHarness({ integrations: [integ()], acquireImpl: async () => false })

    await ongoingStatusPollJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 60000, "status_poll")
    expect(h.clients["wh-a"].getOrdersByStatus).not.toHaveBeenCalled()
    expect(h.service.releaseSyncLock).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("skips an integration that is not due yet", async () => {
    const notDue = integ({
      status_poll_interval: "300000",
      last_status_poll_at: new Date(Date.now() - 1000),
    })
    const h = makeHarness({ integrations: [notDue] })

    await ongoingStatusPollJob(h.container)

    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
    expect(h.clients["wh-a"].getOrdersByStatus).not.toHaveBeenCalled()
  })

  it("polls a due integration, refreshes matched non-terminal rows, and ships only in-band not-yet-shipped orders", async () => {
    const due = integ({ last_status_poll_at: new Date(Date.now() - 120000) })
    const rows: Row[] = [
      { id: "r_open", integration_id: "int_1", ongoing_order_number: "1001-aaa", sync_state: "sent", shipped_at: null },
      { id: "r_ship_unshipped", integration_id: "int_1", ongoing_order_number: "1001-bbb", sync_state: "sent", shipped_at: null },
      { id: "r_ship_already", integration_id: "int_1", ongoing_order_number: "1001-ccc", sync_state: "sent", shipped_at: new Date() },
      // "delivered" is terminal; a "shipped" row is NOT (it can still reach 500).
      { id: "r_terminal", integration_id: "int_1", ongoing_order_number: "1001-ddd", sync_state: "delivered", shipped_at: new Date() },
    ]
    const orders: TrackedOrder[] = [
      { ongoingOrderId: 1, orderNumber: "1001-aaa", statusNumber: 200, statusText: "Open", trackingNumbers: [] },
      { ongoingOrderId: 2, orderNumber: "1001-bbb", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T1", "T2"], tracking: [{ number: "T1", url: "https://t/1" }, { number: "T2" }] },
      { ongoingOrderId: 3, orderNumber: "1001-ccc", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T3"] },
      { ongoingOrderId: 4, orderNumber: "1001-ddd", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T4"] },
      { ongoingOrderId: 9, orderNumber: "9999-zzz", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T9"] },
    ]
    const h = makeHarness({
      integrations: [due],
      rowsByIntegration: { int_1: rows },
      ordersByKey: { "wh-a": orders },
    })

    await ongoingStatusPollJob(h.container)

    // Every matched non-terminal row gets its latest status refreshed via the
    // shared refresh workflow (same one the out-of-band webhook path uses).
    expect(refreshRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-aaa", integration_id: "int_1",
        status_code: 200, status_text: "Open",
      },
    })
    expect(refreshRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-bbb", integration_id: "int_1",
        status_code: 400, status_text: "Sent",
      },
    })
    expect(refreshRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-ccc", integration_id: "int_1",
        status_code: 400, status_text: "Sent",
      },
    })
    // Terminal row (sync_state "delivered") and the untracked order are ignored.
    const refreshedOrderNumbers = refreshRun.mock.calls.map(
      (c) => (c as { input: { ongoing_order_number: string } }[])[0].input.ongoing_order_number
    )
    expect(refreshedOrderNumbers).toHaveLength(3)
    expect(refreshedOrderNumbers).not.toContain("1001-ddd")

    // Shipment workflow only for the shipped-code + not-yet-shipped row.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-bbb",
        status_code: 400,
        status_text: "Sent",
        tracking_numbers: ["T1", "T2"],
        // Enriched tracking (waybill + URL) now flows to the shipment workflow (bead 5vu).
        tracking: [{ number: "T1", url: "https://t/1" }, { number: "T2" }],
      },
    })

    // Cadence advanced + lock released.
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_status_poll_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1", "status_poll")
  })

  it("keeps polling a shipped row and routes a 500 pickup to the delivery workflow (450 -> 500)", async () => {
    // Canonical: null shipped/delivered codes fall back to shipped [425,450,451],
    // delivered [500]. A row already shipped (shipped_at set, sync_state "shipped")
    // is NOT terminal, so a subsequent 500 is caught and recorded as a delivery.
    const due = integ({
      last_status_poll_at: new Date(Date.now() - 120000),
      shipped_status_codes: null,
      delivered_status_codes: null,
    })
    const rows: Row[] = [
      { id: "r_pickup", integration_id: "int_1", ongoing_order_number: "1001-pick", sync_state: "shipped", shipped_at: new Date() },
    ]
    const orders: TrackedOrder[] = [
      { ongoingOrderId: 7, orderNumber: "1001-pick", statusNumber: 500, statusText: "Hentet", trackingNumbers: ["TP"], tracking: [{ number: "TP", url: "https://t/p" }] },
    ]
    const h = makeHarness({
      integrations: [due],
      rowsByIntegration: { int_1: rows },
      ordersByKey: { "wh-a": orders },
    })

    await ongoingStatusPollJob(h.container)

    // Still refreshed (shipped is not terminal) so latest_status_code tracks 500.
    expect(refreshRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-pick", integration_id: "int_1",
        status_code: 500, status_text: "Hentet",
      },
    })
    // Delivery workflow fired; no shipment re-created.
    expect(deliveryRun).toHaveBeenCalledTimes(1)
    expect(deliveryRun).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-pick",
        status_code: 500,
        status_text: "Hentet",
        tracking_numbers: ["TP"],
        tracking: [{ number: "TP", url: "https://t/p" }],
      },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("ships (not delivers) at a canonical shipped code and delivers only at a delivered code", async () => {
    const due = integ({
      last_status_poll_at: new Date(Date.now() - 120000),
      shipped_status_codes: null,
      delivered_status_codes: null,
    })
    const rows: Row[] = [
      { id: "r_sent", integration_id: "int_1", ongoing_order_number: "2001-sent", sync_state: "sent", shipped_at: null },
    ]
    const orders: TrackedOrder[] = [
      { ongoingOrderId: 8, orderNumber: "2001-sent", statusNumber: 450, statusText: "Sendt", trackingNumbers: ["TS"] },
    ]
    const h = makeHarness({
      integrations: [due],
      rowsByIntegration: { int_1: rows },
      ordersByKey: { "wh-a": orders },
    })

    await ongoingStatusPollJob(h.container)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "2001-sent",
        status_code: 450,
        status_text: "Sendt",
        tracking_numbers: ["TS"],
        tracking: undefined,
      },
    })
    expect(deliveryRun).not.toHaveBeenCalled()
    // 450 IS the threshold, not above it — the order stays in the poll so it can
    // still advance 450 -> 500.
    expect(markDoneRun).not.toHaveBeenCalled()
  })

  describe("done-status threshold (bead 8rg)", () => {
    const dueInteg = (over: Partial<Integration> = {}) =>
      integ({
        last_status_poll_at: new Date(Date.now() - 120000),
        shipped_status_codes: null,
        delivered_status_codes: null,
        ...over,
      })

    it("syncs an order once when it crosses the threshold, then stamps it done", async () => {
      // 451 "Klar til henting" is above the default threshold: Ongoing is finished
      // with it, so this tick is its last.
      const rows: Row[] = [
        { id: "r_pickup_ready", integration_id: "int_1", ongoing_order_number: "3001-aaa", sync_state: "sent", shipped_at: null },
      ]
      const orders: TrackedOrder[] = [
        { ongoingOrderId: 11, orderNumber: "3001-aaa", statusNumber: 451, statusText: "Klar til henting", trackingNumbers: ["TR"] },
      ]
      const h = makeHarness({
        integrations: [dueInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": orders },
      })

      await ongoingStatusPollJob(h.container)

      // Synced exactly once at the done status: status refreshed and the shipment
      // created (451 is a canonical shipped code), then the row is stamped.
      expect(refreshRun).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(1)
      expect(markDoneRun).toHaveBeenCalledTimes(1)
      expect(markDoneRun).toHaveBeenCalledWith({ input: { order_sync_id: "r_pickup_ready" } })
    })

    it("skips a row already stamped done on later ticks", async () => {
      const rows: Row[] = [
        { id: "r_done", integration_id: "int_1", ongoing_order_number: "3001-bbb", sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date() },
      ]
      const orders: TrackedOrder[] = [
        { ongoingOrderId: 12, orderNumber: "3001-bbb", statusNumber: 451, statusText: "Klar til henting", trackingNumbers: ["TR"] },
      ]
      const h = makeHarness({
        integrations: [dueInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": orders },
      })

      await ongoingStatusPollJob(h.container)

      expect(refreshRun).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
      expect(deliveryRun).not.toHaveBeenCalled()
      expect(markDoneRun).not.toHaveBeenCalled()
    })

    it("honours a configured threshold instead of the 450 default", async () => {
      // Threshold 400: 425 is now "done", and a below-threshold 300 is untouched.
      const rows: Row[] = [
        { id: "r_sent_425", integration_id: "int_1", ongoing_order_number: "3001-ccc", sync_state: "sent", shipped_at: null },
        { id: "r_picking", integration_id: "int_1", ongoing_order_number: "3001-ddd", sync_state: "sent", shipped_at: null },
      ]
      const orders: TrackedOrder[] = [
        { ongoingOrderId: 13, orderNumber: "3001-ccc", statusNumber: 425, statusText: "Sendt/Dellevert", trackingNumbers: [] },
        { ongoingOrderId: 14, orderNumber: "3001-ddd", statusNumber: 300, statusText: "Plukk", trackingNumbers: [] },
      ]
      const h = makeHarness({
        integrations: [dueInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": orders },
        doneThreshold: 400,
      })

      await ongoingStatusPollJob(h.container)

      expect(refreshRun).toHaveBeenCalledTimes(2)
      expect(markDoneRun).toHaveBeenCalledTimes(1)
      expect(markDoneRun).toHaveBeenCalledWith({ input: { order_sync_id: "r_sent_425" } })
    })

    it("does not stamp done when the order's shipment sync fails", async () => {
      // The stamp is last on purpose: a half-applied tick must stay pollable so the
      // next tick retries it rather than freezing the order without its shipment.
      const rows: Row[] = [
        { id: "r_fail", integration_id: "int_1", ongoing_order_number: "3001-eee", sync_state: "sent", shipped_at: null },
      ]
      const orders: TrackedOrder[] = [
        { ongoingOrderId: 15, orderNumber: "3001-eee", statusNumber: 451, statusText: "Klar til henting", trackingNumbers: ["TR"] },
      ]
      const h = makeHarness({
        integrations: [dueInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": orders },
      })
      run.mockRejectedValueOnce(new Error("fulfillment missing"))

      await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

      expect(h.logger.error).toHaveBeenCalled()
      expect(markDoneRun).not.toHaveBeenCalled()
    })
  })

  describe("daily done-order safety sweep (bead t36)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    const sweepInteg = (over: Partial<Integration> = {}) =>
      integ({
        last_status_poll_at: new Date(Date.now() - 120000),
        last_done_sweep_at: new Date(Date.now() - DAY_MS - 60000),
        shipped_status_codes: null,
        delivered_status_codes: null,
        ...over,
      })

    it("does not sweep when the last sweep is less than a day old", async () => {
      const h = makeHarness({
        integrations: [integ({ last_done_sweep_at: new Date(Date.now() - DAY_MS + 60000) })],
      })

      await ongoingStatusPollJob(h.container)

      // Only the regular 100–999 poll query; no changed-since sweep query.
      expect(h.clients["wh-a"].getOrdersByStatus).toHaveBeenCalledTimes(1)
      expect(h.clients["wh-a"].getOrdersByStatus).toHaveBeenCalledWith(100, 999)
      expect(h.service.updateOngoingIntegrations).not.toHaveBeenCalledWith(
        expect.objectContaining({ last_done_sweep_at: expect.anything() })
      )
      // A short poll lock, not the longer sweep one.
      expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 60000, "status_poll")
    })

    it("queries only above-threshold orders changed in the last day, and holds a longer lock", async () => {
      const before = Date.now()
      const h = makeHarness({ integrations: [sweepInteg()], sweepOrdersByKey: { "wh-a": [] } })

      await ongoingStatusPollJob(h.container)

      expect(h.clients["wh-a"].getOrdersByStatus).toHaveBeenCalledTimes(2)
      const [from, to, changedSince] = h.clients["wh-a"].getOrdersByStatus.mock.calls[1]
      // Strictly above the same done threshold the poll uses (bead 8rg), up to and
      // including 1000 (Annullert) — a late annulment is exactly what this catches.
      expect(from).toBe(451)
      expect(to).toBe(1000)
      // Lookback is wider than 24h (the sweep can only fire on a poll tick) but bounded.
      const sinceMs = Date.parse(changedSince as string)
      expect(before - sinceMs).toBeGreaterThan(DAY_MS)
      expect(before - sinceMs).toBeLessThanOrEqual(27 * 60 * 60 * 1000)
      // The sweep tick holds the lock for longer than one poll interval.
      expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 15 * 60 * 1000, "status_poll")
      expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        last_done_sweep_at: expect.any(Date),
      })
    })

    it("widens the lookback to the real gap when a sweep was delayed past its interval", async () => {
      // A fixed 26h window would leave everything older than 26h unexamined by any sweep
      // after an outage/restart/large poll interval — silently losing exactly what the
      // sweep exists to catch. The window must follow the measured gap instead.
      const h = makeHarness({
        integrations: [sweepInteg({ last_done_sweep_at: new Date(Date.now() - 5 * DAY_MS) })],
        sweepOrdersByKey: { "wh-a": [] },
      })

      await ongoingStatusPollJob(h.container)

      const [, , changedSince] = h.clients["wh-a"].getOrdersByStatus.mock.calls[1]
      const lookbackMs = Date.now() - Date.parse(changedSince as string)
      // Covers the whole 5-day gap (plus overlap), not a flat 26 hours.
      expect(lookbackMs).toBeGreaterThan(5 * DAY_MS)
      expect(lookbackMs).toBeLessThan(6 * DAY_MS)
    })

    it("caps the lookback so a long-dormant integration cannot ask for all of history", async () => {
      const h = makeHarness({
        integrations: [sweepInteg({ last_done_sweep_at: new Date(Date.now() - 400 * DAY_MS) })],
        sweepOrdersByKey: { "wh-a": [] },
      })

      await ongoingStatusPollJob(h.container)

      const [, , changedSince] = h.clients["wh-a"].getOrdersByStatus.mock.calls[1]
      const lookbackMs = Date.now() - Date.parse(changedSince as string)
      expect(lookbackMs).toBeLessThanOrEqual(30 * DAY_MS + 60000)
      expect(lookbackMs).toBeGreaterThan(29 * DAY_MS)
    })

    it("still sweeps when an order in the poll pass throws", async () => {
      // A row that can never be stamped done (orphaned sync row, deleted fulfillment)
      // throws on every tick. If that aborted the tick before the sweep, the safety net
      // would be silently off for this integration forever.
      const rows: Row[] = [
        { id: "r_poison", integration_id: "int_1", ongoing_order_number: "5001-poison", sync_state: "sent", shipped_at: null },
        { id: "r_done", integration_id: "int_1", ongoing_order_number: "5001-done", sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date() },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": [{ ongoingOrderId: 31, orderNumber: "5001-poison", statusNumber: 300, statusText: "Plukk", trackingNumbers: [] }] },
        sweepOrdersByKey: { "wh-a": [{ ongoingOrderId: 32, orderNumber: "5001-done", statusNumber: 500, statusText: "Hentet", trackingNumbers: [] }] },
      })
      refreshRun.mockRejectedValueOnce(new Error("orphaned row"))

      await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

      // The sweep ran despite the poll pass aborting, and delivered the done order.
      expect(h.clients["wh-a"].getOrdersByStatus).toHaveBeenCalledTimes(2)
      expect(deliveryRun).toHaveBeenCalledTimes(1)
      expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        last_done_sweep_at: expect.any(Date),
      })
      // The poll failure is still reported.
      expect(h.logger.error).toHaveBeenCalled()
    })

    it("refreshes a tracked order annulled at 1000 without fabricating a shipment or delivery", async () => {
      // 1000 is in the sweep's range but resolves to neither the shipped nor the delivered
      // stage, so a late annulment updates the stored status and nothing else.
      const rows: Row[] = [
        { id: "r_annulled", integration_id: "int_1", ongoing_order_number: "5001-ann", sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date() },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        sweepOrdersByKey: { "wh-a": [{ ongoingOrderId: 33, orderNumber: "5001-ann", statusNumber: 1000, statusText: "Annullert", trackingNumbers: [] }] },
      })

      await ongoingStatusPollJob(h.container)

      expect(refreshRun).toHaveBeenCalledWith({
        input: {
          ongoing_order_number: "5001-ann", integration_id: "int_1",
          status_code: 1000, status_text: "Annullert",
        },
      })
      expect(run).not.toHaveBeenCalled()
      expect(deliveryRun).not.toHaveBeenCalled()
      expect(markDoneRun).toHaveBeenCalledTimes(1)
    })

    it("skips the sweep entirely when the threshold leaves no status above it", async () => {
      const h = makeHarness({ integrations: [sweepInteg()], doneThreshold: 1000 })

      await ongoingStatusPollJob(h.container)

      expect(h.clients["wh-a"].getOrdersByStatus).toHaveBeenCalledTimes(1)
      expect(h.service.updateOngoingIntegrations).not.toHaveBeenCalledWith(
        expect.objectContaining({ last_done_sweep_at: expect.anything() })
      )
    })

    it("picks up a 451 -> 500 pickup transition the main poll now skips", async () => {
      // The acceptance case: the row is stamped done at 451, so the 15-minute poll
      // ignores it — only the sweep sees it reach 500 (Hentet).
      const rows: Row[] = [
        {
          id: "r_pickup_done", integration_id: "int_1", ongoing_order_number: "4001-aaa",
          sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date(Date.now() - DAY_MS),
        },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": [{ ongoingOrderId: 21, orderNumber: "4001-aaa", statusNumber: 500, statusText: "Hentet", trackingNumbers: ["TP"] }] },
        sweepOrdersByKey: { "wh-a": [{ ongoingOrderId: 21, orderNumber: "4001-aaa", statusNumber: 500, statusText: "Hentet", trackingNumbers: ["TP"] }] },
      })

      await ongoingStatusPollJob(h.container)

      // Refreshed and delivered exactly once — by the sweep, not the poll pass.
      expect(refreshRun).toHaveBeenCalledTimes(1)
      expect(refreshRun).toHaveBeenCalledWith({
        input: {
          ongoing_order_number: "4001-aaa", integration_id: "int_1",
          status_code: 500, status_text: "Hentet",
        },
      })
      expect(deliveryRun).toHaveBeenCalledTimes(1)
      expect(run).not.toHaveBeenCalled()
    })

    it("does not re-apply an order the poll pass already handled this tick", async () => {
      // 451 crosses the threshold on this very tick: the poll pass syncs and stamps it,
      // and the sweep — which sees the same order — must not repeat the round-trip.
      const rows: Row[] = [
        { id: "r_crossing", integration_id: "int_1", ongoing_order_number: "4001-bbb", sync_state: "sent", shipped_at: null },
      ]
      const orders: TrackedOrder[] = [
        { ongoingOrderId: 22, orderNumber: "4001-bbb", statusNumber: 451, statusText: "Klar til henting", trackingNumbers: [] },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        ordersByKey: { "wh-a": orders },
        sweepOrdersByKey: { "wh-a": orders },
      })

      await ongoingStatusPollJob(h.container)

      expect(refreshRun).toHaveBeenCalledTimes(1)
      expect(markDoneRun).toHaveBeenCalledTimes(1)
    })

    it("ignores rows in a terminal sync state and orders it does not track", async () => {
      const rows: Row[] = [
        { id: "r_delivered", integration_id: "int_1", ongoing_order_number: "4001-ccc", sync_state: "delivered", shipped_at: new Date(), done_synced_at: new Date() },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        sweepOrdersByKey: {
          "wh-a": [
            { ongoingOrderId: 23, orderNumber: "4001-ccc", statusNumber: 475, statusText: "Retur", trackingNumbers: [] },
            { ongoingOrderId: 24, orderNumber: "9999-unknown", statusNumber: 1000, statusText: "Annullert", trackingNumbers: [] },
          ],
        },
      })

      await ongoingStatusPollJob(h.container)

      expect(refreshRun).not.toHaveBeenCalled()
      expect(markDoneRun).not.toHaveBeenCalled()
      expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        last_done_sweep_at: expect.any(Date),
      })
    })

    it("isolates a failing order, still stamps the sweep, and keeps going", async () => {
      const rows: Row[] = [
        { id: "r_bad", integration_id: "int_1", ongoing_order_number: "4001-ddd", sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date() },
        { id: "r_good", integration_id: "int_1", ongoing_order_number: "4001-eee", sync_state: "shipped", shipped_at: new Date(), done_synced_at: new Date() },
      ]
      const h = makeHarness({
        integrations: [sweepInteg()],
        rowsByIntegration: { int_1: rows },
        sweepOrdersByKey: {
          "wh-a": [
            { ongoingOrderId: 25, orderNumber: "4001-ddd", statusNumber: 500, statusText: "Hentet", trackingNumbers: [] },
            { ongoingOrderId: 26, orderNumber: "4001-eee", statusNumber: 500, statusText: "Hentet", trackingNumbers: [] },
          ],
        },
      })
      refreshRun.mockRejectedValueOnce(new Error("db blip"))

      await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

      // The second order still synced, and the daily stamp landed so a poison row can't
      // turn the daily sweep into a per-tick one.
      expect(refreshRun).toHaveBeenCalledTimes(2)
      expect(deliveryRun).toHaveBeenCalledTimes(1)
      expect(h.logger.error).toHaveBeenCalled()
      expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        last_done_sweep_at: expect.any(Date),
      })
    })

    it("does not stamp the sweep when its Ongoing query fails", async () => {
      const h = makeHarness({
        integrations: [sweepInteg()],
        getOrdersImpl: async (_key, _from, _to, changedSince) => {
          if (changedSince !== undefined) {
            throw new Error("ongoing 503")
          }
          return []
        },
      })

      await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

      expect(h.logger.error).toHaveBeenCalled()
      expect(h.service.updateOngoingIntegrations).not.toHaveBeenCalledWith(
        expect.objectContaining({ last_done_sweep_at: expect.anything() })
      )
      // The poll's own cadence stamp and the lock release still happen.
      expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        last_status_poll_at: expect.any(Date),
      })
      expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1", "status_poll")
    })
  })

  it("releases the lock, advances cadence, and never throws when the poll fails", async () => {
    const h = makeHarness({
      integrations: [integ()],
      getOrdersImpl: async () => {
        throw new Error("ongoing 503")
      },
    })

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1", "status_poll")
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_status_poll_at: expect.any(Date),
    })
    expect(h.logger.error).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("never throws and does no work when listing integrations fails", async () => {
    const h = makeHarness({ integrations: [] })
    ;(h.service.listOngoingIntegrations as jest.Mock).mockRejectedValue(new Error("db down"))

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
  })

  it("does not let one integration's failure stop the others", async () => {
    const a = integ({ id: "int_a", credential_key: "wh-a" })
    const b = integ({ id: "int_b", credential_key: "wh-b" })
    const rowsB: Row[] = [
      { id: "rb", integration_id: "int_b", ongoing_order_number: "2001-bbb", sync_state: "sent", shipped_at: null },
    ]
    const ordersB: TrackedOrder[] = [
      { ongoingOrderId: 5, orderNumber: "2001-bbb", statusNumber: 400, statusText: "Sent", trackingNumbers: ["TB"] },
    ]
    const h = makeHarness({
      integrations: [a, b],
      rowsByIntegration: { int_b: rowsB },
      ordersByKey: { "wh-b": ordersB },
      getOrdersImpl: (key) =>
        key === "wh-a" ? Promise.reject(new Error("boom")) : Promise.resolve(ordersB),
    })

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_b", "status_poll")
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "2001-bbb",
        status_code: 400,
        status_text: "Sent",
        tracking_numbers: ["TB"],
      },
    })
  })
})

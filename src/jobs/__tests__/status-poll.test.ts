import type { MedusaContainer } from "@medusajs/framework/types"

// Mock the workflows barrel: named exports are factories (container) => { run }.
const run = jest.fn().mockResolvedValue({ result: {} })
const deliveryRun = jest.fn().mockResolvedValue({ result: {} })
const refreshRun = jest.fn().mockResolvedValue({ result: {} })
jest.mock("../../workflows", () => ({
  __esModule: true,
  syncOngoingShipmentWorkflow: jest.fn(() => ({ run })),
  syncOngoingDeliveryWorkflow: jest.fn(() => ({ run: deliveryRun })),
  refreshOngoingOrderStatusWorkflow: jest.fn(() => ({ run: refreshRun })),
}))

beforeEach(() => {
  run.mockClear()
  deliveryRun.mockClear()
  refreshRun.mockClear()
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
  shipped_status_codes: number[] | null
  delivered_status_codes: number[] | null
}

type Row = {
  id: string
  integration_id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | null
}

function makeHarness(opts: {
  integrations: Integration[]
  rowsByIntegration?: Record<string, Row[]>
  ordersByKey?: Record<string, TrackedOrder[]>
  getOrdersImpl?: (credentialKey: string) => Promise<TrackedOrder[]>
  acquireImpl?: (id: string, ttlMs: number) => Promise<boolean>
  defaultIntervalMs?: number
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const clients: Record<string, { getOrdersByStatus: jest.Mock }> = {}
  for (const integ of opts.integrations) {
    clients[integ.credential_key] = {
      getOrdersByStatus: jest.fn(async () =>
        opts.getOrdersImpl
          ? opts.getOrdersImpl(integ.credential_key)
          : opts.ordersByKey?.[integ.credential_key] ?? []
      ),
    }
  }

  const service = {
    listOngoingIntegrations: jest.fn(async () => opts.integrations),
    getClient: jest.fn((key: string) => clients[key]),
    getDefaultStatusPollIntervalMs: jest.fn(() => opts.defaultIntervalMs ?? 60000),
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
  shipped_status_codes: [400],
  delivered_status_codes: null,
  ...over,
})

describe("ongoing status-poll job", () => {
  it("registers the dispatcher to run once a minute", () => {
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

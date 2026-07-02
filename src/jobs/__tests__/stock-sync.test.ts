import type { MedusaContainer } from "@medusajs/framework/types"

// Mock the #37 workflow barrel: named export is a factory (container) => { run }.
// run() resolves to { result: { written, skipped } } — the shape #37 returns and the
// dispatcher logs. Keep the summary populated so the `logger.info` call site type-checks
// and can be asserted.
const run = jest.fn().mockResolvedValue({ result: { written: 0, skipped: 0 } })
jest.mock("../../workflows", () => ({
  __esModule: true,
  syncOngoingInventoryWorkflow: jest.fn(() => ({ run })),
}))

import ongoingStockSyncJob, { config } from "../stock-sync"

type Integration = {
  id: string
  credential_key: string
  stock_location_id: string
  stock_sync_interval: string | null
  last_stock_sync_at: Date | null
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

function makeHarness(opts: {
  integrations: Integration[]
  acquireImpl?: (id: string, ttlMs: number) => Promise<boolean>
  defaultIntervalMs?: number
  goodsOwnerIdByKey?: Record<string, number>
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const service = {
    listOngoingIntegrations: jest.fn(async () => opts.integrations),
    getCredentials: jest.fn((key: string) => ({
      goodsOwnerId: opts.goodsOwnerIdByKey?.[key] ?? 1,
    })),
    getDefaultStockSyncIntervalMs: jest.fn(() => opts.defaultIntervalMs ?? 600000),
    acquireSyncLock: jest.fn(opts.acquireImpl ?? (async () => true)),
    releaseSyncLock: jest.fn(async () => undefined),
    updateOngoingIntegrations: jest.fn(async () => ({})),
  }

  const emit = jest.fn().mockResolvedValue(undefined)

  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "event_bus") return { emit }
      return service
    }),
  } as unknown as MedusaContainer

  return { container, service, logger, emit }
}

const integ = (over: Partial<Integration> = {}): Integration => ({
  id: "int_1",
  credential_key: "wh-a",
  stock_location_id: "sloc_1",
  stock_sync_interval: "600000",
  last_stock_sync_at: null,
  stock_reconcile_mode: "sellable_plus_reserved",
  ...over,
})

describe("ongoing stock-sync job", () => {
  it("registers the dispatcher to run once a minute", () => {
    expect(config).toEqual({ name: "ongoing-stock-sync", schedule: "* * * * *" })
  })

  it("filters integrations by enabled AND stock_sync_enabled", async () => {
    const h = makeHarness({ integrations: [] })

    await ongoingStockSyncJob(h.container)

    expect(h.service.listOngoingIntegrations).toHaveBeenCalledWith({
      enabled: true,
      stock_sync_enabled: true,
    })
  })

  it("skips a locked integration without dispatching or releasing", async () => {
    const h = makeHarness({
      integrations: [integ()],
      acquireImpl: async () => false,
    })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 600000)
    expect(run).not.toHaveBeenCalled()
    expect(h.service.releaseSyncLock).not.toHaveBeenCalled()
  })

  it("skips an integration that is not yet due", async () => {
    const notDue = integ({
      stock_sync_interval: "600000",
      last_stock_sync_at: new Date(Date.now() - 1000),
    })
    const h = makeHarness({ integrations: [notDue] })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("dispatches syncOngoingInventoryWorkflow with the correct input for a due integration", async () => {
    const due = integ({ last_stock_sync_at: new Date(Date.now() - 700000) })
    const h = makeHarness({
      integrations: [due],
      goodsOwnerIdByKey: { "wh-a": 42 },
    })

    await ongoingStockSyncJob(h.container)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        integration_id: "int_1",
        credential_key: "wh-a",
        stock_location_id: "sloc_1",
        goods_owner_id: 42,
        stock_reconcile_mode: "sellable_plus_reserved",
      },
    })
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_stock_sync_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")

    expect(h.emit).toHaveBeenCalledWith({
      name: "ongoing.sync.inventory_synced",
      data: { integration_id: "int_1", credential_key: "wh-a", stock_location_id: "sloc_1", written: 0, skipped: 0 },
    })
  })

  it("uses the default interval when stock_sync_interval is null", async () => {
    const due = integ({
      stock_sync_interval: null,
      last_stock_sync_at: new Date(Date.now() - 700000),
    })
    const h = makeHarness({ integrations: [due], defaultIntervalMs: 600000 })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 600000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("falls back to the default interval for malformed stock_sync_interval strings", async () => {
    for (const bad of ["0", "-1", "invalid", "NaN"]) {
      jest.clearAllMocks()
      run.mockResolvedValue({ result: { written: 0, skipped: 0 } })

      const due = integ({
        stock_sync_interval: bad,
        last_stock_sync_at: new Date(Date.now() - 700000),
      })
      const h = makeHarness({ integrations: [due], defaultIntervalMs: 600000 })

      await ongoingStockSyncJob(h.container)

      // Must use the default interval, not the malformed value.
      expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 600000)
    }
  })

  it("stamps last_stock_sync_at and releases the lock even when the workflow throws", async () => {
    const due = integ({ last_stock_sync_at: new Date(Date.now() - 700000) })
    const h = makeHarness({ integrations: [due] })
    run.mockRejectedValueOnce(new Error("sync failed"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_stock_sync_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
    expect(h.logger.error).toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("never throws and does no work when listing integrations fails", async () => {
    const h = makeHarness({ integrations: [] })
    ;(h.service.listOngoingIntegrations as jest.Mock).mockRejectedValue(new Error("db down"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
  })

  it("still stamps last_stock_sync_at, releases the lock, and does not log an integration failure when only the inventory_synced emit rejects", async () => {
    const due = integ({ last_stock_sync_at: new Date(Date.now() - 700000) })
    const h = makeHarness({ integrations: [due] })
    h.emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_stock_sync_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
    // The reconcile itself succeeded — only the best-effort emit failed, so the
    // per-integration sweep catch (`integration ${id} ... failed: ...`) must not fire.
    expect(h.logger.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\[ongoing\] stock-sync: integration int_1 \(/)
    )
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit ongoing.sync.inventory_synced")
    )
  })

  it("does not let one integration failure stop the others", async () => {
    const a = integ({ id: "int_a", credential_key: "wh-a", stock_location_id: "sloc_1" })
    const b = integ({ id: "int_b", credential_key: "wh-b", stock_location_id: "sloc_2" })
    const h = makeHarness({
      integrations: [a, b],
      goodsOwnerIdByKey: { "wh-a": 1, "wh-b": 2 },
    })
    run.mockRejectedValueOnce(new Error("boom"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    // Both locks must be released: int_a via finally even though its workflow threw,
    // and int_b as part of a normal successful run.
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_a")
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_b")
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ integration_id: "int_b", goods_owner_id: 2 }),
      })
    )
  })
})

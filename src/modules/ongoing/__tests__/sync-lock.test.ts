import OngoingModuleService from "../service"

const baseIntegrations = [
  { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
]

// Build a service with the auto-CRUD methods this task uses stubbed (no DB).
function makeService(options: Record<string, unknown> = {}) {
  const svc = new OngoingModuleService({} as any, {
    integrations: baseIntegrations,
    ...options,
  } as any)
  ;(svc as any).retrieveOngoingIntegration = jest.fn()
  ;(svc as any).updateOngoingIntegrations = jest.fn().mockResolvedValue({})
  return svc
}

// acquireSyncLock reads the current column via retrieveOngoingIntegration, then guards
// the write with a native `UPDATE ... WHERE id = ? AND <column> = <observed value>` — see
// retry-transition.test.ts for the identical CAS pattern used by attemptRetrySyncTransition.
// These tests pass `{ manager }` directly as sharedContext, matching that file's approach
// (bypasses baseRepository_ / a real container entirely).
function makeManager(affectedRows: number) {
  return { nativeUpdate: jest.fn().mockResolvedValue(affectedRows) }
}

describe("OngoingModuleService sync lock + default interval", () => {
  describe("getDefaultStatusPollIntervalMs", () => {
    it("parses the configured interval string into a number of ms", () => {
      const svc = makeService({ defaultStatusPollInterval: "300000" })
      expect(svc.getDefaultStatusPollIntervalMs()).toBe(300000)
    })

    it("falls back to 60000 when no default interval is configured", () => {
      const svc = makeService()
      expect(svc.getDefaultStatusPollIntervalMs()).toBe(60000)
    })
  })

  describe("acquireSyncLock", () => {
    it("acquires and stamps sync_lock_until (status_poll, the default lockName) when no lock is held", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: null,
      })
      const manager = makeManager(1)

      const before = Date.now()
      const got = await svc.acquireSyncLock("int_1", 60000, "status_poll", { manager } as any)

      expect(got).toBe(true)
      expect(manager.nativeUpdate).toHaveBeenCalledTimes(1)
      const [entity, where, data] = manager.nativeUpdate.mock.calls[0]
      expect(entity).toBe("OngoingIntegration")
      expect(where).toEqual({ id: "int_1", sync_lock_until: null })
      expect(data.sync_lock_until).toBeInstanceOf(Date)
      expect((data.sync_lock_until as Date).getTime()).toBeGreaterThanOrEqual(before + 60000)
    })

    it("refuses the lock when sync_lock_until is still in the future, without attempting the guarded write", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() + 30000),
      })
      const manager = makeManager(1)

      const got = await svc.acquireSyncLock("int_1", 60000, "status_poll", { manager } as any)

      expect(got).toBe(false)
      expect(manager.nativeUpdate).not.toHaveBeenCalled()
    })

    it("acquires when a previously held lock has already expired, guarding the write on the observed (expired) value", async () => {
      const svc = makeService()
      const expired = new Date(Date.now() - 1000)
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: expired,
      })
      const manager = makeManager(1)

      const got = await svc.acquireSyncLock("int_1", 60000, "status_poll", { manager } as any)

      expect(got).toBe(true)
      expect(manager.nativeUpdate).toHaveBeenCalledWith(
        "OngoingIntegration",
        { id: "int_1", sync_lock_until: expired },
        expect.any(Object)
      )
    })

    it("returns false (CAS lost) when the guarded write matches zero rows — another tick already acquired between the read and this write", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: null,
      })
      const manager = makeManager(0)

      const got = await svc.acquireSyncLock("int_1", 60000, "status_poll", { manager } as any)

      expect(got).toBe(false)
    })

    it("defaults lockName to status_poll when omitted", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: null,
      })
      const manager = makeManager(1)

      const got = await svc.acquireSyncLock("int_1", 60000, undefined, { manager } as any)

      expect(got).toBe(true)
      expect(manager.nativeUpdate).toHaveBeenCalledWith(
        "OngoingIntegration",
        { id: "int_1", sync_lock_until: null },
        expect.any(Object)
      )
    })

    it("uses the independent stock_sync_lock_until column for lockName='stock_sync' — status-poll and stock-sync no longer share a lock (bead mjy)", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() + 30000), // status-poll lock held...
        stock_sync_lock_until: null, // ...but stock-sync's own lock is free.
      })
      const manager = makeManager(1)

      const got = await svc.acquireSyncLock("int_1", 600000, "stock_sync", { manager } as any)

      expect(got).toBe(true)
      expect(manager.nativeUpdate).toHaveBeenCalledWith(
        "OngoingIntegration",
        { id: "int_1", stock_sync_lock_until: null },
        expect.objectContaining({ stock_sync_lock_until: expect.any(Date) })
      )
    })
  })

  describe("releaseSyncLock", () => {
    it("clears sync_lock_until for the default (status_poll) lockName", async () => {
      const svc = makeService()

      await svc.releaseSyncLock("int_1")

      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        sync_lock_until: null,
      })
    })

    it("clears stock_sync_lock_until for lockName='stock_sync', not sync_lock_until", async () => {
      const svc = makeService()

      await svc.releaseSyncLock("int_1", "stock_sync")

      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        stock_sync_lock_until: null,
      })
    })
  })

  describe("getDefaultStockSyncIntervalMs", () => {
    it("parses the configured interval string into a number of ms", () => {
      const svc = makeService({ defaultStockSyncInterval: "300000" })
      expect(svc.getDefaultStockSyncIntervalMs()).toBe(300000)
    })

    it("falls back to 600000 when no default interval is configured", () => {
      const svc = makeService()
      expect(svc.getDefaultStockSyncIntervalMs()).toBe(600000)
    })
  })
})

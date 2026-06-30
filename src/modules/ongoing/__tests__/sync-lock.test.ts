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
    it("acquires and stamps sync_lock_until when no lock is held", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: null,
      })

      const before = Date.now()
      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(true)
      const update = (svc as any).updateOngoingIntegrations.mock.calls[0][0]
      expect(update.id).toBe("int_1")
      expect(update.sync_lock_until).toBeInstanceOf(Date)
      expect((update.sync_lock_until as Date).getTime()).toBeGreaterThanOrEqual(before + 60000)
    })

    it("refuses the lock when sync_lock_until is still in the future", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() + 30000),
      })

      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(false)
      expect((svc as any).updateOngoingIntegrations).not.toHaveBeenCalled()
    })

    it("acquires when a previously held lock has already expired", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() - 1000),
      })

      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(true)
      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledTimes(1)
    })
  })

  describe("releaseSyncLock", () => {
    it("clears sync_lock_until", async () => {
      const svc = makeService()

      await svc.releaseSyncLock("int_1")

      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        sync_lock_until: null,
      })
    })
  })
})

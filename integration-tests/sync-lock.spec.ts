import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import { FAKE_OPTIONS, CREDENTIAL_KEY } from "./_shared/l2"

// Ongoing goods owner for the fixture integration (bead 9y2.9 made it required).
const GOODS_OWNER_ID = 7

// Layer 2 — bead m82: acquireSyncLock's CAS (`manager.nativeUpdate` with a WHERE clause
// matching the timestamptz lock column to its previously-observed value) is entirely
// mocked in the unit suite (src/modules/ongoing/__tests__/service.test.ts) — the mock
// can't prove real Postgres timestamptz/Date equality actually matches in the WHERE
// clause, nor that concurrent writers really do serialize through the DB rather than
// racing in application code. This spec boots the REAL `ongoing` module against real
// Postgres (no Ongoing involved) and exercises acquireSyncLock directly.
const LOCATION_ID = "loc_sync_lock"

const loggerInfo = jest.fn()
const spyLogger = {
  info: loggerInfo,
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
  activity: jest.fn(),
  progress: jest.fn(),
  success: jest.fn(),
  failure: jest.fn(),
  panic: jest.fn(),
  setLogLevel: jest.fn(),
  unsetLogLevel: jest.fn(),
  shouldLog: jest.fn(() => true),
}

moduleIntegrationTestRunner<OngoingModuleService>({
  moduleName: ONGOING_MODULE,
  moduleModels: [OngoingIntegration, OngoingOrderSync],
  moduleOptions: FAKE_OPTIONS,
  resolve: "./src/modules/ongoing",
  injectedDependencies: {
    [ContainerRegistrationKeys.LOGGER]: spyLogger,
  },
  testSuite: ({ service }) => {
    describe("acquireSyncLock — Layer 2 (real Postgres CAS)", () => {
      let integrationId: string

      beforeEach(async () => {
        const created = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          goods_owner_id: GOODS_OWNER_ID,
          stock_location_id: LOCATION_ID,
          enabled: true,
        })
        integrationId = created.id
      })

      it("acquires a free status_poll lock (currentValue=null CAS-matches column IS NULL on real PG)", async () => {
        const acquired = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        expect(acquired).toBe(true)
      })

      it("acquires a free stock_sync lock independently of status_poll", async () => {
        const acquired = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(acquired).toBe(true)
      })

      it("rejects a second acquire while the status_poll lock is held (short-circuit read matches CAS-protected state)", async () => {
        const first = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        const second = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        expect(first).toBe(true)
        expect(second).toBe(false)
      })

      it("rejects a second acquire while the stock_sync lock is held", async () => {
        const first = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        const second = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(first).toBe(true)
        expect(second).toBe(false)
      })

      it("status_poll and stock_sync locks are independent — holding one does not block the other (bead mjy core fix)", async () => {
        const statusPoll1 = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        expect(statusPoll1).toBe(true)

        // stock_sync must still be acquirable while status_poll is held.
        const stockSync1 = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(stockSync1).toBe(true)

        // Both are now held on their own columns — a second acquire of either fails.
        const statusPoll2 = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        const stockSync2 = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(statusPoll2).toBe(false)
        expect(stockSync2).toBe(false)
      })

      it("re-acquires status_poll after the TTL expires", async () => {
        const first = await service.acquireSyncLock(integrationId, 50, "status_poll")
        expect(first).toBe(true)

        // Still within TTL: blocked.
        const tooSoon = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        expect(tooSoon).toBe(false)

        await new Promise((resolve) => setTimeout(resolve, 150))

        const afterExpiry = await service.acquireSyncLock(integrationId, 60_000, "status_poll")
        expect(afterExpiry).toBe(true)
      })

      it("re-acquires stock_sync after releaseSyncLock resets the column to null (CAS matches column IS NULL again)", async () => {
        const first = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(first).toBe(true)

        await service.releaseSyncLock(integrationId, "stock_sync")

        const afterRelease = await service.acquireSyncLock(integrationId, 60_000, "stock_sync")
        expect(afterRelease).toBe(true)
      })

      it("concurrent racing acquires on the same free lock: exactly one wins (proves the DB-level CAS, not an application-level race)", async () => {
        // Two ticks both call acquireSyncLock "at once" against a free lock. Each does an
        // async read (retrieveOngoingIntegration) before its nativeUpdate write, so both
        // can observe column=null before either writes — the scenario a plain
        // read-then-write would double-acquire under. Only the DB-enforced
        // `WHERE ... AND column = null` (i.e. IS NULL) CAS can guarantee a single winner.
        const [a, b] = await Promise.all([
          service.acquireSyncLock(integrationId, 60_000, "status_poll"),
          service.acquireSyncLock(integrationId, 60_000, "status_poll"),
        ])

        const winners = [a, b].filter(Boolean)
        expect(winners).toHaveLength(1)
      })
    })
  },
})

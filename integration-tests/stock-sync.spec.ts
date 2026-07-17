import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import nock from "nock"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import ongoingStockSyncJob from "../src/jobs/stock-sync"
import {
  FAKE_OPTIONS,
  CREDENTIAL_KEY,
  ONGOING_BASE_URL,
  buildContainer,
} from "./_shared/l2"

// Layer 2 — wh5.6: ongoingStockSyncJob end-to-end inside a real DB-backed module
// container. The REAL ongoing module (real Postgres) drives the job's due/lock/
// full-sweep-vs-delta decisions off a REAL OngoingIntegration row, and persists the
// delta cursor / full-sweep timestamp the job writes back — the pure unit suite
// (src/jobs/__tests__/stock-sync.test.ts) mocks the service entirely, so it can't
// prove the cursor actually survives a round trip through Postgres. Ongoing's REST
// (GET /articles) is nock-stubbed; core Inventory module is absent from a module
// container, so it's faked here (same pattern as Modules.INVENTORY in
// reconcile-inventory-levels.test.ts) and its `updateInventoryLevels` calls are the
// assertion surface for "inventory reconciled per stock_reconcile_mode".
const STOCK_LOCATION_ID = "sloc_stock_sync_1"

type FakeItem = { id: string; sku: string }
type FakeLevel = {
  id: string
  inventory_item_id: string
  location_id: string
  stocked_quantity: number
  reserved_quantity: number
  incoming_quantity: number
  available_quantity: number
}
type FakeReservation = { line_item_id?: string | null; quantity: number; inventory_item_id?: string }

function makeFakeInventoryService(opts: {
  items?: FakeItem[]
  levels?: FakeLevel[]
  reservations?: FakeReservation[]
}) {
  const items = opts.items ?? []
  const levels = opts.levels ?? []
  const reservations = opts.reservations ?? []
  return {
    listInventoryItems: jest.fn(async ({ sku }: { sku: string[] }) =>
      items.filter((i) => sku.includes(i.sku))
    ),
    listInventoryLevels: jest.fn(
      async ({
        inventory_item_id,
        location_id,
      }: {
        inventory_item_id: string[]
        location_id: string
      }) =>
        levels.filter(
          (l) => inventory_item_id.includes(l.inventory_item_id) && l.location_id === location_id
        )
    ),
    listReservationItems: jest.fn(
      async ({ inventory_item_id }: { inventory_item_id: string[]; location_id: string }) =>
        reservations.filter(
          (r) => r.inventory_item_id != null && inventory_item_id.includes(r.inventory_item_id)
        )
    ),
    updateInventoryLevels: jest.fn(async () => undefined),
  }
}

// Fake query.graph for the "order" entity only — the shape reconcile-inventory-levels'
// precise mode reads (`entity: "order", fields: ["id", "items.id"]`).
function makeOrderQuery(orders: Array<{ id: string; items: Array<{ id: string }> }>) {
  const byId = new Map(orders.map((o) => [o.id, o]))
  const graph = jest.fn(async (config: { entity: string; filters?: Record<string, unknown> }) => {
    if (config.entity === "order") {
      const ids = (config.filters?.id as string[]) ?? []
      return { data: ids.map((id) => byId.get(id)).filter(Boolean) }
    }
    return { data: [] }
  })
  return { graph }
}

moduleIntegrationTestRunner<OngoingModuleService>({
  moduleName: ONGOING_MODULE,
  moduleModels: [OngoingIntegration, OngoingOrderSync],
  moduleOptions: FAKE_OPTIONS,
  resolve: "./src/modules/ongoing",
  testSuite: ({ service }) => {
    describe("stock-sync job — Layer 2 (real DB, nock-stubbed Ongoing)", () => {
      afterEach(() => {
        nock.cleanAll()
      })

      it("reconciles inventory in sellable_plus_reserved mode on a delta tick and advances the delta cursor in real Postgres", async () => {
        const seededCursor = "2026-07-10T00:00:00.000Z"
        const integration = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: STOCK_LOCATION_ID,
          enabled: true,
          stock_reconcile_mode: "sellable_plus_reserved",
          last_stock_sync_at: new Date(Date.now() - 700_000),
          last_stock_delta_cursor: seededCursor,
          // Recent full sweep → this tick must be a delta, not a full sweep.
          last_full_stock_sync_at: new Date(Date.now() - 60_000),
        })

        let capturedQuery: Record<string, unknown> | undefined
        const articles = nock(ONGOING_BASE_URL)
          .get("/articles")
          .query((q) => {
            capturedQuery = q
            return true
          })
          .reply(200, [
            {
              articleNumber: "SKU-1",
              articleSystemId: 1,
              inventoryInfo: {
                numberOfItems: 10,
                allocatedNumberOfItems: 3,
                sellableNumberOfItems: 7,
                toReceiveNumberOfItems: 2,
              },
            },
          ])

        const inventoryService = makeFakeInventoryService({
          items: [{ id: "item_1", sku: "SKU-1" }],
          levels: [
            {
              id: "lvl_1",
              inventory_item_id: "item_1",
              location_id: STOCK_LOCATION_ID,
              stocked_quantity: 0,
              reserved_quantity: 2,
              incoming_quantity: 0,
              available_quantity: 0,
            },
          ],
        })
        const { container } = buildContainer({ service, query: { graph: jest.fn() } })
        container.register(Modules.INVENTORY, asValue(inventoryService))

        await ongoingStockSyncJob(container)

        // (1) The Ongoing request was a delta pull (stockInfoChangedFrom = seeded cursor).
        expect(articles.isDone()).toBe(true)
        expect(capturedQuery?.stockInfoChangedFrom).toBe(seededCursor)

        // (2) sellable_plus_reserved: sellable(7) + min(reserved(2), allocated(3)) = 9.
        expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
          {
            id: "lvl_1",
            inventory_item_id: "item_1",
            location_id: STOCK_LOCATION_ID,
            stocked_quantity: 9,
            incoming_quantity: 2,
          },
        ])

        // (3) Real-DB value-add: the delta cursor persisted on the integration row
        // advances past the seeded value; the full-sweep clock is untouched by a
        // delta tick.
        const refreshed = await service.retrieveOngoingIntegration(integration.id)
        expect(refreshed.last_stock_delta_cursor).not.toBe(seededCursor)
        expect(Date.parse(refreshed.last_stock_delta_cursor as unknown as string)).toBeGreaterThan(
          Date.parse(seededCursor)
        )
        expect(refreshed.last_full_stock_sync_at?.toISOString()).toBe(
          integration.last_full_stock_sync_at?.toISOString()
        )
      })

      it("reconciles inventory in onhand mode using numberOfItems (ignores reserved/allocated)", async () => {
        await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: STOCK_LOCATION_ID,
          enabled: true,
          stock_reconcile_mode: "onhand",
          last_stock_sync_at: new Date(Date.now() - 700_000),
          last_stock_delta_cursor: "2026-07-10T00:00:00.000Z",
          last_full_stock_sync_at: new Date(Date.now() - 60_000),
        })

        nock(ONGOING_BASE_URL)
          .get("/articles")
          .query(true)
          .reply(200, [
            {
              articleNumber: "SKU-2",
              articleSystemId: 2,
              inventoryInfo: {
                numberOfItems: 15,
                allocatedNumberOfItems: 9,
                sellableNumberOfItems: 1,
                toReceiveNumberOfItems: 0,
              },
            },
          ])

        const inventoryService = makeFakeInventoryService({
          items: [{ id: "item_2", sku: "SKU-2" }],
          levels: [
            {
              id: "lvl_2",
              inventory_item_id: "item_2",
              location_id: STOCK_LOCATION_ID,
              stocked_quantity: 0,
              reserved_quantity: 9,
              incoming_quantity: 0,
              available_quantity: 0,
            },
          ],
        })
        const { container } = buildContainer({ service, query: { graph: jest.fn() } })
        container.register(Modules.INVENTORY, asValue(inventoryService))

        await ongoingStockSyncJob(container)

        // onhand: stocked_quantity = numberOfItems (15), reserved/allocated ignored.
        expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
          {
            id: "lvl_2",
            inventory_item_id: "item_2",
            location_id: STOCK_LOCATION_ID,
            stocked_quantity: 15,
            incoming_quantity: 0,
          },
        ])
      })

      it("reconciles inventory in precise mode using only reservations tied to a real 'sent' OngoingOrderSync row", async () => {
        const integration = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: STOCK_LOCATION_ID,
          enabled: true,
          stock_reconcile_mode: "precise",
          last_stock_sync_at: new Date(Date.now() - 700_000),
          last_stock_delta_cursor: "2026-07-10T00:00:00.000Z",
          last_full_stock_sync_at: new Date(Date.now() - 60_000),
        })

        // Real DB: only order_1 has been successfully sent to Ongoing.
        await service.createOngoingOrderSyncs({
          ongoing_order_number: "wh-a-1001",
          integration_id: integration.id,
          medusa_order_id: "order_1",
          medusa_fulfillment_id: "ful_1",
          sync_state: "sent",
        })

        nock(ONGOING_BASE_URL)
          .get("/articles")
          .query(true)
          .reply(200, [
            {
              articleNumber: "SKU-3",
              articleSystemId: 3,
              inventoryInfo: {
                numberOfItems: 20,
                allocatedNumberOfItems: 7,
                sellableNumberOfItems: 4,
                toReceiveNumberOfItems: 0,
              },
            },
          ])

        const inventoryService = makeFakeInventoryService({
          items: [{ id: "item_3", sku: "SKU-3" }],
          levels: [
            {
              id: "lvl_3",
              inventory_item_id: "item_3",
              location_id: STOCK_LOCATION_ID,
              stocked_quantity: 0,
              reserved_quantity: 7,
              incoming_quantity: 0,
              available_quantity: 0,
            },
          ],
          reservations: [
            // Tied to order_1's line item → order_1 is 'sent' → counted.
            { line_item_id: "li_1", quantity: 2, inventory_item_id: "item_3" },
            // Tied to a line item on an order that was never synced → excluded.
            { line_item_id: "li_2", quantity: 5, inventory_item_id: "item_3" },
          ],
        })
        const query = makeOrderQuery([{ id: "order_1", items: [{ id: "li_1" }] }])
        const { container } = buildContainer({ service, query })
        container.register(Modules.INVENTORY, asValue(inventoryService))

        await ongoingStockSyncJob(container)

        // precise: sellable(4) + M_res_synced(only li_1's 2, li_2 excluded) = 6.
        expect(inventoryService.updateInventoryLevels).toHaveBeenCalledWith([
          {
            id: "lvl_3",
            inventory_item_id: "item_3",
            location_id: STOCK_LOCATION_ID,
            stocked_quantity: 6,
            incoming_quantity: 0,
          },
        ])
      })

      it("triggers a full sweep (null changed_since) when the last full sweep is stale, and advances both cursors in real Postgres", async () => {
        const staleFullSweep = new Date(Date.now() - 7 * 60 * 60 * 1000) // 7h ago → due (> 6h)
        const integration = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: STOCK_LOCATION_ID,
          enabled: true,
          stock_reconcile_mode: "sellable_plus_reserved",
          last_stock_sync_at: new Date(Date.now() - 700_000),
          last_stock_delta_cursor: "2026-07-10T00:00:00.000Z",
          last_full_stock_sync_at: staleFullSweep,
        })

        let capturedQuery: Record<string, unknown> | undefined
        const articles = nock(ONGOING_BASE_URL)
          .get("/articles")
          .query((q) => {
            capturedQuery = q
            return true
          })
          .reply(200, [])

        const inventoryService = makeFakeInventoryService({})
        const { container } = buildContainer({ service, query: { graph: jest.fn() } })
        container.register(Modules.INVENTORY, asValue(inventoryService))

        await ongoingStockSyncJob(container)

        // (1) A full sweep never sends stockInfoChangedFrom.
        expect(articles.isDone()).toBe(true)
        expect(capturedQuery?.stockInfoChangedFrom).toBeUndefined()

        // (2) Real-DB value-add: both the delta cursor AND the full-sweep timestamp
        // advance together on a successful full sweep.
        const refreshed = await service.retrieveOngoingIntegration(integration.id)
        expect(refreshed.last_stock_delta_cursor).not.toBe("2026-07-10T00:00:00.000Z")
        expect(refreshed.last_full_stock_sync_at?.getTime()).toBeGreaterThan(
          staleFullSweep.getTime()
        )
      })

      it("does not advance the delta cursor in real Postgres when the workflow's Ongoing request fails", async () => {
        const seededCursor = "2026-07-10T00:00:00.000Z"
        const integration = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: STOCK_LOCATION_ID,
          enabled: true,
          stock_reconcile_mode: "sellable_plus_reserved",
          last_stock_sync_at: new Date(Date.now() - 700_000),
          last_stock_delta_cursor: seededCursor,
          last_full_stock_sync_at: new Date(Date.now() - 60_000),
        })

        // A terminal 400 (vs. a retryable 5xx) avoids the client's retry/backoff loop so
        // the assertion is fast and deterministic — the retry path itself is covered by
        // the unit suite (src/lib/ongoing/__tests__/client.*.test.ts).
        nock(ONGOING_BASE_URL).get("/articles").query(true).reply(400, { message: "boom" })

        const inventoryService = makeFakeInventoryService({})
        const { container } = buildContainer({ service, query: { graph: jest.fn() } })
        container.register(Modules.INVENTORY, asValue(inventoryService))

        // The job never rethrows (per-integration failures are caught + logged).
        await expect(ongoingStockSyncJob(container)).resolves.toBeUndefined()

        const refreshed = await service.retrieveOngoingIntegration(integration.id)
        expect(refreshed.last_stock_delta_cursor).toBe(seededCursor)
        // The lock must still be released even though the sync failed.
        expect(refreshed.stock_sync_lock_until).toBeNull()
      })
    })
  },
})

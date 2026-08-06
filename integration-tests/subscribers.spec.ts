import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import nock from "nock"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import orderCanceledHandler from "../src/subscribers/order-canceled"
import orderEditConfirmedHandler from "../src/subscribers/order-edit-confirmed"
import orderUpdatedHandler from "../src/subscribers/order-updated"
import fulfillmentCreatedHandler from "../src/subscribers/fulfillment-created"
import fulfillmentCanceledHandler from "../src/subscribers/fulfillment-canceled"
import { ONGOING_EVENTS } from "../src/lib/ongoing/events"
import {
  FAKE_OPTIONS,
  CREDENTIAL_KEY,
  ONGOING_BASE_URL,
  buildContainer,
  makeFakeQuery,
  makeFulfillmentFixture,
  type FulfillmentFixture,
  GOODS_OWNER_ID
} from "./_shared/l2"

// Layer 2 — wh5.5: invoke the plugin's subscriber handlers directly (a module
// container has no real event-bus/subscriber auto-wiring — see epic wh5's
// DESIGN) against a real Postgres-backed `ongoing` module, with the REAL
// downstream workflows (cancel-ongoing-order / sync-order-edit-to-ongoing /
// mark-order-sync-edit-blocked) running and Ongoing's REST nock-stubbed. The
// value over the mocked unit suite (src/subscribers/__tests__/*) is that
// OngoingOrderSync row transitions are asserted against REAL Postgres rows,
// not a mocked service.
const LOCATION_ID = "loc_1"

const spyLogger = {
  info: jest.fn(),
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

// order-updated's subscriber (and the sync-order-edit-to-ongoing workflow it
// drives) reads FOUR query.graph entities in one run: "order_change" (the
// burst-window rows), "ongoing_integration" (edit_sync_rules), and the
// "fulfillment" / "product_variant" pair the shared makeFakeQuery already
// answers for the order-mapper + SKU resolver. Local to this spec: no other
// L2 spec needs this exact four-entity mix yet.
function makeOrderUpdatedQuery(opts: {
  fulfillments: FulfillmentFixture[]
  changeRows: Array<{ id: string; created_at: string; type: string }>
  integrations: Array<{ id: string; edit_sync_rules: Record<string, number[]> | null }>
}) {
  const fallback = makeFakeQuery(opts.fulfillments)
  const graph = jest.fn(
    async (config: { entity: string; filters?: Record<string, unknown> }) => {
      if (config.entity === "order_change") {
        return {
          data: opts.changeRows.map((row) => ({
            id: row.id,
            change_type: "update_order",
            created_at: row.created_at,
            actions: [{ id: `${row.id}_act`, details: { type: row.type } }],
          })),
        }
      }
      if (config.entity === "ongoing_integration") {
        return { data: opts.integrations }
      }
      return fallback.graph(config)
    }
  )
  return { graph }
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
    describe("subscribers — Layer 2 (real DB, real workflows, nock-stubbed Ongoing)", () => {
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

      afterEach(() => {
        nock.cleanAll()
      })

      // ei4: the Ongoing order push and the single-fulfillment cancel used to live in the
      // fulfillment provider's createFulfillment/cancelFulfillment, and were covered at L2
      // by fulfillment-provider.spec.ts. Module isolation forced them out into these
      // app-scope subscribers, so the real-DB coverage moves here with them. The
      // subscriber unit tests (src/subscribers/__tests__/*) mock the workflows entirely —
      // these are the only tests that drive subscriber -> REAL workflow -> REAL Postgres row.
      describe("order.fulfillment_created -> push-order-to-ongoing workflow", () => {
        it("pushes and writes a real 'sent' OngoingOrderSync row in Postgres", async () => {
          nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 11 })
          const putOrder = nock(ONGOING_BASE_URL).put("/orders").reply(200, { orderId: 999 })

          const { container } = buildContainer({
            service,
            query: makeFakeQuery([makeFulfillmentFixture({ id: "ful_20" })]),
          })

          await fulfillmentCreatedHandler({
            event: { data: { order_id: "order_1", fulfillment_id: "ful_20" } },
            container,
          } as never)

          expect(putOrder.isDone()).toBe(true)
          const [row] = await service.listOngoingOrderSyncs({
            medusa_fulfillment_id: "ful_20",
          })
          expect(row).toMatchObject({
            sync_state: "sent",
            ongoing_order_id: 999,
            integration_id: integrationId,
          })
        })

        it("does not push a fulfillment created by another provider", async () => {
          // No nock interceptor: any Ongoing call would fail the test outright.
          const { container } = buildContainer({
            service,
            query: makeFakeQuery([
              makeFulfillmentFixture({ id: "ful_21", provider_id: "manual_manual" }),
            ]),
          })

          await fulfillmentCreatedHandler({
            event: { data: { order_id: "order_1", fulfillment_id: "ful_21" } },
            container,
          } as never)

          expect(await service.listOngoingOrderSyncs({})).toHaveLength(0)
        })

        it("records an 'error' row (and never throws) when Ongoing rejects the push", async () => {
          nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 11 })
          // Terminal 400 → no client retry loop, deterministic and fast.
          nock(ONGOING_BASE_URL).put("/orders").reply(400, { message: "boom" })

          const { container } = buildContainer({
            service,
            query: makeFakeQuery([makeFulfillmentFixture({ id: "ful_22" })]),
          })

          // Never-throw is the contract: the ledger row + retry job carry the failure.
          await expect(
            fulfillmentCreatedHandler({
              event: { data: { order_id: "order_1", fulfillment_id: "ful_22" } },
              container,
            } as never)
          ).resolves.toBeUndefined()

          const [row] = await service.listOngoingOrderSyncs({
            medusa_fulfillment_id: "ful_22",
          })
          expect(row.sync_state).toBe("error")
        })
      })

      describe("order.fulfillment_canceled -> cancel-ongoing-order workflow", () => {
        it("cancels the Ongoing order for that fulfillment and transitions its row to 'cancelled'", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            cancellable_status_codes: [100] as unknown as Record<string, unknown>,
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_30",
            medusa_fulfillment_id: "ful_30",
            ongoing_order_number: "1030-ful30",
            ongoing_order_id: 999,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const del = nock(ONGOING_BASE_URL).delete("/orders/999").reply(200, { orderId: 999 })
          const { container } = buildContainer({ service, query: makeFakeQuery([]) })

          await fulfillmentCanceledHandler({
            event: { data: { order_id: "order_30", fulfillment_id: "ful_30" } },
            container,
          } as never)

          expect(del.isDone()).toBe(true)
          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("cancelled")
        })

        it("is a no-op for a fulfillment that was never pushed to Ongoing (no sync row)", async () => {
          // No interceptor — an Ongoing call would fail the test.
          const { container } = buildContainer({ service, query: makeFakeQuery([]) })

          await expect(
            fulfillmentCanceledHandler({
              event: { data: { order_id: "order_31", fulfillment_id: "ful_31" } },
              container,
            } as never)
          ).resolves.toBeUndefined()
        })

        it("leaves the row 'sent' when Ongoing's cached status is not cancellable", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            cancellable_status_codes: [100] as unknown as Record<string, unknown>,
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_32",
            medusa_fulfillment_id: "ful_32",
            ongoing_order_number: "1032-ful32",
            ongoing_order_id: 999,
            latest_status_code: 400, // not in cancellable_status_codes
            sync_state: "sent",
          })

          const { container } = buildContainer({ service, query: makeFakeQuery([]) })

          await fulfillmentCanceledHandler({
            event: { data: { order_id: "order_32", fulfillment_id: "ful_32" } },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("sent")
        })
      })

      describe("order.canceled -> cancel-ongoing-order workflow", () => {
        it("cancels the Ongoing order and transitions the sync row to 'cancelled'", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            // cancellable_status_codes is a `model.json()` column typed as
            // Record<string, unknown> — cast, matching update-ongoing-integration.ts's
            // established pattern for this same field.
            cancellable_status_codes: [100] as unknown as Record<string, unknown>,
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_10",
            medusa_fulfillment_id: "ful_10",
            ongoing_order_number: "1010-ful10",
            ongoing_order_id: 999,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const del = nock(ONGOING_BASE_URL).delete("/orders/999").reply(200, { orderId: 999 })
          const { container, eventBus } = buildContainer({
            service,
            query: makeFakeQuery([]),
          })

          await orderCanceledHandler({
            event: { data: { id: "order_10" } },
            container,
          } as never)

          expect(del.isDone()).toBe(true)
          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("cancelled")
          expect(eventBus.emit).toHaveBeenCalledWith({
            name: ONGOING_EVENTS.ORDER_CANCELLED,
            data: expect.objectContaining({
              medusa_order_id: "order_10",
              ongoing_order_number: "1010-ful10",
              ongoing_order_sync_id: row.id,
            }),
          })
        })

        it("is idempotent: a duplicate order.canceled on an already-cancelled row makes no Ongoing call", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            cancellable_status_codes: [100] as unknown as Record<string, unknown>,
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_11",
            medusa_fulfillment_id: "ful_11",
            ongoing_order_number: "1011-ful11",
            ongoing_order_id: 998,
            latest_status_code: 100,
            sync_state: "cancelled",
          })

          // No nock interceptor registered: a DELETE call would throw (nock
          // has no matching mock), which the workflow would surface as an
          // uncaught rejection out of the handler — asserting resolves proves
          // no HTTP call was attempted.
          const { container, eventBus } = buildContainer({
            service,
            query: makeFakeQuery([]),
          })

          await expect(
            orderCanceledHandler({
              event: { data: { id: "order_11" } },
              container,
            } as never)
          ).resolves.toBeUndefined()

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("cancelled")
          expect(eventBus.emit).not.toHaveBeenCalled()
        })

        it("leaves the row 'sent' (not cancelled) when the cached status is not in cancellable_status_codes", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            // order status 100 is NOT in this list
            cancellable_status_codes: [400] as unknown as Record<string, unknown>,
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_12",
            medusa_fulfillment_id: "ful_12",
            ongoing_order_number: "1012-ful12",
            ongoing_order_id: 997,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const { container, eventBus } = buildContainer({
            service,
            query: makeFakeQuery([]),
          })

          await orderCanceledHandler({
            event: { data: { id: "order_12" } },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("sent")
          expect(eventBus.emit).not.toHaveBeenCalled()
        })
      })

      describe("order-edit.confirmed -> sync-order-edit-to-ongoing / mark-order-sync-edit-blocked workflows", () => {
        it("re-syncs a line_items edit and transitions the row to 'sent' (edit-synced)", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { line_items: [100] },
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_20",
            medusa_fulfillment_id: "ful_20",
            ongoing_order_number: "1020-ful20",
            ongoing_order_id: 900,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const fixture = makeFulfillmentFixture({ id: "ful_20" })
          nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 21 })
          nock(ONGOING_BASE_URL).put("/orders").reply(200, { orderId: 901 })
          const { container } = buildContainer({
            service,
            query: makeFakeQuery([fixture]),
          })

          await orderEditConfirmedHandler({
            event: {
              data: {
                order_id: "order_20",
                actions: [{ action: "ITEM_UPDATE" }],
              },
            },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after).toMatchObject({
            sync_state: "sent",
            ongoing_order_id: 901,
            edit_blocked_at: null,
          })
        })

        it("blocks a line_items edit and persists edit_blocked_* when the status is not in edit_sync_rules", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { line_items: [999] }, // row's status 100 is NOT allowed
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_21",
            medusa_fulfillment_id: "ful_21",
            ongoing_order_number: "1021-ful21",
            ongoing_order_id: 902,
            latest_status_code: 100,
            sync_state: "sent",
          })

          // No nock interceptors: the blocked path short-circuits before any
          // Ongoing HTTP call, so any attempted call would throw.
          const { container, eventBus } = buildContainer({
            service,
            query: makeFakeQuery([]),
          })

          await orderEditConfirmedHandler({
            event: {
              data: {
                order_id: "order_21",
                actions: [{ action: "ITEM_ADD" }],
              },
            },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after).toMatchObject({
            sync_state: "sent", // unchanged: blocking never flips sync_state
            edit_blocked_category: "line_items",
            edit_blocked_reason: "status_blocked",
          })
          expect(after.edit_blocked_at).not.toBeNull()
          expect(eventBus.emit).toHaveBeenCalledWith({
            name: ONGOING_EVENTS.EDIT_BLOCKED,
            data: expect.objectContaining({
              medusa_order_id: "order_21",
              ongoing_order_sync_id: row.id,
              category: "line_items",
            }),
          })
        })

        it("clears a stale edit_blocked_at once a later edit re-syncs successfully (blocked -> edit-synced)", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { line_items: [100] },
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_22",
            medusa_fulfillment_id: "ful_22",
            ongoing_order_number: "1022-ful22",
            ongoing_order_id: 903,
            latest_status_code: 100,
            sync_state: "sent",
            edit_blocked_at: new Date(),
            edit_blocked_category: "line_items",
            edit_blocked_reason: "status_blocked",
          })

          const fixture = makeFulfillmentFixture({ id: "ful_22" })
          nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 22 })
          nock(ONGOING_BASE_URL).put("/orders").reply(200, { orderId: 904 })
          const { container } = buildContainer({
            service,
            query: makeFakeQuery([fixture]),
          })

          await orderEditConfirmedHandler({
            event: {
              data: {
                order_id: "order_22",
                actions: [{ action: "ITEM_UPDATE" }],
              },
            },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after.sync_state).toBe("sent")
          expect(after.ongoing_order_id).toBe(904)
          expect(after.edit_blocked_at).toBeNull()
          expect(after.edit_blocked_category).toBeNull()
          expect(after.edit_blocked_reason).toBeNull()
        })
      })

      describe("order.updated -> burst gating + sync-order-edit-to-ongoing (address_contact)", () => {
        it("unions a bundled burst (address change + unrelated locale change) and re-syncs (regression #110)", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { address_contact: [100] },
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_30",
            medusa_fulfillment_id: "ful_30",
            ongoing_order_number: "1030-ful30",
            ongoing_order_id: 910,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const fixture = makeFulfillmentFixture({ id: "ful_30" })
          nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 31 })
          nock(ONGOING_BASE_URL).put("/orders").reply(200, { orderId: 911 })
          const query = makeOrderUpdatedQuery({
            fulfillments: [fixture],
            // Newest row (DESC[0]) is "locale"; a pre-#110-fix take:1 query would
            // read only it and silently miss the real shipping_address change
            // from the same updateOrderWorkflow burst.
            changeRows: [
              { id: "ordch_2", created_at: "2026-07-17T10:00:00.010Z", type: "locale" },
              { id: "ordch_1", created_at: "2026-07-17T10:00:00.000Z", type: "shipping_address" },
            ],
            integrations: [{ id: integrationId, edit_sync_rules: { address_contact: [100] } }],
          })
          const { container } = buildContainer({ service, query })

          await orderUpdatedHandler({
            event: { data: { id: "order_30" } },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after).toMatchObject({ sync_state: "sent", ongoing_order_id: 911 })
        })

        it("blocks an address_contact edit and persists edit_blocked_* when the status is not allowed", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { address_contact: [999] }, // row's status 100 is NOT allowed
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_31",
            medusa_fulfillment_id: "ful_31",
            ongoing_order_number: "1031-ful31",
            ongoing_order_id: 912,
            latest_status_code: 100,
            sync_state: "sent",
          })

          const query = makeOrderUpdatedQuery({
            fulfillments: [],
            changeRows: [
              { id: "ordch_3", created_at: "2026-07-17T11:00:00.000Z", type: "shipping_address" },
            ],
            integrations: [{ id: integrationId, edit_sync_rules: { address_contact: [999] } }],
          })
          const { container, eventBus } = buildContainer({ service, query })

          await orderUpdatedHandler({
            event: { data: { id: "order_31" } },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after).toMatchObject({
            sync_state: "sent",
            edit_blocked_category: "address_contact",
            edit_blocked_reason: "status_blocked",
          })
          expect(after.edit_blocked_at).not.toBeNull()
          expect(eventBus.emit).toHaveBeenCalledWith({
            name: ONGOING_EVENTS.EDIT_BLOCKED,
            data: expect.objectContaining({
              medusa_order_id: "order_31",
              ongoing_order_sync_id: row.id,
              category: "address_contact",
            }),
          })
        })

        it("is a no-op (burst gating) when the burst has no address/contact/email change", async () => {
          await service.updateOngoingIntegrations({
            id: integrationId,
            edit_sync_rules: { address_contact: [100] },
          })
          const row = await service.createOngoingOrderSyncs({
            integration_id: integrationId,
            medusa_order_id: "order_32",
            medusa_fulfillment_id: "ful_32",
            ongoing_order_number: "1032-ful32",
            ongoing_order_id: 913,
            latest_status_code: 100,
            sync_state: "sent",
          })

          // Only a "locale" change in the burst — no shipping_address/billing_address/
          // email — so hasAddressContactChange is false and the handler must return
          // before ever resolving the ongoing module or query for sync rows/integrations.
          const query = makeOrderUpdatedQuery({
            fulfillments: [],
            changeRows: [
              { id: "ordch_4", created_at: "2026-07-17T12:00:00.000Z", type: "locale" },
            ],
            integrations: [],
          })
          const { container, eventBus } = buildContainer({ service, query })

          await orderUpdatedHandler({
            event: { data: { id: "order_32" } },
            container,
          } as never)

          const [after] = await service.listOngoingOrderSyncs({ id: row.id })
          expect(after).toMatchObject({ sync_state: "sent", edit_blocked_at: null })
          expect(eventBus.emit).not.toHaveBeenCalled()
        })
      })
    })
  },
})

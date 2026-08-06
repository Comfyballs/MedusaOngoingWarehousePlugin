import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import nock from "nock"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import pushOrderToOngoing from "../src/workflows/push-order-to-ongoing"
import {
  FAKE_OPTIONS,
  CREDENTIAL_KEY,
  GOODS_OWNER_ID,
  ONGOING_BASE_URL,
  buildContainer,
  makeFakeQuery,
  makeFulfillmentFixture,
} from "./_shared/l2"

// Layer 2 — wh5.3: push-order-to-ongoing end-to-end inside a real DB-backed module
// container. The REAL ongoing module (real Postgres) persists the OngoingOrderSync
// ledger; the REAL order mapper + REAL SKU resolver run against a fake query.graph;
// Ongoing's REST is nock-stubbed. This proves the workflow + record-sync wiring the
// pure unit suite (src/workflows/__tests__/push-order-to-ongoing.test.ts) mocks away.
const LOCATION_ID = "loc_1"

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
    describe("push-order-to-ongoing — Layer 2 (real DB, nock-stubbed Ongoing)", () => {
      let integrationId: string

      beforeEach(async () => {
        // The runner resets the DB per test (its beforeEach re-inits the module), so the
        // integration row is seeded per test. Runs AFTER the runner's beforeEach (jest
        // ordering), so `service` is a live, DB-backed module service here. Bound to the
        // fulfillment's stock location so resolveIntegrationContext reads it from Postgres.
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

      it("maps + PUTs the order and persists a 'sent' OngoingOrderSync row (real DB)", async () => {
        const fixture = makeFulfillmentFixture({ id: "ful_1" })
        const { container } = buildContainer({
          service,
          query: makeFakeQuery([fixture]),
        })

        // Capture the PostOrderModel the client actually PUTs so we assert the real
        // mapper's output, not a mocked payload.
        let putBody: any
        const articles = nock(ONGOING_BASE_URL)
          .put("/articles")
          .reply(200, { articleSystemId: 11 })
        const orders = nock(ONGOING_BASE_URL)
          .put("/orders", (body) => {
            putBody = body
            return true
          })
          .reply(200, { orderId: 999 })

        const { result } = await pushOrderToOngoing(container).run({
          input: { fulfillment_id: "ful_1" },
        })

        // (1) Ongoing order create called with a correctly-mapped PostOrderModel.
        expect(articles.isDone()).toBe(true)
        expect(orders.isDone()).toBe(true)
        expect(putBody).toMatchObject({
          goodsOwnerId: GOODS_OWNER_ID,
          orderNumber: result.orderNumber,
          consignee: { name: "Jo Doe", countryCode: "no", postCode: "0001" },
          orderLines: [
            expect.objectContaining({ articleNumber: "SKU-1", numberOfItems: 2 }),
          ],
        })
        expect(result.ongoingOrderId).toBe(999)

        // (2) A real OngoingOrderSync row persisted, transitioned to 'sent'.
        const [row] = await service.listOngoingOrderSyncs({
          ongoing_order_number: result.orderNumber,
        })
        expect(row).toMatchObject({
          sync_state: "sent",
          ongoing_order_id: 999,
          medusa_order_id: "order_1",
          medusa_fulfillment_id: "ful_1",
          integration_id: integrationId,
          error_class: null,
        })
      })

      it("records an 'error' row (no rollback) when the Ongoing PUT fails terminally", async () => {
        // NB: pushOrderRecordSyncStep has NO compensation — on a downstream failure it
        // records the error on the sync ledger and rethrows (by design). A terminal
        // status (400) avoids the client's retry loop so the assertion is deterministic;
        // the retryable path + backoff are covered in the unit suite.
        const fixture = makeFulfillmentFixture({
          id: "ful_2",
          order: { ...makeFulfillmentFixture().order, id: "order_2", display_id: 1002 },
        })
        const { container } = buildContainer({
          service,
          query: makeFakeQuery([fixture]),
        })

        nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 12 })
        nock(ONGOING_BASE_URL).put("/orders").reply(400, { message: "bad request" })

        await expect(
          pushOrderToOngoing(container).run({ input: { fulfillment_id: "ful_2" } })
        ).rejects.toBeDefined()

        const [row] = await service.listOngoingOrderSyncs({ medusa_order_id: "order_2" })
        expect(row).toMatchObject({
          sync_state: "error",
          error_class: "terminal",
          medusa_fulfillment_id: "ful_2",
        })
        expect(row.last_error).toContain("400")
        // The failed order was never marked sent and carries no Ongoing id.
        expect(row.ongoing_order_id).toBeNull()
      })
    })
  },
})

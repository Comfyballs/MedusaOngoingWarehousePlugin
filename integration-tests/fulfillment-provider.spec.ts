import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import nock from "nock"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import OngoingModuleService from "../src/modules/ongoing/service"
import OngoingIntegration from "../src/modules/ongoing/models/integration"
import OngoingOrderSync from "../src/modules/ongoing/models/order-sync"
import OngoingFulfillmentProviderService from "../src/providers/ongoing-fulfillment/service"
import {
  FAKE_OPTIONS,
  CREDENTIAL_KEY,
  ONGOING_BASE_URL,
  buildContainer,
  makeFakeQuery,
  makeFulfillmentFixture,
} from "./_shared/l2"

// Layer 2 — wh5.4: the Ongoing fulfillment PROVIDER driving create + cancel against the
// REAL ongoing module (real Postgres) with Ongoing's REST nock-stubbed. We invoke the
// provider methods directly on a container holding the real service (registering the
// provider under the real @medusajs/medusa/fulfillment module + having Medusa's core
// FulfillmentModuleService call it needs a full app — deferred to bead wh5.9). This
// proves createFulfillment -> push -> real sync row, and cancelFulfillment -> cancel
// workflow -> row transition, end-to-end through the real workflows.
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

moduleIntegrationTestRunner<OngoingModuleService>({
  moduleName: ONGOING_MODULE,
  moduleModels: [OngoingIntegration, OngoingOrderSync],
  moduleOptions: FAKE_OPTIONS,
  resolve: "./src/modules/ongoing",
  injectedDependencies: {
    [ContainerRegistrationKeys.LOGGER]: spyLogger,
  },
  testSuite: ({ service }) => {
    describe("ongoing-fulfillment provider — Layer 2 (real DB, nock-stubbed Ongoing)", () => {
      let integrationId: string

      // Provider bound to a container holding the real, DB-backed ongoing service.
      function makeProvider() {
        const { container } = buildContainer({
          service,
          query: makeFakeQuery([makeFulfillmentFixture({ id: "ful_1" })]),
        })
        return new OngoingFulfillmentProviderService(container, {})
      }

      beforeEach(async () => {
        const created = await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: LOCATION_ID,
          enabled: true,
        })
        integrationId = created.id
      })

      afterEach(() => {
        nock.cleanAll()
      })

      it("createFulfillment resolves the integration, pushes, and stashes the Ongoing ids", async () => {
        nock(ONGOING_BASE_URL).put("/articles").reply(200, { articleSystemId: 11 })
        nock(ONGOING_BASE_URL).put("/orders").reply(200, { orderId: 999 })

        const provider = makeProvider()
        const result = await provider.createFulfillment(
          {},
          [{ id: "fi_1" }] as never,
          undefined,
          { id: "ful_1", location_id: LOCATION_ID } as never
        )

        // Provider returns the stash cancelFulfillment later relies on.
        expect(result.labels).toEqual([])
        expect(result.data).toMatchObject({
          ongoing_order_id: 999,
          location_id: LOCATION_ID,
          credential_key: CREDENTIAL_KEY,
        })
        expect(typeof result.data.ongoing_order_number).toBe("string")

        // A real 'sent' OngoingOrderSync row landed in Postgres.
        const [row] = await service.listOngoingOrderSyncs({
          ongoing_order_number: result.data.ongoing_order_number as string,
        })
        expect(row).toMatchObject({
          sync_state: "sent",
          ongoing_order_id: 999,
          medusa_fulfillment_id: "ful_1",
          integration_id: integrationId,
        })
      })

      it("cancelFulfillment cancels the Ongoing order and marks the sync row cancelled", async () => {
        // Seed a real 'sent' row (as createFulfillment would have left it).
        await service.recordSync({
          ongoing_order_number: "1001-ful1",
          integration_id: integrationId,
          medusa_order_id: "order_1",
          medusa_fulfillment_id: "ful_1",
          sync_state: "sent",
          ongoing_order_id: 999,
        })

        const del = nock(ONGOING_BASE_URL).delete("/orders/999").reply(200, { orderId: 999 })

        const provider = makeProvider()
        const result = await provider.cancelFulfillment({
          ongoing_order_number: "1001-ful1",
          medusa_fulfillment_id: "ful_1",
          medusa_order_id: "order_1",
          location_id: LOCATION_ID,
          credential_key: CREDENTIAL_KEY,
        })

        expect(del.isDone()).toBe(true)
        expect(result).toMatchObject({ canceled: true })

        const [row] = await service.listOngoingOrderSyncs({ ongoing_order_number: "1001-ful1" })
        expect(row.sync_state).toBe("cancelled")
      })

      it("cancelFulfillment is an idempotent no-op when the stash has no identifiers", async () => {
        const provider = makeProvider()
        // No Ongoing call must happen; disable any accidental interception.
        const result = await provider.cancelFulfillment({ location_id: LOCATION_ID })

        expect(result).toMatchObject({ canceled: false, reason: "no_identifier" })
      })
    })
  },
})

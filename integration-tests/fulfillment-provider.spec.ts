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

// Layer 2 — the Ongoing fulfillment PROVIDER against the REAL ongoing module (real
// Postgres), with Ongoing's REST nock-stubbed.
//
// REWRITTEN FOR ei4. This spec used to assert the pre-ei4 contract: that
// createFulfillment itself resolved the integration, pushed to Ongoing and stashed the
// resulting ids, and that cancelFulfillment cancelled the Ongoing order. That contract is
// GONE. A fulfillment provider is instantiated by @medusajs/fulfillment's provider loader
// into the fulfillment module's OWN isolated container, which by Medusa module isolation
// has no sibling `ongoing` module, no `query` and no workflow engine — so no provider
// method can do any of that in a real app (it threw AwilixResolutionError; the old spec
// only passed because it hand-built a container that had `ongoing` registered).
//
// The provider is now thin: validate + stash. The push/cancel orchestration moved to
// app-scope subscribers, and its real-DB coverage lives in subscribers.spec.ts
// ("order.fulfillment_created" / "order.fulfillment_canceled"). What this spec pins is the
// thin contract itself — including, importantly, that these methods make NO Ongoing call
// and touch NO sync row, since that is exactly what module isolation forces.
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
      function makeProvider() {
        const { container } = buildContainer({
          service,
          query: makeFakeQuery([makeFulfillmentFixture({ id: "ful_1" })]),
        })
        return new OngoingFulfillmentProviderService(container, {})
      }

      beforeEach(async () => {
        await service.createOngoingIntegrations({
          credential_key: CREDENTIAL_KEY,
          stock_location_id: LOCATION_ID,
          enabled: true,
        })
      })

      afterEach(() => {
        nock.cleanAll()
      })

      it("[ei4] createFulfillment stashes only the identifiers, makes no Ongoing call and writes no sync row", async () => {
        // Any outbound Ongoing request would be an unmatched-host error rather than a
        // silent pass, because nock is active with no interceptor registered for it.
        const provider = makeProvider()
        const result = await provider.createFulfillment(
          {},
          [{ id: "fi_1" }] as never,
          undefined,
          { id: "ful_1", location_id: LOCATION_ID } as never
        )

        expect(result.labels).toEqual([])
        expect(result.data).toEqual({
          location_id: LOCATION_ID,
          medusa_fulfillment_id: "ful_1",
        })
        // Pre-ei4 this call left a 'sent' row behind; the push now happens in the
        // subscriber, so nothing may have been written here.
        expect(await service.listOngoingOrderSyncs({})).toHaveLength(0)
      })

      it("[ei4] createFulfillment throws INVALID_DATA when location_id is missing rather than guessing a warehouse", async () => {
        const provider = makeProvider()

        await expect(
          provider.createFulfillment({}, [{ id: "fi_1" }] as never, undefined, {
            id: "ful_1",
          } as never)
        ).rejects.toThrow(/location_id is missing/)
      })

      it("[ei4] createFulfillment throws INVALID_DATA when the fulfillment id is missing", async () => {
        const provider = makeProvider()

        await expect(
          provider.createFulfillment({}, [{ id: "fi_1" }] as never, undefined, {
            location_id: LOCATION_ID,
          } as never)
        ).rejects.toThrow(/fulfillment\.id is missing/)
      })

      it("[ei4] cancelFulfillment is a non-throwing no-op: no Ongoing call, sync row untouched", async () => {
        // A real 'sent' row that the OLD provider would have cancelled directly.
        const row = await service.recordSync({
          ongoing_order_number: "1001-ful1",
          integration_id: (await service.listOngoingIntegrations({}))[0].id,
          medusa_order_id: "order_1",
          medusa_fulfillment_id: "ful_1",
          sync_state: "sent",
          ongoing_order_id: 999,
        })

        const provider = makeProvider()
        const stash = {
          location_id: LOCATION_ID,
          medusa_fulfillment_id: "ful_1",
        }
        const result = await provider.cancelFulfillment(stash)

        // It must not throw — throwing here would abort Medusa's own cancel — and it
        // hands the stash back untouched. The Ongoing-side cancel is the
        // order.fulfillment_canceled subscriber's job.
        expect(result).toEqual(stash)

        const [after] = await service.listOngoingOrderSyncs({ id: row.id })
        expect(after.sync_state).toBe("sent")
      })

      it("[ei4] cancelFulfillment tolerates an empty/undefined stash", async () => {
        const provider = makeProvider()

        await expect(
          provider.cancelFulfillment(undefined as never)
        ).resolves.toEqual({})
      })

      it("[ei4] createReturnFulfillment stashes the return fulfillment id and makes no Ongoing call", async () => {
        const provider = makeProvider()
        const result = await provider.createReturnFulfillment({ id: "ret_ful_1" })

        expect(result.labels).toEqual([])
        expect(result.data).toEqual({ medusa_return_fulfillment_id: "ret_ful_1" })
        expect(await service.listOngoingOrderSyncs({})).toHaveLength(0)
      })

      it("[ei4] createReturnFulfillment throws INVALID_DATA without a return fulfillment id", async () => {
        const provider = makeProvider()

        await expect(provider.createReturnFulfillment({})).rejects.toThrow(
          /return fulfillment\.id is missing/
        )
      })
    })
  },
})

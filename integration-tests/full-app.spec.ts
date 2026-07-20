import path from "path"

// medusaIntegrationTestRunner (unlike the plugin-local moduleIntegrationTestRunner
// specs) routes DB setup through @medusajs/test-utils' configLoaderOverride, which
// only skips its remote-DB `ssl: { rejectUnauthorized: false }` driverOptions when
// the computed clientUrl's host literally contains the string "localhost". Our L2
// suite's shared integration-tests/setup-env.ts sets DB_HOST=127.0.0.1 (an IP, not
// that literal string) — every OTHER spec here uses moduleIntegrationTestRunner,
// which never calls configLoaderOverride, so this never surfaced before. Left as
// "127.0.0.1", every DB connection attempt against the plain (non-SSL) docker
// Postgres hangs and eventually fails with a misleading Knex "pool is probably
// full" timeout. Force "localhost" here, before medusaIntegrationTestRunner reads
// it to build the throwaway DB's clientUrl.
process.env.DB_HOST = "localhost"

import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  IFulfillmentModuleService,
  IOrderModuleService,
  IStockLocationService,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import nock from "nock"
import { ONGOING_MODULE } from "../src/modules/ongoing"
import type OngoingModuleService from "../src/modules/ongoing/service"

// Layer 2 — wh5.8 / wh5.9: the ONE piece the plugin-local moduleIntegrationTestRunner
// specs cannot exercise — a module container has no core Order/Fulfillment/StockLocation
// modules and no real @medusajs/medusa/fulfillment provider registration. This spec
// boots a REAL, full Medusa app (core modules + our `ongoing` module + the
// `ongoing-fulfillment` provider, registered by source path from
// integration-tests/full-app-fixture/medusa-config.js — see bead onk) via
// medusaIntegrationTestRunner, against real Postgres, with Ongoing's REST nock-stubbed.
//
// It proves:
//   (wh5.8) the plugin's defineLink associations resolve through a REAL query.graph
//     across core modules (confirms the link-table migrations actually apply), and
//   (wh5.9a) the ongoing-fulfillment provider registers under core
//     @medusajs/medusa/fulfillment.
//
// It also PROVES bug ei4 is FIXED (wh5.9b): before the fix, driving createFulfillment
// through the core FulfillmentModuleService into the ongoing provider threw
// `AwilixResolutionError: Could not resolve 'ongoing'`, because a fulfillment provider
// runs in the fulfillment module's ISOLATED container and could not resolve the sibling
// `ongoing` module / workflow engine its createFulfillment then needed. The fix moved
// that cross-module orchestration OUT of the provider into app-scope subscribers
// (src/subscribers/fulfillment-created.ts et al.), so the provider's createFulfillment
// is now thin (validate + stash) and no longer touches a sibling module. wh5.9b asserts
// that thin, no-throw contract. (The async Ongoing push the subscriber then performs is
// covered deterministically by the subscriber unit tests; this fixture registers only
// modules + links, not subscribers, so it intentionally does not exercise the push.)
const FIXTURE_CWD = path.join(__dirname, "full-app-fixture")

// Per @medusajs/fulfillment's provider loader, a provider's resolvable id (stored on
// fulfillment.provider_id, returned by listFulfillmentProviders) is
// `${identifier}_${config-id}`. Our fixture registers the ongoing provider with
// id "ongoing" against a class whose static identifier is also "ongoing"
// (ONGOING_PROVIDER_ID) → "ongoing_ongoing"; the core manual provider (identifier
// "manual", id "manual") → "manual_manual".
const ONGOING_PROVIDER_ID = "ongoing_ongoing"
const MANUAL_PROVIDER_ID = "manual_manual"

type FulfillmentLike = { id: string; data: Record<string, unknown> | null }

// The Link (remoteLink) module's create() accepts the object form
// `{ [moduleKey]: { <fk>: value } }` at runtime, but @medusajs/types' ILinkModule
// types create() for the tuple form only — annotate the minimal shape used here.
type LinkService = {
  create: (link: Record<string, Record<string, unknown>>) => Promise<unknown>
}

medusaIntegrationTestRunner({
  cwd: FIXTURE_CWD,
  moduleName: "full-app",
  testSuite: ({ getContainer }) => {
    describe("full-app harness (wh5.8 / wh5.9) — real Postgres + core modules, nock-stubbed Ongoing", () => {
      afterEach(() => {
        nock.cleanAll()
      })

      it("wh5.8: OngoingOrderSync<->order, OngoingOrderSync<->fulfillment, OngoingIntegration<->stock_location resolve via a real query.graph", async () => {
        const container = getContainer()
        const query = container.resolve<Omit<RemoteQueryFunction, symbol>>(
          ContainerRegistrationKeys.QUERY
        )
        const link = container.resolve<LinkService>(ContainerRegistrationKeys.LINK)
        const ongoingService = container.resolve<OngoingModuleService>(ONGOING_MODULE)
        const stockLocationService = container.resolve<IStockLocationService>(
          Modules.STOCK_LOCATION
        )
        const orderService = container.resolve<IOrderModuleService>(Modules.ORDER)
        const fulfillmentService = container.resolve<IFulfillmentModuleService>(
          Modules.FULFILLMENT
        )

        const location = await stockLocationService.createStockLocations({
          name: "wh5.8 Test Warehouse",
        })
        const integration = await ongoingService.createOngoingIntegrations({
          credential_key: "test-wh",
          stock_location_id: location.id,
          enabled: true,
        })
        const [order] = await orderService.createOrders([
          {
            currency_code: "usd",
            email: "wh58@example.com",
            items: [{ title: "Test Product", quantity: 1, unit_price: 20 }],
          },
        ])

        // A REAL core fulfillment record, created via the MANUAL provider so this test
        // exercises the OngoingOrderSync<->fulfillment link without tripping bug ei4 in
        // the ongoing provider (see fixture medusa-config.js). The link resolution under
        // test is independent of which provider created the fulfillment.
        const fulfillment = (await fulfillmentService.createFulfillment({
          location_id: location.id,
          provider_id: MANUAL_PROVIDER_ID,
          delivery_address: {
            first_name: "Jo",
            last_name: "Doe",
            address_1: "1 Main St",
            city: "Town",
            postal_code: "0001",
            country_code: "no",
            phone: "123",
          },
          items: [{ title: "Test Product", quantity: 1, sku: "SKU-WH58", barcode: "" }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)) as unknown as FulfillmentLike

        // Seed the OngoingOrderSync ledger row directly (the plugin's own workflow would
        // normally write it during the push, but that path is blocked by ei4).
        const sync = await ongoingService.createOngoingOrderSyncs({
          integration_id: integration.id,
          medusa_order_id: order.id,
          medusa_fulfillment_id: fulfillment.id,
          ongoing_order_number: "WH58-1",
          ongoing_order_id: 5801,
          sync_state: "sent",
        })

        // Create the three defineLink associations under test.
        await link.create({
          [ONGOING_MODULE]: { ongoing_order_sync_id: sync.id },
          [Modules.ORDER]: { order_id: order.id },
        })
        await link.create({
          [ONGOING_MODULE]: { ongoing_order_sync_id: sync.id },
          [Modules.FULFILLMENT]: { fulfillment_id: fulfillment.id },
        })
        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
          [ONGOING_MODULE]: { ongoing_integration_id: integration.id },
        })

        // --- OngoingOrderSync -> order ---
        const { data: syncWithOrder } = await query.graph({
          entity: "ongoing_order_sync",
          fields: ["id", "order.id", "order.email", "order.currency_code"],
          filters: { id: sync.id },
        })
        expect(syncWithOrder).toHaveLength(1)
        expect(syncWithOrder[0].order).toMatchObject({
          id: order.id,
          email: "wh58@example.com",
          currency_code: "usd",
        })

        // --- OngoingOrderSync -> fulfillment ---
        const { data: syncWithFulfillment } = await query.graph({
          entity: "ongoing_order_sync",
          fields: ["id", "fulfillment.id", "fulfillment.location_id"],
          filters: { id: sync.id },
        })
        expect(syncWithFulfillment[0].fulfillment).toMatchObject({
          id: fulfillment.id,
          location_id: location.id,
        })

        // --- OngoingIntegration -> stock_location ---
        const { data: integrationWithLocation } = await query.graph({
          entity: "ongoing_integration",
          fields: ["id", "stock_location.id", "stock_location.name"],
          filters: { id: integration.id },
        })
        expect(integrationWithLocation[0].stock_location).toMatchObject({
          id: location.id,
          name: "wh5.8 Test Warehouse",
        })

        // --- reverse: stock_location -> ongoing_integration ---
        const { data: locationWithIntegration } = await query.graph({
          entity: "stock_location",
          fields: ["id", "ongoing_integration.id", "ongoing_integration.credential_key"],
          filters: { id: location.id },
        })
        expect(locationWithIntegration[0].ongoing_integration).toMatchObject({
          id: integration.id,
          credential_key: "test-wh",
        })
      })

      it("wh5.9a: the ongoing-fulfillment provider registers under core @medusajs/medusa/fulfillment", async () => {
        const container = getContainer()
        // The provider's `fp_ongoing_ongoing` container registration lives in the
        // fulfillment module's OWN (isolated) container, not the app container — so we
        // assert registration through the module's public API instead: at boot,
        // @medusajs/fulfillment's loaders/providers.js DB-syncs a service_provider row
        // per registered provider, surfaced by listFulfillmentProviders().
        const fulfillmentService = container.resolve<IFulfillmentModuleService>(
          Modules.FULFILLMENT
        )
        const providers = await fulfillmentService.listFulfillmentProviders({})
        const ids = providers.map((p) => p.id)
        expect(ids).toContain(ONGOING_PROVIDER_ID)
      })

      // ei4 FIXED — see MedusaOngoingWarehousePlugin-ei4.
      // Before the fix, driving createFulfillment through core FulfillmentModuleService
      // into the ongoing provider threw `AwilixResolutionError: Could not resolve
      // 'ongoing'`: the provider runs in the fulfillment module's ISOLATED container and
      // could not resolve the sibling `ongoing` module (nor `query` / the workflow
      // engine) its createFulfillment then used. The fix moved that orchestration into
      // app-scope subscribers, so createFulfillment is now thin (validate + stash) and
      // no longer touches a sibling module. This asserts the thin, no-throw contract:
      // creating an Ongoing fulfillment through the core module-service succeeds and the
      // provider stashes only the identifiers the async push subscriber needs. No Ongoing
      // REST call happens here (the fixture registers modules + links but not
      // subscribers, so the push does not run in-harness — it is unit-tested separately).
      it(
        "wh5.9b: [ei4 fixed] core FulfillmentModuleService.createFulfillment drives the ongoing provider without a module-isolation error",
        async () => {
          const container = getContainer()
          const stockLocationService = container.resolve<IStockLocationService>(
            Modules.STOCK_LOCATION
          )
          const fulfillmentService = container.resolve<IFulfillmentModuleService>(
            Modules.FULFILLMENT
          )
          const ongoingService = container.resolve<OngoingModuleService>(ONGOING_MODULE)

          const location = await stockLocationService.createStockLocations({
            name: "wh5.9 Test Warehouse",
          })
          await ongoingService.createOngoingIntegrations({
            credential_key: "test-wh",
            stock_location_id: location.id,
            enabled: true,
          })

          // Pre-fix this threw AwilixResolutionError. Now it resolves cleanly.
          const fulfillment = (await fulfillmentService.createFulfillment({
            location_id: location.id,
            provider_id: ONGOING_PROVIDER_ID,
            delivery_address: {
              first_name: "Jo",
              last_name: "Doe",
              address_1: "1 Main St",
              city: "Town",
              postal_code: "0001",
              country_code: "no",
              phone: "123",
            },
            items: [{ title: "Test Product", quantity: 1, sku: "SKU-WH59", barcode: "" }],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)) as unknown as FulfillmentLike

          // Core createFulfillment updates the row with the provider's returned `data`
          // but serializes+returns the PRE-update snapshot (fulfillment-module-service
          // createFulfillment), so re-read the persisted row to see the stash.
          const persisted = (await fulfillmentService.retrieveFulfillment(
            fulfillment.id
          )) as unknown as FulfillmentLike

          // Thin stash: only the identifiers the async push subscriber needs — no
          // ongoing_order_id (the push has not run in this harness).
          expect(persisted.data).toMatchObject({
            location_id: location.id,
            medusa_fulfillment_id: fulfillment.id,
          })
        }
      )
    })
  },
})

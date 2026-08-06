// Shared helpers for the Layer 2 (moduleIntegrationTestRunner + real Postgres) specs.
//
// The strategy (see epic wh5): boot the REAL `ongoing` module against a real DB so
// recordSync/getIntegrationByLocation truly persist and read rows, then drive the real
// pushOrderToOngoing workflow / fulfillment provider on a createMedusaContainer() that
// registers that real service alongside FAKE `query` (core Order/Product modules are
// absent from a module container) and a fake event bus. Ongoing's HTTP is stubbed with
// nock at the https layer (OngoingClient's default transport is Node's https module —
// nock intercepts it; Postgres uses raw sockets via `pg` and is unaffected).
import {
  ContainerRegistrationKeys,
  Modules,
  createMedusaContainer,
} from "@medusajs/framework/utils"
import { asValue } from "awilix"
import type { OngoingPluginOptions } from "../../src/lib/ongoing/types"

// Base URL the stubbed OngoingClient calls. FAKE_OPTIONS.integrations[0].baseUrl must
// match so nock intercepts the right host. No real credentials — nock answers every call.
export const ONGOING_BASE_URL = "https://ongoing.test/api/v1"
export const CREDENTIAL_KEY = "test-wh"
export const GOODS_OWNER_ID = 7

export const FAKE_OPTIONS: OngoingPluginOptions = {
  integrations: [
    {
      key: CREDENTIAL_KEY,
      baseUrl: ONGOING_BASE_URL,
      username: "user",
      password: "pass",
    },
  ],
}

// Minimal fulfillment/order graph the FAKE query.graph returns for the "fulfillment"
// entity — shaped exactly like reQueryFulfillmentOrder's field selection so the REAL
// order mapper and REAL resolveArticleNumber run end-to-end against it.
export type FulfillmentFixture = {
  id: string
  location_id: string
  // The `order.fulfillment_created` subscriber gates on this before pushing (only
  // `ongoing_*` fulfillments are ours) — see src/subscribers/fulfillment-created.ts.
  // Per @medusajs/fulfillment's provider loader the resolvable id is
  // `${identifier}_${config-id}`, so the Ongoing provider is "ongoing_ongoing".
  provider_id: string
  items: Array<{
    quantity: number
    sku: string | null
    barcode: string | null
    title: string | null
    line_item_id: string | null
  }>
  order: {
    id: string
    display_id: number
    currency_code: string
    email: string | null
    shipping_address: Record<string, string | null> | null
  }
  shipping_option?: { data?: Record<string, unknown> } | null
}

export function makeFulfillmentFixture(
  overrides: Partial<FulfillmentFixture> = {}
): FulfillmentFixture {
  return {
    id: "ful_1",
    location_id: "loc_1",
    provider_id: "ongoing_ongoing",
    items: [
      { quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" },
    ],
    order: {
      id: "order_1",
      display_id: 1001,
      currency_code: "usd",
      email: "buyer@example.com",
      shipping_address: {
        first_name: "Jo",
        last_name: "Doe",
        address_1: "1 Main St",
        address_2: null,
        city: "Town",
        postal_code: "0001",
        country_code: "no",
        phone: "123",
        company: null,
      },
    },
    shipping_option: null,
    ...overrides,
  }
}

// A fake `query` whose graph() answers the two entities the push flow reads: the
// fulfillment re-query (keyed by id) and the product_variant SKU lookup that
// resolveArticleNumber makes (returns exactly one variant so the SKU resolves cleanly).
export function makeFakeQuery(fulfillments: FulfillmentFixture[]) {
  const byId = new Map(fulfillments.map((f) => [f.id, f]))
  const graph = jest.fn(async (config: { entity: string; filters?: Record<string, unknown> }) => {
    if (config.entity === "fulfillment") {
      const found = byId.get(config.filters?.id as string)
      return { data: found ? [found] : [] }
    }
    if (config.entity === "product_variant") {
      const sku = config.filters?.sku as string
      return { data: sku ? [{ id: `var_${sku}`, sku }] : [] }
    }
    return { data: [] }
  })
  return { graph }
}

export function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
}

// The workflow orchestrator resolves Modules.EVENT_BUS (with allowUnregistered) after a
// run to release/clear grouped events; push-order-record-sync also emits. No-op all three.
export function makeEventBus() {
  return {
    emit: jest.fn().mockResolvedValue(undefined),
    releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
  }
}

// Build a workflow-runnable container holding the REAL ongoing service + fakes for the
// deps a module container lacks. `container.logger` is set as a direct property too,
// because OngoingFulfillmentProviderService reads `container.logger` (not resolve).
export function buildContainer(opts: {
  service: unknown
  query: unknown
  logger?: ReturnType<typeof makeLogger>
  eventBus?: ReturnType<typeof makeEventBus>
}) {
  const logger = opts.logger ?? makeLogger()
  const eventBus = opts.eventBus ?? makeEventBus()
  const container = createMedusaContainer() as ReturnType<typeof createMedusaContainer> & {
    logger?: unknown
  }
  container.register(ContainerRegistrationKeys.QUERY, asValue(opts.query))
  container.register(ContainerRegistrationKeys.LOGGER, asValue(logger))
  container.register("ongoing", asValue(opts.service))
  container.register(Modules.EVENT_BUS, asValue(eventBus))
  // Provider reads container.logger directly; a bare container exposes registrations
  // only via resolve(), so mirror it onto a property.
  container.logger = logger
  return { container, logger, eventBus }
}

// Regression coverage for #72 (fix PR: this branch) — gate-order-edit collapses to
// the first row when medusa_fulfillment_id is null. The gate must resolve the
// OngoingOrderSync row by a THREE-way priority: order_sync_id → medusa_fulfillment_id
// → medusa_order_id, so multi-row null-fulfillment orders no longer collapse to row[0].
//
// We exercise gateOrderEditStep through the real syncOrderEditToOngoing workflow (so
// the step's container.resolve(...) is threaded by the orchestrator) and assert on the
// filter object recorded by the service's listOngoingOrderSyncs mock.
import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { syncOrderEditToOngoing } from "../../sync-order-edit-to-ongoing"

// Isolate the upsert step's downstream deps (mirrors sync-order-edit-to-ongoing.test.ts)
// so an "allowed" gate decision can run the upsert without real I/O.
jest.mock("../../../lib/ongoing/re-query-fulfillment-order", () => ({
  reQueryFulfillmentOrder: jest.fn().mockResolvedValue({
    items: [{ quantity: 2, sku: "SKU-1", barcode: "BC-1", title: "Item 1", line_item_id: "li_1" }],
    order: {
      display_id: 1001,
      currency_code: "eur",
      email: "a@b.com",
      shipping_address: { first_name: "A", last_name: "B" },
    },
  }),
}))
jest.mock("../../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn().mockResolvedValue("ART-1"),
}))
jest.mock("../../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn().mockReturnValue({ orderNumber: "1001-abc", goodsOwnerId: 7 }),
}))

const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })

const makeService = (overrides: Record<string, unknown> = {}) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue([
    {
      id: "os_1",
      integration_id: "int_1",
      ongoing_order_number: "1001-abc",
      latest_status_code: 200,
      medusa_fulfillment_id: "ful_1",
    },
  ]),
  retrieveOngoingIntegration: jest.fn().mockResolvedValue({
    edit_sync_rules: { line_items: [200], address_contact: [200] },
    credential_key: "wh-a",
  }),
  getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
  getClient: jest.fn().mockReturnValue({ putOrder }),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
  ...overrides,
})

const makeScope = (service: Record<string, unknown>) => {
  const container: any = createMedusaContainer()
  container.register("query", asValue({ graph: jest.fn() }))
  container.register("ongoing", asValue(service))
  return container
}

describe("gateOrderEditStep — row targeting (#72)", () => {
  beforeEach(() => {
    putOrder.mockClear()
  })

  it("targets by order_sync_id first (highest priority) when provided", async () => {
    const service = makeService({
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([
        { id: "os_2", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 200, medusa_fulfillment_id: null },
      ]),
    })
    await syncOrderEditToOngoing(makeScope(service)).run({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        order_sync_id: "os_2",
        category: "line_items",
      },
    })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: "os_2" })
    expect(service.listOngoingOrderSyncs).not.toHaveBeenCalledWith({ medusa_fulfillment_id: "ful_1" })
    expect(service.listOngoingOrderSyncs).not.toHaveBeenCalledWith({ medusa_order_id: "order_1" })
  })

  it("targets by medusa_fulfillment_id second (no order_sync_id)", async () => {
    const service = makeService()
    await syncOrderEditToOngoing(makeScope(service)).run({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        category: "line_items",
      },
    })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ medusa_fulfillment_id: "ful_1" })
  })

  it("falls back to medusa_order_id last (no order_sync_id, no fulfillment id)", async () => {
    const service = makeService({ listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) })
    await syncOrderEditToOngoing(makeScope(service)).run({
      input: {
        medusa_order_id: "order_1",
        category: "address_contact",
      },
    })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ medusa_order_id: "order_1" })
  })

  it("does NOT collapse ≥2 null-fulfillment rows to row[0] — each gates its own row (the #72 bug)", async () => {
    const rows = [
      { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-a", latest_status_code: 200, medusa_fulfillment_id: null },
      { id: "os_2", integration_id: "int_1", ongoing_order_number: "1001-b", latest_status_code: 200, medusa_fulfillment_id: null },
    ]
    const service = makeService({
      listOngoingOrderSyncs: jest.fn((f: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => r.id === f.id))
      ),
    })
    const scope = makeScope(service)

    await syncOrderEditToOngoing(scope).run({
      input: { medusa_order_id: "order_1", order_sync_id: "os_1", category: "line_items" },
    })
    await syncOrderEditToOngoing(scope).run({
      input: { medusa_order_id: "order_1", order_sync_id: "os_2", category: "line_items" },
    })

    // Each run resolves to its OWN row, not a collapsed row[0]=os_1 for both.
    expect(service.listOngoingOrderSyncs).toHaveBeenNthCalledWith(1, { id: "os_1" })
    expect(service.listOngoingOrderSyncs).toHaveBeenNthCalledWith(2, { id: "os_2" })

    // Downstream proof: the upsert wrote each row's own id (never os_1 twice).
    const updatedIds = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls.map((c) => c[0].id)
    expect(updatedIds).toEqual(["os_1", "os_2"])
  })
})

import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { decideOrderEditGate } from "../steps/gate-order-edit"
import { syncOrderEditToOngoing } from "../sync-order-edit-to-ongoing"
import { OngoingApiError } from "../../lib/ongoing/errors"

// Mock the #26 shared re-query helper, the #24 pure mapper, and the #29 SKU
// resolver so the upsert step is isolated. The re-query helper returns #26's
// canonical QueriedFulfillmentOrder shape: items TOP-LEVEL, order fields NESTED
// under .order, and NO delivery_date.
jest.mock("../../lib/ongoing/re-query-fulfillment-order", () => ({
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
jest.mock("../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn().mockResolvedValue("ART-1"),
}))
jest.mock("../../lib/ongoing/order-mapper", () => ({
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
  // goods_owner_id lives on the credentials (in-memory plugin options), not the
  // integration DB row — sourced the same way #26 does.
  getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
  getClient: jest.fn().mockReturnValue({ putOrder }),
  updateOngoingOrderSyncs: jest.fn().mockResolvedValue(undefined),
  ...overrides,
})

// Build a real Medusa container so the workflow orchestrator threads our mocks
// into each step's `container.resolve(...)` (mirrors the #26 push-order test).
const makeScope = (service: Record<string, unknown>) => {
  const container: any = createMedusaContainer()
  container.register("query", asValue({ graph: jest.fn() }))
  container.register("ongoing", asValue(service))
  return container
}

describe("syncOrderEditToOngoing workflow", () => {
  beforeEach(() => {
    putOrder.mockClear()
  })

  it("calls putOrder with the re-mapped model when the status is allowed", async () => {
    const service = makeService()
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
    })

    expect(putOrder).toHaveBeenCalledTimes(1)
    expect(putOrder).toHaveBeenCalledWith({ orderNumber: "1001-abc", goodsOwnerId: 7 })
    expect(result).toMatchObject({ synced: true, blocked: false, reason: "allowed" })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalled()
  })

  it("does NOT call putOrder when the status is blocked", async () => {
    const service = makeService({
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([
        { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 999 },
      ]),
    })
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
    })

    expect(putOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({ synced: false, blocked: true, reason: "status_blocked" })
  })

  it("does NOT call putOrder when there is no sync row", async () => {
    const service = makeService({ listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) })
    const { result } = await syncOrderEditToOngoing(makeScope(service)).run({
      input: { medusa_order_id: "order_x", category: "address_contact" },
    })

    expect(putOrder).not.toHaveBeenCalled()
    expect(result).toMatchObject({ synced: false, blocked: true, reason: "no_sync_row" })
  })

  it("records an error row and rethrows when putOrder fails (spec §6 error capture)", async () => {
    const failingPut = jest.fn().mockRejectedValue(new OngoingApiError("boom", { kind: "retryable" }))
    const service = makeService({ getClient: jest.fn().mockReturnValue({ putOrder: failingPut }) })

    // The orchestrator's run() returns a thenable that rejects on step failure; the
    // jest `.rejects` matcher mis-detects it, so assert the throw via try/catch.
    let thrown: Error | undefined
    try {
      await syncOrderEditToOngoing(makeScope(service)).run({
        input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
      })
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).toBeDefined()
    expect(thrown?.message).toBe("boom")
    expect(failingPut).toHaveBeenCalledTimes(1)

    // spec §6: the failed Ongoing call must write the error onto the sync row.
    const errorWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "error")
    expect(errorWrite).toMatchObject({
      id: "os_1",
      sync_state: "error",
      error_class: "retryable",
      last_error: "boom",
    })
  })

  it("classifies a non-OngoingApiError (network/unknown) failure as retryable (#67)", async () => {
    // A raw network error (ECONNRESET / timeout / DNS / fetch TypeError) is NOT an
    // OngoingApiError; it must be recorded retryable, not dead-lettered as terminal.
    const failingPut = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    const service = makeService({ getClient: jest.fn().mockReturnValue({ putOrder: failingPut }) })

    let thrown: Error | undefined
    try {
      await syncOrderEditToOngoing(makeScope(service)).run({
        input: { medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", category: "line_items" },
      })
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown?.message).toBe("fetch failed")
    const errorWrite = (service.updateOngoingOrderSyncs as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((d) => d.sync_state === "error")
    expect(errorWrite).toMatchObject({
      id: "os_1",
      sync_state: "error",
      error_class: "retryable",
      last_error: "fetch failed",
    })
  })
})

describe("decideOrderEditGate", () => {
  const base = {
    medusa_order_id: "order_1",
    category: "line_items" as const,
  }

  it("allows when latest_status_code is in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 200,
      },
      integration: { edit_sync_rules: { line_items: [200, 210], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("allowed")
    expect(decision.ongoing_order_number).toBe("1001-abc")
    expect(decision.order_sync_id).toBe("os_1")
    expect(decision.integration_id).toBe("int_1")
  })

  it("blocks when latest_status_code is NOT in the rules for the category", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: {
        id: "os_1",
        integration_id: "int_1",
        ongoing_order_number: "1001-abc",
        latest_status_code: 500,
      },
      integration: { edit_sync_rules: { line_items: [200], address_contact: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_blocked")
  })

  it("uses the category-specific allow list (address_contact vs line_items)", () => {
    const sync = {
      id: "os_1",
      integration_id: "int_1",
      ongoing_order_number: "1001-abc",
      latest_status_code: 300,
    }
    const rules = { line_items: [200], address_contact: [300] }
    expect(
      decideOrderEditGate({ input: { ...base, category: "address_contact" }, sync, integration: { edit_sync_rules: rules } }).allowed
    ).toBe(true)
    expect(
      decideOrderEditGate({ input: { ...base, category: "line_items" }, sync, integration: { edit_sync_rules: rules } }).allowed
    ).toBe(false)
  })

  it("blocks with status_unknown when latest_status_code is null", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: null },
      integration: { edit_sync_rules: { line_items: [200] } },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("status_unknown")
  })

  it("blocks with no_sync_row when there is no sync row", () => {
    const decision = decideOrderEditGate({ input: base, sync: undefined, integration: undefined })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_sync_row")
  })

  it("blocks with no_edit_rules when integration has no edit_sync_rules", () => {
    const decision = decideOrderEditGate({
      input: base,
      sync: { id: "os_1", integration_id: "int_1", ongoing_order_number: "1001-abc", latest_status_code: 200 },
      integration: { edit_sync_rules: null },
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("no_edit_rules")
  })
})

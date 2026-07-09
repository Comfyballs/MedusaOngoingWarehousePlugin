import type { MedusaContainer } from "@medusajs/framework/types"
import { upsertOngoingOrderEditHandler } from "../upsert-ongoing-order-edit"
import { OngoingApiError } from "../../../lib/ongoing/errors"
import { reQueryFulfillmentOrder } from "../../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../../lib/ongoing/resolve-article-number"
import { mapOrderToPostOrderModel } from "../../../lib/ongoing/order-mapper"
import type { GateDecision } from "../gate-order-edit"

// The step re-queries + maps via #26/#24/#29 helpers; unit-test the handler's
// OWN behavior (integration lookup → putOrder → record sync / record error),
// mocking those pure helpers so the test isolates this step. classifyError is
// left REAL so we verify the actual retryable/terminal classification.
jest.mock("../../../lib/ongoing/re-query-fulfillment-order", () => ({
  reQueryFulfillmentOrder: jest.fn(),
}))
jest.mock("../../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn(),
}))
jest.mock("../../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn(),
}))

const mockReQuery = reQueryFulfillmentOrder as jest.Mock
const mockResolveArticle = resolveArticleNumber as jest.Mock
const mockMapOrder = mapOrderToPostOrderModel as jest.Mock

const decision: GateDecision = {
  allowed: true,
  reason: "ok",
  order_sync_id: "oos_1",
  integration_id: "int_1",
  ongoing_order_number: "1001-ful1",
  latest_status_code: null,
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  category: "line_items",
}

function makeContext({ putOrder }: { putOrder: jest.Mock }) {
  const updateOngoingOrderSyncs = jest.fn().mockResolvedValue(undefined)
  const service = {
    retrieveOngoingIntegration: jest.fn().mockResolvedValue({ credential_key: "wh-a" }),
    getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
    getClient: jest.fn().mockReturnValue({ putOrder }),
    updateOngoingOrderSyncs,
  }
  const query = { graph: jest.fn() }
  const container = {
    resolve: jest.fn((key: string) => (key === "query" ? query : service)),
  } as unknown as MedusaContainer
  return { container, service, updateOngoingOrderSyncs }
}

const invoke = (ctx: { container: MedusaContainer }) =>
  upsertOngoingOrderEditHandler(decision, ctx)

beforeEach(() => {
  jest.clearAllMocks()
  mockReQuery.mockResolvedValue({
    items: [{ sku: "SKU-1", quantity: 2 }],
    order: {
      currency_code: "usd",
      email: "buyer@example.test",
      shipping_address: { first_name: "A" },
    },
  })
  mockResolveArticle.mockResolvedValue("ART-1")
  mockMapOrder.mockReturnValue({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
})

describe("upsertOngoingOrderEditStep", () => {
  it("puts the mapped order and records sync_state 'sent' with the ongoing id (happy path)", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 555 })
    const { container, updateOngoingOrderSyncs } = makeContext({ putOrder })

    const res = await invoke({ container })

    expect(putOrder).toHaveBeenCalledWith({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
    expect(res.output).toEqual({
      ongoing_order_id: 555,
      ongoing_order_number: "1001-ful1",
    })
    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "oos_1",
        ongoing_order_id: 555,
        ongoing_order_number: "1001-ful1",
        sync_state: "sent",
        error_class: null,
        last_error: null,
      })
    )
  })

  it("resolves each line's article_number and maps with the sync row's order_number", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 555 })
    const { container } = makeContext({ putOrder })

    await invoke({ container })

    expect(mockResolveArticle).toHaveBeenCalledWith(expect.anything(), "SKU-1")
    expect(mockMapOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        goods_owner_id: 7,
        order_number: "1001-ful1",
        currency_code: "usd",
        email: "buyer@example.test",
        lines: [{ article_number: "ART-1", quantity: 2 }],
      })
    )
  })

  it("records a retryable error for a retryable OngoingApiError from putOrder, then rethrows", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503 down", { kind: "retryable", status: 503 }))
    const { container, updateOngoingOrderSyncs } = makeContext({ putOrder })

    await expect(invoke({ container })).rejects.toMatchObject({ kind: "retryable" })

    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "oos_1",
        sync_state: "error",
        error_class: "retryable",
        last_error: "503 down",
      })
    )
  })

  it("keeps a terminal OngoingApiError terminal, records it, then rethrows", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("bad request", { kind: "terminal", status: 400 }))
    const { container, updateOngoingOrderSyncs } = makeContext({ putOrder })

    await expect(invoke({ container })).rejects.toMatchObject({ kind: "terminal" })

    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "terminal", last_error: "bad request" })
    )
  })

  it("classifies a non-OngoingApiError (network/unknown) putOrder failure as retryable, then rethrows (#67)", async () => {
    const putOrder = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    const { container, updateOngoingOrderSyncs } = makeContext({ putOrder })

    await expect(invoke({ container })).rejects.toThrow("fetch failed")

    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "retryable", last_error: "fetch failed" })
    )
  })

  it("records an error when getCredentials throws (misconfigured credential_key), then rethrows", async () => {
    // The comment on the step notes getCredentials/getClient are INSIDE the try
    // so a misconfigured credential_key is recorded as an error row too.
    const putOrder = jest.fn()
    const { container, service, updateOngoingOrderSyncs } = makeContext({ putOrder })
    ;(service.getCredentials as jest.Mock).mockImplementation(() => {
      throw new Error('no credentials configured for credential_key "wh-a"')
    })

    await expect(invoke({ container })).rejects.toThrow("no credentials configured")

    expect(putOrder).not.toHaveBeenCalled()
    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "oos_1",
        sync_state: "error",
        error_class: "retryable",
      })
    )
  })

  it("records an error (not left silently) when the integration lookup fails before putOrder", async () => {
    const putOrder = jest.fn()
    const { container, service, updateOngoingOrderSyncs } = makeContext({ putOrder })
    ;(service.retrieveOngoingIntegration as jest.Mock).mockRejectedValue(
      new Error("integration int_1 not found")
    )

    await expect(invoke({ container })).rejects.toThrow("integration int_1 not found")

    expect(putOrder).not.toHaveBeenCalled()
    expect(updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "oos_1",
        sync_state: "error",
        error_class: "retryable",
        last_error: "integration int_1 not found",
      })
    )
  })
})

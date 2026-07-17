import type { MedusaContainer } from "@medusajs/framework/types"
import { queryFulfillmentOrderHandler } from "../query-fulfillment-order"
import { reQueryFulfillmentOrder } from "../../../lib/ongoing/re-query-fulfillment-order"
import { resolveArticleNumber } from "../../../lib/ongoing/resolve-article-number"

// This step's OWN new behavior (dl3) is matching order.line_items back to
// fulfillment items by line_item_id to attach weight/unit_price. reQueryFulfillmentOrder
// and resolveArticleNumber are pure helpers owned/tested elsewhere; mock them here.
jest.mock("../../../lib/ongoing/re-query-fulfillment-order", () => ({
  reQueryFulfillmentOrder: jest.fn(),
}))
jest.mock("../../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn(),
}))

const mockReQuery = reQueryFulfillmentOrder as jest.Mock
const mockResolveArticle = resolveArticleNumber as jest.Mock

function makeContainer() {
  const query = { graph: jest.fn() }
  const container = {
    resolve: jest.fn().mockReturnValue(query),
  } as unknown as MedusaContainer
  return container
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("queryFulfillmentOrderHandler (dl3: weight/unit_price wiring)", () => {
  it("attaches weight/unit_price from the matching order line item via line_item_id", async () => {
    mockReQuery.mockResolvedValue({
      fulfillment_id: "ful_1",
      location_id: "loc_1",
      items: [
        { quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" },
        { quantity: 1, sku: "SKU-2", barcode: null, title: "Mug", line_item_id: "li_2" },
      ],
      order: {
        id: "order_1",
        display_id: 1001,
        currency_code: "usd",
        email: "a@b.com",
        shipping_address: null,
        line_items: [
          { id: "li_1", unit_price: 49.99, weight: 1.5 },
          { id: "li_2", unit_price: 9.5, weight: null },
        ],
      },
    })
    mockResolveArticle.mockResolvedValueOnce("SKU-1").mockResolvedValueOnce("SKU-2")

    const result = await queryFulfillmentOrderHandler(
      { fulfillment_id: "ful_1" },
      { container: makeContainer() }
    )

    expect(result.resolvedLines).toEqual([
      { article_number: "SKU-1", quantity: 2, line_item_id: "li_1", weight: 1.5, unit_price: 49.99 },
      { article_number: "SKU-2", quantity: 1, line_item_id: "li_2", weight: null, unit_price: 9.5 },
    ])
  })

  it("falls back to null weight/unit_price when there is no matching order line item", async () => {
    mockReQuery.mockResolvedValue({
      fulfillment_id: "ful_1",
      location_id: "loc_1",
      items: [{ quantity: 1, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: null }],
      order: {
        id: "order_1",
        display_id: 1001,
        currency_code: "usd",
        email: null,
        shipping_address: null,
        line_items: [],
      },
    })
    mockResolveArticle.mockResolvedValueOnce("SKU-1")

    const result = await queryFulfillmentOrderHandler(
      { fulfillment_id: "ful_1" },
      { container: makeContainer() }
    )

    expect(result.resolvedLines).toEqual([
      { article_number: "SKU-1", quantity: 1, line_item_id: null, weight: null, unit_price: null },
    ])
  })
})

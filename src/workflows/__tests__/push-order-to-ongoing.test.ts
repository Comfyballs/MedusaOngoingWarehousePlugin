import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import pushOrderToOngoing from "../push-order-to-ongoing"

// A queried fulfillment + order the QUERY graph returns.
const fulfillmentRow = {
  id: "ful_1",
  location_id: "loc_1",
  items: [{ quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" }],
  order: {
    id: "order_1",
    display_id: 1001,
    currency_code: "usd",
    email: "a@b.com",
    shipping_address: {
      first_name: "Jo", last_name: "Doe", address_1: "1 St", address_2: null,
      city: "Town", postal_code: "0001", country_code: "no", phone: "123", company: null,
    },
  },
}

jest.mock("../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn(() => ({
    orderNumber: "1001-ful1",
    goodsOwnerId: 7,
    consignee: { name: "Jo Doe" },
    orderLines: [],
  })),
}))
jest.mock("../../lib/ongoing/order-number", () => ({
  buildOngoingOrderNumber: jest.fn(() => "1001-ful1"),
}))
jest.mock("../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn(async () => "ART-1"),
}))

import { resolveArticleNumber } from "../../lib/ongoing/resolve-article-number"
import { OngoingApiError } from "../../lib/ongoing/errors"

// Build a real Medusa container so the workflow orchestrator threads our mocks into
// each step's `container.resolve(...)`.
function buildContainer({ putOrder, recordSync }: { putOrder: jest.Mock; recordSync: jest.Mock }) {
  const query = { graph: jest.fn().mockResolvedValue({ data: [fulfillmentRow] }) }
  const service = {
    getIntegrationByLocation: jest.fn().mockResolvedValue({ id: "int_1", credential_key: "wh-a" }),
    getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
    getClient: jest.fn().mockReturnValue({ putOrder }),
    recordSync,
  }
  const container: any = createMedusaContainer()
  container.register("query", asValue(query))
  container.register("ongoing", asValue(service))
  return { container, query, service }
}

describe("pushOrderToOngoing workflow", () => {
  it("happy path: maps, PUTs, and records sent with the ongoing id", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    const { container } = buildContainer({ putOrder, recordSync })

    const { result } = await pushOrderToOngoing(container).run({
      input: { fulfillment_id: "ful_1" },
    })

    expect(result).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
    expect(putOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
    )
    const states = recordSync.mock.calls.map((c) => c[0].sync_state)
    expect(states).toContain("pending")
    expect(states).toContain("sent")
    // precise order id flows through from order.id, not display_id
    expect(recordSync.mock.calls[0][0]).toMatchObject({ medusa_order_id: "order_1" })
  })

  it("terminal SKU-resolution error: never calls putOrder, workflow rejects", async () => {
    const putOrder = jest.fn()
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    ;(resolveArticleNumber as jest.Mock).mockRejectedValueOnce(
      new OngoingApiError("ambiguous SKU", { kind: "terminal" })
    )
    const { container } = buildContainer({ putOrder, recordSync })

    await expect(
      pushOrderToOngoing(container).run({ input: { fulfillment_id: "ful_1" } })
    ).rejects.toBeDefined()

    expect(putOrder).not.toHaveBeenCalled()
  })

  it("retryable client error: records error_class=retryable", async () => {
    const putOrder = jest.fn().mockRejectedValue(new OngoingApiError("503", { kind: "retryable", status: 503 }))
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    const { container } = buildContainer({ putOrder, recordSync })

    await expect(
      pushOrderToOngoing(container).run({ input: { fulfillment_id: "ful_1" } })
    ).rejects.toBeDefined()

    const errorCall = recordSync.mock.calls.find((c) => c[0].sync_state === "error")
    expect(errorCall?.[0]).toMatchObject({ error_class: "retryable", sync_state: "error" })
  })
})

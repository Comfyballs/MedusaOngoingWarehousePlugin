import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import pushReturnOrderToOngoing from "../push-return-order-to-ongoing"

const orderRow = { id: "order_1", display_id: 1001 }

jest.mock("../../lib/ongoing/return-order-mapper", () => ({
  mapReturnOrderToPostReturnOrderModel: jest.fn(() => ({
    goodsOwnerId: 7,
    returnOrderNumber: "RET-1001-ret_ful_1",
    customerOrder: { orderId: 999 },
    inDate: "2026-07-17",
    returnOrderLines: [],
  })),
}))
jest.mock("../../lib/ongoing/order-number", () => ({
  buildOngoingReturnOrderNumber: jest.fn(() => "RET-1001-ret_ful_1"),
}))
jest.mock("../../lib/ongoing/resolve-article-number", () => ({
  resolveArticleNumber: jest.fn(async () => "ART-1"),
}))

import { OngoingApiError } from "../../lib/ongoing/errors"

// Build a real Medusa container so the workflow orchestrator threads our mocks into
// each step's `container.resolve(...)`. Mirrors push-order-to-ongoing.test.ts.
function buildContainer({
  putReturnOrder,
  getOrder,
  items = [{ quantity: 1, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" }],
  orders = [orderRow],
  listOngoingOrderSyncs = jest.fn().mockResolvedValue([
    { id: "oos_1", ongoing_order_id: 999, sync_state: "shipped", last_synced_at: new Date() },
  ]),
}: {
  putReturnOrder: jest.Mock
  getOrder: jest.Mock
  items?: unknown[]
  orders?: unknown[]
  listOngoingOrderSyncs?: jest.Mock
}) {
  const returnFulfillmentRow = { id: "ret_ful_1", location_id: "loc_1", items }
  const query = {
    graph: jest.fn(async ({ entity }: { entity: string }) => {
      if (entity === "fulfillment") {
        return { data: [returnFulfillmentRow] }
      }
      if (entity === "order") {
        return { data: orders }
      }
      return { data: [] }
    }),
  }
  const service = {
    getIntegrationByLocation: jest.fn().mockResolvedValue({ id: "int_1", credential_key: "wh-a" }),
    getCredentials: jest.fn().mockReturnValue({ goodsOwnerId: 7 }),
    listOngoingOrderSyncs,
    getClient: jest.fn().mockReturnValue({ getOrder, putReturnOrder }),
  }
  const container: any = createMedusaContainer()
  container.register("query", asValue(query))
  container.register("ongoing", asValue(service))
  container.register("logger", asValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
  container.register(
    "event_bus",
    asValue({
      emit: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
    })
  )
  return { container, query, service }
}

describe("pushReturnOrderToOngoing workflow", () => {
  it("happy path: resolves the origin order, fetches its Ongoing lines, maps, PUTs, and returns", async () => {
    const getOrder = jest
      .fn()
      .mockResolvedValue({ ongoingOrderId: 999, lines: [{ orderLineId: 111, articleNumber: "ART-1" }] })
    const putReturnOrder = jest.fn().mockResolvedValue({ ongoingReturnOrderId: 555 })
    const { container, service } = buildContainer({ putReturnOrder, getOrder })

    const { result } = await pushReturnOrderToOngoing(container).run({
      input: { return_fulfillment_id: "ret_ful_1" },
    })

    expect(result).toEqual({ ongoingReturnOrderId: 555, returnOrderNumber: "RET-1001-ret_ful_1" })
    expect(service.getIntegrationByLocation).toHaveBeenCalledWith("loc_1")
    expect(getOrder).toHaveBeenCalledWith(999)
    expect(putReturnOrder).toHaveBeenCalledTimes(1)
  })

  it("throws and never calls the client when the return fulfillment has no items", async () => {
    const getOrder = jest.fn()
    const putReturnOrder = jest.fn()
    const { container } = buildContainer({ putReturnOrder, getOrder, items: [] })

    await expect(
      pushReturnOrderToOngoing(container).run({ input: { return_fulfillment_id: "ret_ful_1" } })
    ).rejects.toBeDefined()

    expect(getOrder).not.toHaveBeenCalled()
    expect(putReturnOrder).not.toHaveBeenCalled()
  })

  it("throws and never calls the client when the original order has no sent/shipped Ongoing order", async () => {
    const getOrder = jest.fn()
    const putReturnOrder = jest.fn()
    const { container } = buildContainer({
      putReturnOrder,
      getOrder,
      listOngoingOrderSyncs: jest.fn().mockResolvedValue([
        { id: "oos_1", ongoing_order_id: null, sync_state: "pending", last_synced_at: new Date() },
      ]),
    })

    await expect(
      pushReturnOrderToOngoing(container).run({ input: { return_fulfillment_id: "ret_ful_1" } })
    ).rejects.toBeDefined()

    expect(getOrder).not.toHaveBeenCalled()
    expect(putReturnOrder).not.toHaveBeenCalled()
  })

  it("retryable client error propagates (workflow rejects)", async () => {
    const getOrder = jest
      .fn()
      .mockResolvedValue({ ongoingOrderId: 999, lines: [{ orderLineId: 111, articleNumber: "ART-1" }] })
    const putReturnOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503", { kind: "retryable", status: 503 }))
    const { container } = buildContainer({ putReturnOrder, getOrder })

    await expect(
      pushReturnOrderToOngoing(container).run({ input: { return_fulfillment_id: "ret_ful_1" } })
    ).rejects.toBeDefined()
  })
})

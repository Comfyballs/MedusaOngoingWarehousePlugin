jest.mock("../../../lib/ongoing/order-mapper", () => ({
  mapOrderToPostOrderModel: jest.fn(),
}))
jest.mock("../../../lib/ongoing/order-number", () => ({
  buildOngoingOrderNumber: jest.fn(),
}))

import { mapOrderToOngoingHandler } from "../map-order-to-ongoing"
import { mapOrderToPostOrderModel } from "../../../lib/ongoing/order-mapper"
import { buildOngoingOrderNumber } from "../../../lib/ongoing/order-number"

const queried = {
  fulfillment_id: "ful_1",
  location_id: "loc_1",
  items: [{ quantity: 2, sku: "SKU-1", barcode: null, title: "Tee", line_item_id: "li_1" }],
  resolvedLines: [{ article_number: "ART-1", quantity: 2, line_item_id: "li_1" }],
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

// The createStep wrapper does not expose its invoke fn, so we test the exported handler.
const run = (input: any) => mapOrderToOngoingHandler(input)

describe("mapOrderToOngoingStep", () => {
  it("builds the order number (object arg) and maps via a single flat MapOrderInput", async () => {
    ;(buildOngoingOrderNumber as jest.Mock).mockReturnValue("1001-ful1")
    ;(mapOrderToPostOrderModel as jest.Mock).mockReturnValue({
      orderNumber: "1001-ful1",
      goodsOwnerId: 7,
      consignee: { name: "Jo Doe" },
      orderLines: [],
    })

    const output = await run({ queried, goods_owner_id: 7 })

    // #25 takes a SINGLE OBJECT arg.
    expect(buildOngoingOrderNumber).toHaveBeenCalledWith({
      displayId: 1001,
      fulfillmentId: "ful_1",
    })

    // #24 takes a SINGLE FLAT MapOrderInput object with resolved lines.
    expect(mapOrderToPostOrderModel).toHaveBeenCalledTimes(1)
    const mapInput = (mapOrderToPostOrderModel as jest.Mock).mock.calls[0][0]
    expect(mapInput).toMatchObject({
      goods_owner_id: 7,
      order_number: "1001-ful1",
      currency_code: "usd",
      email: "a@b.com",
      shipping_address: queried.order.shipping_address,
      lines: [{ article_number: "ART-1", quantity: 2 }],
    })

    expect(output.ongoing_order_number).toBe("1001-ful1")
    // model is returned as-is from the mapper (no double-stamping).
    expect(output.model).toMatchObject({ orderNumber: "1001-ful1", goodsOwnerId: 7 })
  })

  it("propagates a terminal mapper error", async () => {
    ;(buildOngoingOrderNumber as jest.Mock).mockReturnValue("1001-ful1")
    ;(mapOrderToPostOrderModel as jest.Mock).mockImplementation(() => {
      throw Object.assign(new Error("invalid address"), { kind: "terminal" })
    })

    await expect(run({ queried, goods_owner_id: 7 })).rejects.toMatchObject({ kind: "terminal" })
  })
})

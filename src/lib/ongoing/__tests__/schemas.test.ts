import {
  OngoingInventoryRowResponseSchema,
  OngoingTrackedOrderResponseSchema,
} from "../schemas"

// Shapes below mirror Ongoing OpenAPI v57 (GetArticleModel / GetOrderModel). The prior
// `{ article, totalItems }` / `parcelTracking.code` shapes came from endpoints/fields
// that don't exist in the spec (beads dtw, 5vu).
describe("OngoingInventoryRowResponseSchema (GetArticleModel subset)", () => {
  it("accepts a fully populated article with inventoryInfo", () => {
    const raw = {
      articleNumber: "SKU-1",
      articleSystemId: 42,
      inventoryInfo: {
        numberOfItems: 10,
        allocatedNumberOfItems: 2,
        sellableNumberOfItems: 8,
        toReceiveNumberOfItems: 5,
      },
    }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts an article with omitted optional counts (defaults to zeros downstream)", () => {
    const raw = { articleNumber: "SKU-1", articleSystemId: 42, inventoryInfo: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts an article with inventoryInfo omitted entirely", () => {
    const raw = { articleNumber: "SKU-1", articleSystemId: 42 }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  // Regression (bead dw5): Ongoing serializes absent members as JSON null, not omitted.
  it("accepts an article where inventoryInfo and its counts are null", () => {
    const raw = {
      articleNumber: "SKU-1",
      articleSystemId: 42,
      inventoryInfo: { numberOfItems: null, sellableNumberOfItems: null },
    }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
    expect(
      OngoingInventoryRowResponseSchema.safeParse({
        articleNumber: "SKU-1",
        articleSystemId: 42,
        inventoryInfo: null,
      }).success
    ).toBe(true)
  })

  it("rejects an article missing articleNumber", () => {
    const raw = { articleSystemId: 42, inventoryInfo: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects an article whose articleSystemId is not a number", () => {
    const raw = { articleNumber: "SKU-1", articleSystemId: "42", inventoryInfo: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects the empty object (production failure shape)", () => {
    expect(OngoingInventoryRowResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe("OngoingTrackedOrderResponseSchema (GetOrderModel subset)", () => {
  it("accepts an order with parcel-level and order-level tracking", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
      parcels: [{ tracking: { waybill: "WB-1", trackingUrl: "https://t/1" } }],
      tracking: [{ waybill: "WB-2", trackingUrl: "https://t/2" }],
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts an order with parcels and tracking omitted", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  // Regression (bead dw5): Ongoing serializes absent members as JSON null, not omitted —
  // a freshly created order (no waybill yet) comes back with `"tracking": null` live.
  it("accepts an order where tracking/parcels are null (fresh order, no waybill yet)", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 200, text: "Open" },
      },
      parcels: null,
      tracking: null,
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts null nested tracking fields inside parcels (bead dw5)", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 200, text: "Open" },
      },
      parcels: [{ isReturnParcel: null, tracking: null }, { tracking: { waybill: null, trackingUrl: null } }],
      tracking: [{ waybill: null, trackingUrl: null }],
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("rejects an order where orderInfo is omitted entirely", () => {
    expect(OngoingTrackedOrderResponseSchema.safeParse({ parcels: [] }).success).toBe(false)
  })

  it("rejects an order where orderInfo.orderId is a string", () => {
    const raw = {
      orderInfo: { orderId: "100", orderNumber: "ORD-1", orderStatus: { number: 300, text: "Sent" } },
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects the empty object (production failure shape)", () => {
    expect(OngoingTrackedOrderResponseSchema.safeParse({}).success).toBe(false)
  })
})

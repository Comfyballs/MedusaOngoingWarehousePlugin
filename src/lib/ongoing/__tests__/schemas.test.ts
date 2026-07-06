import {
  OngoingInventoryRowResponseSchema,
  OngoingTrackedOrderResponseSchema,
} from "../schemas"

describe("OngoingInventoryRowResponseSchema", () => {
  it("accepts a fully populated inventory row", () => {
    const raw = {
      article: { articleNumber: "SKU-1", articleSystemId: 42 },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 2,
        SellableNumberOfItems: 8,
        ToReceiveNumberOfItems: 5,
      },
    }
    const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
  })

  it("accepts a row with omitted optional counts (defaults to zeros downstream)", () => {
    const raw = { article: { articleNumber: "SKU-1", articleSystemId: 42 }, totalItems: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts a row with totalItems omitted entirely", () => {
    const raw = { article: { articleNumber: "SKU-1", articleSystemId: 42 } }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("rejects a row where article is omitted entirely", () => {
    const raw = { totalItems: { NumberOfItemsDecimal: 1 } }
    const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
    expect(parsed.success).toBe(false)
  })

  it("rejects a row where article.articleNumber is not a string", () => {
    const raw = { article: { articleNumber: 42, articleSystemId: 1 }, totalItems: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects the empty object (production failure shape)", () => {
    expect(OngoingInventoryRowResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe("OngoingTrackedOrderResponseSchema", () => {
  it("accepts a fully populated tracked order", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
      parcels: [{ parcelTracking: { code: "ABC" } }, { trackingNumber: "XYZ" }],
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts an order with parcels omitted", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
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

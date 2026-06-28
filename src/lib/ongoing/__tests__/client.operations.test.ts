import { OngoingClient } from "../client"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "wh-a",
  baseUrl: "https://api.example.test/api/v1",
  username: "u",
  password: "p",
  goodsOwnerId: 7,
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

describe("OngoingClient operations", () => {
  it("maps inventory fields and stops paginating on a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      article: { articleNumber: `A${i}`, articleSystemId: i },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 2,
        SellableNumberOfItems: 8,
        ToReceiveNumberOfItems: 3,
      },
    }))
    const page2 = [
      {
        article: { articleNumber: "A50", articleSystemId: 50 },
        totalItems: {
          NumberOfItemsDecimal: 1,
          AllocatedNumberOfItems: 0,
          SellableNumberOfItems: 1,
          ToReceiveNumberOfItems: 0,
        },
      },
    ]
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(page1))
      .mockResolvedValueOnce(json(page2))
    const client = new OngoingClient(creds, { fetchImpl })

    const rows = await client.getInventory()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(51)
    expect(rows[0]).toEqual({
      articleNumber: "A0",
      articleSystemId: 0,
      numberOfItems: 10,
      allocatedNumberOfItems: 2,
      sellableNumberOfItems: 8,
      toReceiveNumberOfItems: 3,
    })
  })

  it("maps order statuses from the wrapped GetOrderStatusesModel envelope", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        orderStatuses: [
          { number: 200, text: "Open" },
          { number: 400, text: "Sent" },
        ],
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    const statuses = await client.getOrderStatuses()
    expect(statuses).toEqual([
      { number: 200, text: "Open" },
      { number: 400, text: "Sent" },
    ])
  })

  it("upserts an order and returns the ongoing id from the flat response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderId: 999, message: "Order created" }))
    const client = new OngoingClient(creds, { fetchImpl })
    const result = await client.putOrder({
      orderNumber: "1001-abc",
      goodsOwnerId: 7,
      deliveryDate: "2026-07-01T10:00:00.000Z",
      consignee: { name: "Ada Lovelace", postCode: "0155", countryCode: "no" },
    })
    expect(result).toEqual({ ongoingOrderId: 999 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders")
    expect(init.method).toBe("PUT")
  })

  it("testConnection returns true when statuses load", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderStatuses: [{ number: 200, text: "Open" }] }))
    const client = new OngoingClient(creds, { fetchImpl })
    await expect(client.testConnection()).resolves.toBe(true)
  })
})

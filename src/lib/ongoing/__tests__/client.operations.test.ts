import { OngoingClient } from "../client"
import { OngoingApiError } from "../errors"
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
  it("hits GET /articles (not /articles/inventory) with cursor params and maps inventoryInfo (beads dtw/ji6)", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      articleNumber: `A${i}`,
      articleSystemId: i,
      inventoryInfo: {
        numberOfItems: 10,
        allocatedNumberOfItems: 2,
        sellableNumberOfItems: 8,
        toReceiveNumberOfItems: 3,
      },
    }))
    const page2 = [
      {
        articleNumber: "A50",
        articleSystemId: 50,
        inventoryInfo: {
          numberOfItems: 1,
          allocatedNumberOfItems: 0,
          sellableNumberOfItems: 1,
          toReceiveNumberOfItems: 0,
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
    const [url1] = fetchImpl.mock.calls[0]
    expect(url1).toContain("/articles?goodsOwnerId=7")
    expect(url1).not.toContain("/articles/inventory")
    expect(url1).toContain("articleSystemIdFrom=0")
    expect(url1).toContain("maxArticlesToGet=50")
    expect(url1).not.toContain("pageSize=")
    expect(fetchImpl.mock.calls[1][0]).toContain("articleSystemIdFrom=50")
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

  it("sends articleNumbers as repeated keys (explode:true), not a CSV, when article numbers are given (bead dtw)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([]))
    const client = new OngoingClient(creds, { fetchImpl })

    await client.getInventory(["SKU-1", "SKU-2"])

    const [url] = fetchImpl.mock.calls[0]
    // Spec declares articleNumbers as style:form explode:true → repeated keys, not CSV.
    expect(url).toContain("articleNumbers=SKU-1")
    expect(url).toContain("articleNumbers=SKU-2")
    expect(url).not.toContain("articleNumbers=SKU-1,SKU-2")
  })

  it("appends stockInfoChangedFrom for a delta sync (bead sw8)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([]))
    const client = new OngoingClient(creds, { fetchImpl })

    await client.getInventory(undefined, "2026-07-15T00:00:00.000Z")

    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain("stockInfoChangedFrom=2026-07-15T00%3A00%3A00.000Z")
  })

  it("omits stockInfoChangedFrom for a full sweep (bead sw8)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([]))
    const client = new OngoingClient(creds, { fetchImpl })

    await client.getInventory()

    expect(fetchImpl.mock.calls[0][0]).not.toContain("stockInfoChangedFrom")
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

  it("throws a retryable OngoingApiError when the 2xx response omits orderId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ message: "Order queued" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putOrder({
        orderNumber: "1001-abc",
        goodsOwnerId: 7,
        deliveryDate: "2026-07-01T10:00:00.000Z",
        consignee: { name: "Ada Lovelace", postCode: "0155", countryCode: "no" },
      })
    ).rejects.toMatchObject({ kind: "retryable" })
  })

  it("throws a retryable OngoingApiError when the 2xx response has orderId: null", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderId: null, message: "Order queued" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putOrder({
        orderNumber: "1001-abc",
        goodsOwnerId: 7,
        deliveryDate: "2026-07-01T10:00:00.000Z",
        consignee: { name: "Ada Lovelace", postCode: "0155", countryCode: "no" },
      })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })

  it("upserts an article via PUT /articles and returns the articleSystemId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ articleSystemId: 555, message: "ok" }))
    const client = new OngoingClient(creds, { fetchImpl })
    const result = await client.putArticle({
      goodsOwnerId: 7,
      articleNumber: "SKU-1",
      articleName: "Tee",
    })
    expect(result).toEqual({ articleSystemId: 555 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/articles")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({
      goodsOwnerId: 7,
      articleNumber: "SKU-1",
      articleName: "Tee",
    })
  })

  it("putArticle resolves (undefined id) on a 2xx that omits articleSystemId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ message: "upserted" }))
    const client = new OngoingClient(creds, { fetchImpl })
    await expect(
      client.putArticle({ goodsOwnerId: 7, articleNumber: "SKU-1", articleName: "Tee" })
    ).resolves.toEqual({ articleSystemId: undefined })
  })

})

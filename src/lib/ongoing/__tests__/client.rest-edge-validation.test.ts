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
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("client REST-edge validation (#114-a)", () => {
  it("throws terminal OngoingApiError when an inventory row lacks articleNumber", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([{ articleSystemId: 1, inventoryInfo: {} }]))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.getInventory()).rejects.toMatchObject({
      name: "OngoingApiError",
      kind: "terminal",
      reason: "unexpected_body_shape",
    })
  })

  it("throws terminal OngoingApiError when an inventory row's articleNumber is not a string", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([{ articleNumber: 42, articleSystemId: 1, inventoryInfo: {} }])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.getInventory()).rejects.toBeInstanceOf(OngoingApiError)
  })

  it("accepts an inventory row with omitted inventoryInfo (defaults zeros)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([{ articleNumber: "SKU-1", articleSystemId: 1 }])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const rows = await client.getInventory()
    expect(rows).toEqual([
      {
        articleNumber: "SKU-1",
        articleSystemId: 1,
        numberOfItems: 0,
        allocatedNumberOfItems: 0,
        sellableNumberOfItems: 0,
        toReceiveNumberOfItems: 0,
      },
    ])
  })

  it("throws terminal OngoingApiError when a tracked order lacks orderInfo", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([{ parcels: [] }]))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.getOrdersByStatus(200, 400)).rejects.toMatchObject({
      name: "OngoingApiError",
      kind: "terminal",
      reason: "unexpected_body_shape",
    })
  })

  it("throws terminal OngoingApiError when a tracked order's orderId is a string", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        {
          orderInfo: {
            orderId: "100",
            orderNumber: "ORD-1",
            orderStatus: { number: 300, text: "Sent" },
          },
        },
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.getOrdersByStatus(200, 400)).rejects.toBeInstanceOf(OngoingApiError)
  })

  it("accepts a tracked order with parcels omitted (empty trackingNumbers)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        {
          orderInfo: {
            orderId: 100,
            orderNumber: "ORD-1",
            orderStatus: { number: 300, text: "Sent" },
          },
        },
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const orders = await client.getOrdersByStatus(200, 400)
    expect(orders).toEqual([
      {
        ongoingOrderId: 100,
        orderNumber: "ORD-1",
        statusNumber: 300,
        statusText: "Sent",
        trackingNumbers: [],
        tracking: [],
      },
    ])
  })
})

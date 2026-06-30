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
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("OngoingClient.getOrdersByStatus", () => {
  it("requests the status range with an explicit pageSize and maps tracked orders", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        {
          orderInfo: {
            orderId: 555,
            orderNumber: "1001-abc",
            orderStatus: { number: 400, text: "Sent" },
          },
          parcels: [
            { parcelTracking: { code: "TRACK1" } },
            { trackingNumber: "TRACK2" },
          ],
        },
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const orders = await client.getOrdersByStatus(100, 999)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain("/orders?goodsOwnerId=7")
    expect(url).toContain("orderStatusFrom=100")
    expect(url).toContain("orderStatusTo=999")
    expect(url).toContain("pageSize=50")
    expect(orders).toEqual([
      {
        ongoingOrderId: 555,
        orderNumber: "1001-abc",
        statusNumber: 400,
        statusText: "Sent",
        trackingNumbers: ["TRACK1", "TRACK2"],
      },
    ])
  })
})

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("OngoingClient.cancelOrder", () => {
  it("issues DELETE /orders/{id} and maps the response", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(json(200, { orderId: 999, message: "Cancelled" }))
    const client = new OngoingClient(creds, { fetchImpl })

    const result = await client.cancelOrder(999)

    expect(result).toEqual({ ongoingOrderId: 999, message: "Cancelled" })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders/999")
    expect(init.method).toBe("DELETE")
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("u:p").toString("base64")
    )
  })

  it("propagates a terminal OngoingApiError on 4xx", async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json(400, { message: "Order already cancelled" }))
      )
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(client.cancelOrder(999)).rejects.toBeInstanceOf(OngoingApiError)
    await expect(client.cancelOrder(999)).rejects.toMatchObject({
      kind: "terminal",
      status: 400,
    })
  })
})

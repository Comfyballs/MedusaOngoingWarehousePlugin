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

describe("OngoingClient.getOrder", () => {
  it("GETs /orders/{id} and maps orderLines to { orderLineId, articleNumber }", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        orderInfo: { orderId: 50163 },
        orderLines: [
          { id: 48838, rowNumber: "1", article: { articleNumber: "1009" } },
          { id: 48839, rowNumber: "2", article: { articleNumber: "1010" } },
        ],
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const detail = await client.getOrder(50163)

    expect(detail).toEqual({
      ongoingOrderId: 50163,
      lines: [
        { orderLineId: 48838, articleNumber: "1009" },
        { orderLineId: 48839, articleNumber: "1010" },
      ],
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders/50163")
    expect(init.method).toBe("GET")
  })

  it("drops a line whose article/articleNumber is missing rather than failing the whole GET", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json({
        orderInfo: { orderId: 1 },
        orderLines: [
          { id: 1, article: { articleNumber: "A1" } },
          { id: 2, article: null },
        ],
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    const detail = await client.getOrder(1)
    expect(detail.lines).toEqual([{ orderLineId: 1, articleNumber: "A1" }])
  })

  it("throws a terminal OngoingApiError when the response fails schema validation", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderLines: [] }))
    const client = new OngoingClient(creds, { fetchImpl })
    await expect(client.getOrder(1)).rejects.toMatchObject({ kind: "terminal" })
  })
})

describe("OngoingClient.putReturnOrder", () => {
  // The 2xx body shape { returnOrderId, message } is verified against the official
  // Ongoing openapi.json v57 (PostReturnOrderResponse) — bead 2a6. Keep these field
  // names in lockstep with that schema.
  it("PUTs /returnOrders and returns the ongoing return order id", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ returnOrderId: 321, message: "ok" }))
    const client = new OngoingClient(creds, { fetchImpl })

    const result = await client.putReturnOrder({
      goodsOwnerId: 7,
      returnOrderNumber: "RET-1001-ret_1",
      customerOrder: { orderId: 999 },
      inDate: "2026-07-17",
      returnOrderLines: [
        {
          returnOrderRowNumber: "1",
          customerOrderLine: { orderLineId: 111 },
          toBeReturnedNumberOfItems: 1,
        },
      ],
    })

    expect(result).toEqual({ ongoingReturnOrderId: 321 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/returnOrders")
    expect(init.method).toBe("PUT")
  })

  it("throws a retryable OngoingApiError when the 2xx response omits returnOrderId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ message: "queued" }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putReturnOrder({
        goodsOwnerId: 7,
        returnOrderNumber: "RET-1001-ret_1",
        customerOrder: { orderId: 999 },
        inDate: "2026-07-17",
      })
    ).rejects.toMatchObject({ kind: "retryable" })
  })

  // dw5: Ongoing serializes an absent member as JSON `null`, not as a missing key.
  // PostReturnOrderResponse.returnOrderId is `nullable: true` in the openapi v57 spec,
  // so a live 2xx can legitimately carry `returnOrderId: null` rather than omitting the
  // field. Pin that this is handled the same way as an omitted id (retryable), not by an
  // `unexpected_body_shape` schema rejection.
  it("throws a retryable OngoingApiError when the 2xx response serializes returnOrderId as null", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ returnOrderId: null, message: null }))
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putReturnOrder({
        goodsOwnerId: 7,
        returnOrderNumber: "RET-1001-ret_1",
        customerOrder: { orderId: 999 },
        inDate: "2026-07-17",
      })
    ).rejects.toMatchObject({ kind: "retryable" })
  })

  it("propagates a terminal OngoingApiError on a 4xx response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "bad request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })

    await expect(
      client.putReturnOrder({
        goodsOwnerId: 7,
        returnOrderNumber: "RET-1001-ret_1",
        customerOrder: { orderId: 999 },
        inDate: "2026-07-17",
      })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
})

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

const order = (id: number, extra: Record<string, unknown> = {}) => ({
  orderInfo: {
    orderId: id,
    orderNumber: `ORD-${id}`,
    orderStatus: { number: 400, text: "Sent" },
  },
  ...extra,
})

describe("OngoingClient.getOrdersByStatus", () => {
  it("queries with cursor params (orderIdFrom/maxOrdersToGet), never page/pageSize (bead ji6)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([order(555)]))
    const client = new OngoingClient(creds, { fetchImpl })

    await client.getOrdersByStatus(100, 999)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain("/orders?goodsOwnerId=7")
    expect(url).toContain("orderStatusFrom=100")
    expect(url).toContain("orderStatusTo=999")
    expect(url).toContain("orderIdFrom=0")
    expect(url).toContain("maxOrdersToGet=50")
    expect(url).not.toContain("page=")
    expect(url).not.toContain("pageSize=")
  })

  it("omits the changed-since filter unless one is passed, and sends it as orderStatusChangedTimeFrom (bead t36)", async () => {
    // A fresh Response per call — a single one can only be read once.
    const fetchImpl = jest.fn().mockImplementation(async () => json([order(555)]))
    const client = new OngoingClient(creds, { fetchImpl })

    await client.getOrdersByStatus(451, 1000)
    expect(fetchImpl.mock.calls[0][0]).not.toContain("orderStatusChangedTimeFrom")

    await client.getOrdersByStatus(451, 1000, "2026-07-30T09:15:00.000Z")

    const [url] = fetchImpl.mock.calls[1]
    expect(url).toContain("orderStatusFrom=451")
    expect(url).toContain("orderStatusTo=1000")
    // URL-encoded: the ISO timestamp's colons must not be sent raw.
    expect(url).toContain("orderStatusChangedTimeFrom=2026-07-30T09%3A15%3A00.000Z")
  })

  it("extracts waybills from parcels[].tracking and order-level tracking[], with URLs (bead 5vu)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        order(555, {
          parcels: [{ tracking: { waybill: "WB-1", trackingUrl: "https://t/1" } }],
          tracking: [{ waybill: "WB-2" }],
        }),
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const orders = await client.getOrdersByStatus(100, 999)

    expect(orders).toEqual([
      {
        ongoingOrderId: 555,
        orderNumber: "ORD-555",
        statusNumber: 400,
        statusText: "Sent",
        trackingNumbers: ["WB-1", "WB-2"],
        tracking: [
          { number: "WB-1", url: "https://t/1" },
          { number: "WB-2", url: undefined },
        ],
      },
    ])
  })

  it("excludes return parcels so an RMA waybill never becomes an outbound label (PR#133 review)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        order(1, {
          parcels: [
            { isReturnParcel: true, tracking: { waybill: "RMA-1", trackingUrl: "https://return/1" } },
            { isReturnParcel: false, tracking: { waybill: "WB-OUT", trackingUrl: "https://out/1" } },
          ],
        }),
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const [o] = await client.getOrdersByStatus(100, 999)
    expect(o.tracking).toEqual([{ number: "WB-OUT", url: "https://out/1" }])
    expect(o.trackingNumbers).toEqual(["WB-OUT"])
  })

  it("dedupes a waybill that appears in both a parcel and order-level tracking", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        order(1, {
          parcels: [{ tracking: { waybill: "WB-DUP", trackingUrl: "https://t/dup" } }],
          tracking: [{ waybill: "WB-DUP" }],
        }),
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const [o] = await client.getOrdersByStatus(100, 999)
    expect(o.tracking).toEqual([{ number: "WB-DUP", url: "https://t/dup" }])
    expect(o.trackingNumbers).toEqual(["WB-DUP"])
  })

  it("advances the cursor past the highest orderId and stops on a short page", async () => {
    // Full page of 50 (ids 1..50) then a short page — cursor pagination must fetch twice
    // and pass orderIdFrom=51 on the second call, then terminate (bead ji6).
    const fullPage = Array.from({ length: 50 }, (_, i) => order(i + 1))
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(fullPage))
      .mockResolvedValueOnce(json([order(99)]))
    const client = new OngoingClient(creds, { fetchImpl })

    const orders = await client.getOrdersByStatus(100, 999)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toContain("orderIdFrom=0")
    expect(fetchImpl.mock.calls[1][0]).toContain("orderIdFrom=51")
    expect(orders).toHaveLength(51)
  })

  it("terminates instead of looping when a full page never advances the cursor (guard)", async () => {
    // A server that ignores the cursor and returns the identical full page forever would
    // have looped under the old page/pageSize scheme. The non-advance guard stops it.
    const samePage = Array.from({ length: 50 }, () => order(7)) // all same id → no advance
    // Fresh Response per call — a body stream can only be read once.
    const fetchImpl = jest.fn(async () => json(samePage))
    const client = new OngoingClient(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })

    const orders = await client.getOrdersByStatus(100, 999)

    // First page (id 7): cursor would go to 8, so a second call happens; the second page
    // (still id 7, < cursor 8) does not advance → stop. Bounded, never infinite.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(orders).toHaveLength(100)
  })
})

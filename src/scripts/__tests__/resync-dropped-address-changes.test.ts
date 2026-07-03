import resyncDroppedAddressChanges, { findCandidateOrderIds } from "../resync-dropped-address-changes"
import orderUpdatedHandler from "../../subscribers/order-updated"

jest.mock("../../subscribers/order-updated", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}))

const orderUpdatedHandlerMock = orderUpdatedHandler as unknown as jest.Mock

type RawRow = { id: string; order_id: string; created_at: string; type: string }
type GraphCall = {
  entity: string
  filters?: Record<string, unknown>
  pagination?: { take: number; skip: number }
}

function makeContainer(pages: RawRow[][]) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  let callIndex = 0
  const query = {
    graph: jest.fn(async (call: GraphCall) => {
      const page = pages[callIndex] ?? []
      callIndex += 1
      return {
        data: page.map((row) => ({
          id: row.id,
          order_id: row.order_id,
          change_type: "update_order",
          created_at: row.created_at,
          actions: [{ id: `${row.id}_act`, details: { type: row.type } }],
        })),
      }
    }),
  }
  const container = {
    resolve: jest.fn((name: string): any => {
      if (name === "logger") return logger
      if (name === "query") return query
      return undefined
    }),
  }
  return { container, logger, query }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("findCandidateOrderIds", () => {
  it("flags an order whose burst bundles an address change with a non-address change", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual(["order_1"])
  })

  it("does not flag an order whose only burst has a single row (take:1 was already correct)", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("does not flag a burst whose union has no address/contact type", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "metadata" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("treats rows more than the burst window apart as separate bursts", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:05.000Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual([])
  })

  it("evaluates multiple orders independently", () => {
    const rows = [
      {
        id: "ordch_1",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.000Z",
        actions: [{ details: { type: "shipping_address" } }],
      },
      {
        id: "ordch_2",
        order_id: "order_1",
        created_at: "2026-06-01T10:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
      {
        id: "ordch_3",
        order_id: "order_2",
        created_at: "2026-06-01T11:00:00.000Z",
        actions: [{ details: { type: "metadata" } }],
      },
      {
        id: "ordch_4",
        order_id: "order_2",
        created_at: "2026-06-01T11:00:00.010Z",
        actions: [{ details: { type: "locale" } }],
      },
    ]

    expect(findCandidateOrderIds(rows)).toEqual(["order_1"])
  })
})

describe("resyncDroppedAddressChanges", () => {
  it("replays order-updated for each candidate order found in the scan", async () => {
    const { container, query } = makeContainer([
      [
        { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
        { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
      ],
    ])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(orderUpdatedHandlerMock).toHaveBeenCalledTimes(1)
    expect(orderUpdatedHandlerMock).toHaveBeenCalledWith({
      event: { name: "order.updated", data: { id: "order_1" } },
      container,
      pluginOptions: {},
    })
    expect(query.graph).toHaveBeenCalledWith(expect.objectContaining({ entity: "order_change" }))
  })

  it("does not replay anything in --dry-run mode", async () => {
    const { container, logger } = makeContainer([
      [
        { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
        { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
      ],
    ])

    await resyncDroppedAddressChanges({ container, args: ["--dry-run"] } as any)

    expect(orderUpdatedHandlerMock).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("would replay order.updated for order_1")
    )
  })

  it("pages through order_change rows across multiple pages", async () => {
    const PAGE_SIZE = 500
    const page1: RawRow[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `ordch_p0_${i}`,
      order_id: `order_p0_${i}`,
      created_at: "2026-06-01T10:00:00.000Z",
      type: "metadata",
    }))
    const page2: RawRow[] = [
      { id: "ordch_p1_0", order_id: "order_p1_0", created_at: "2026-06-01T10:00:00.000Z", type: "metadata" },
    ]
    const { container, query } = makeContainer([page1, page2])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(query.graph).toHaveBeenCalledTimes(2)
    expect(query.graph).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pagination: expect.objectContaining({ skip: PAGE_SIZE }) })
    )
  })

  it("no-ops when the scan finds no candidate orders", async () => {
    const { container } = makeContainer([[]])

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(orderUpdatedHandlerMock).not.toHaveBeenCalled()
  })

  it("filters order_change rows using a --since-days override", async () => {
    const { container, query } = makeContainer([[]])

    await resyncDroppedAddressChanges({ container, args: ["--since-days=7"] } as any)

    const call = (query.graph as jest.Mock).mock.calls[0][0]
    const sinceIso = call.filters.created_at.$gte as string
    const days = (Date.now() - new Date(sinceIso).getTime()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })
})

import resyncDroppedAddressChanges, {
  findCandidateOrderIds,
  didAnySyncAdvance,
  type OngoingOrderSyncSnapshotRow,
} from "../resync-dropped-address-changes"
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

// `orderSyncSnapshots` is consumed in call order, one array per
// "ongoing_order_sync" query.graph call (before-replay, then after-replay,
// per candidate order, in candidate order). Defaults to `[]` for every call
// when omitted, i.e. "replay never advances anything" — the natural
// behavior when orderUpdatedHandler is mocked out and never touches the DB.
function makeContainer(pages: RawRow[][], orderSyncSnapshots?: OngoingOrderSyncSnapshotRow[][]) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  let orderChangeCallIndex = 0
  let syncSnapshotCallIndex = 0
  const query = {
    graph: jest.fn(async (call: GraphCall) => {
      if (call.entity === "ongoing_order_sync") {
        const data = orderSyncSnapshots?.[syncSnapshotCallIndex] ?? []
        syncSnapshotCallIndex += 1
        return { data }
      }
      const page = pages[orderChangeCallIndex] ?? []
      orderChangeCallIndex += 1
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

  // Regression coverage for the #110 review IMPORTANT finding: the replay
  // step calls the *live* orderUpdatedHandler, which derives changedTypes
  // from the order's CURRENT newest burst, not the specific historic burst
  // findCandidateOrderIds flagged. If a later order.updated event landed on
  // the order since the dropped burst, the flagged burst falls outside the
  // handler's 2s window and the replay silently no-ops — the historical
  // drop is never repaired. This must be surfaced, not swallowed.
  it("warns and tallies unrepaired-flagged when the replay no-ops on a superseded burst", async () => {
    const { container, logger } = makeContainer([
      [
        { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
        { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
      ],
    ])
    // orderUpdatedHandler is mocked (never mutates the DB), so the default
    // "[] before, [] after" snapshot behavior from makeContainer already
    // models the no-op case here.

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(orderUpdatedHandlerMock).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "order order_1 flagged as candidate but replay no-op'd (newer event likely superseded the historic burst) — manual review required"
      )
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("replayed order.updated for 1 order(s), 1 unrepaired-flagged")
    )
  })

  it("does not warn when the replay actually advances the order's sync rows", async () => {
    const { container, logger } = makeContainer(
      [
        [
          { id: "ordch_1", order_id: "order_1", created_at: "2026-06-01T10:00:00.000Z", type: "shipping_address" },
          { id: "ordch_2", order_id: "order_1", created_at: "2026-06-01T10:00:00.010Z", type: "locale" },
        ],
      ],
      [
        [
          {
            id: "sync_1",
            sync_state: "pending",
            last_synced_at: null,
            edit_blocked_at: null,
            last_error: null,
            retry_count: 0,
            ongoing_order_id: null,
          },
        ],
        [
          {
            id: "sync_1",
            sync_state: "sent",
            last_synced_at: "2026-06-02T00:00:00.000Z",
            edit_blocked_at: null,
            last_error: null,
            retry_count: 0,
            ongoing_order_id: 123,
          },
        ],
      ]
    )

    await resyncDroppedAddressChanges({ container, args: [] } as any)

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("replayed order.updated for 1 order(s), 0 unrepaired-flagged")
    )
  })
})

describe("didAnySyncAdvance", () => {
  it("returns false when nothing changed between snapshots", () => {
    const before: OngoingOrderSyncSnapshotRow[] = [
      { id: "sync_1", sync_state: "pending", last_synced_at: null, edit_blocked_at: null, last_error: null, retry_count: 0, ongoing_order_id: null },
    ]
    const after: OngoingOrderSyncSnapshotRow[] = [
      { id: "sync_1", sync_state: "pending", last_synced_at: null, edit_blocked_at: null, last_error: null, retry_count: 0, ongoing_order_id: null },
    ]
    expect(didAnySyncAdvance(before, after)).toBe(false)
  })

  it("returns true when a row's sync_state changed", () => {
    const before: OngoingOrderSyncSnapshotRow[] = [
      { id: "sync_1", sync_state: "pending", last_synced_at: null, edit_blocked_at: null, last_error: null, retry_count: 0, ongoing_order_id: null },
    ]
    const after: OngoingOrderSyncSnapshotRow[] = [
      { id: "sync_1", sync_state: "sent", last_synced_at: null, edit_blocked_at: null, last_error: null, retry_count: 0, ongoing_order_id: null },
    ]
    expect(didAnySyncAdvance(before, after)).toBe(true)
  })

  it("returns true when the row count changed", () => {
    expect(didAnySyncAdvance([], [
      { id: "sync_1", sync_state: "pending", last_synced_at: null, edit_blocked_at: null, last_error: null, retry_count: 0, ongoing_order_id: null },
    ])).toBe(true)
  })
})

import { GET } from "../route"

const QUERY_KEY = "query"
const MODULE_KEY = "ongoing"

const makeSyncRow = (overrides: Record<string, unknown> = {}) => ({
  id: "osync_1",
  integration_id: "int_1",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  ongoing_order_number: "1001-ful_1",
  ongoing_order_id: 555,
  latest_status_code: 320,
  latest_status_text: "Shipped",
  sync_state: "shipped",
  error_class: null,
  last_synced_at: "2026-07-01T00:00:00.000Z",
  last_error: null,
  retry_count: 0,
  shipped_at: "2026-07-01T00:00:00.000Z",
  ...overrides,
})

const makeOngoingService = (syncs: Array<Record<string, unknown>>) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(syncs),
})

const makeQuery = (data: Array<Record<string, unknown>>) => ({
  graph: jest.fn().mockResolvedValue({ data }),
})

const makeReq = (opts: {
  orderId?: string
  ongoingService: ReturnType<typeof makeOngoingService>
  query: ReturnType<typeof makeQuery>
}) =>
  ({
    params: { orderId: opts.orderId ?? "order_1" },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === MODULE_KEY) return opts.ongoingService
        if (key === QUERY_KEY) return opts.query
        throw new Error(`unexpected resolve key: ${key}`)
      }),
    },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /admin/ongoing/orders/:orderId/sync", () => {
  it("returns { syncs: [] } and never queries fulfillments when there are no sync rows", async () => {
    const ongoingService = makeOngoingService([])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(ongoingService.listOngoingOrderSyncs).toHaveBeenCalledWith({
      medusa_order_id: "order_1",
    })
    expect(query.graph).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ syncs: [] })
  })

  it("returns tracking: [] for a sync row with no medusa_fulfillment_id, without calling query.graph", async () => {
    const row = makeSyncRow({ medusa_fulfillment_id: null, sync_state: "pending" })
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      syncs: [{ ...row, tracking: [] }],
    })
  })

  it("enriches a sync row with multi-parcel tracking numbers from fulfillment.labels", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([
      {
        id: "ful_1",
        labels: [
          { tracking_number: "TRACK-A", tracking_url: "https://carrier/A" },
          { tracking_number: "TRACK-B", tracking_url: "" },
        ],
      },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).toHaveBeenCalledWith({
      entity: "fulfillment",
      fields: ["id", "labels.tracking_number", "labels.tracking_url"],
      filters: { id: ["ful_1"] },
    })
    expect(res.json).toHaveBeenCalledWith({
      syncs: [
        {
          ...row,
          tracking: [
            { tracking_number: "TRACK-A", tracking_url: "https://carrier/A" },
            { tracking_number: "TRACK-B", tracking_url: null },
          ],
        },
      ],
    })
  })

  it("filters out labels with an empty or missing tracking_number", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([
      {
        id: "ful_1",
        labels: [
          { tracking_number: "", tracking_url: "" },
          { tracking_number: null, tracking_url: null },
          { tracking_number: "TRACK-C", tracking_url: null },
        ],
      },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(res.json).toHaveBeenCalledWith({
      syncs: [{ ...row, tracking: [{ tracking_number: "TRACK-C", tracking_url: null }] }],
    })
  })

  it("returns tracking: [] when the fulfillment id is set but query.graph finds no match", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(res.json).toHaveBeenCalledWith({ syncs: [{ ...row, tracking: [] }] })
  })

  it("dedupes fulfillment ids into a single batched query.graph call across multiple sync rows", async () => {
    const rowA = makeSyncRow({ id: "osync_1", medusa_fulfillment_id: "ful_1" })
    const rowB = makeSyncRow({ id: "osync_2", medusa_fulfillment_id: "ful_1" })
    const rowC = makeSyncRow({ id: "osync_3", medusa_fulfillment_id: "ful_2" })
    const ongoingService = makeOngoingService([rowA, rowB, rowC])
    const query = makeQuery([
      { id: "ful_1", labels: [{ tracking_number: "T1", tracking_url: null }] },
      { id: "ful_2", labels: [{ tracking_number: "T2", tracking_url: null }] },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).toHaveBeenCalledTimes(1)
    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { id: ["ful_1", "ful_2"] } })
    )
    expect(res.json).toHaveBeenCalledWith({
      syncs: [
        { ...rowA, tracking: [{ tracking_number: "T1", tracking_url: null }] },
        { ...rowB, tracking: [{ tracking_number: "T1", tracking_url: null }] },
        { ...rowC, tracking: [{ tracking_number: "T2", tracking_url: null }] },
      ],
    })
  })
})

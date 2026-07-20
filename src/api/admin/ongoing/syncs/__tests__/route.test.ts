import { GET } from "../route"

const makeService = (
  opts: {
    rows?: unknown[]
    count?: number
    summaryCounts?: Partial<Record<string, number>>
  } = {}
) => {
  const summaryCounts = opts.summaryCounts ?? {}
  const listAndCountOngoingOrderSyncs = jest.fn((filter: { sync_state: unknown }) => {
    if (Array.isArray(filter.sync_state)) {
      return Promise.resolve([opts.rows ?? [], opts.count ?? 0])
    }
    return Promise.resolve([[], summaryCounts[filter.sync_state as string] ?? 0])
  })
  return { listAndCountOngoingOrderSyncs }
}

const makeReq = (opts: {
  query?: Record<string, unknown>
  service: ReturnType<typeof makeService>
}) =>
  ({
    query: opts.query ?? {},
    scope: { resolve: jest.fn(() => opts.service) },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /admin/ongoing/syncs", () => {
  it("defaults to limit=20, offset=0 when query params are absent", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 0, take: 20, order: { last_synced_at: "DESC" } }
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("parses limit/offset query strings into ints", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { limit: "5", offset: "10" }, service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 10, take: 5, order: { last_synced_at: "DESC" } }
    )
  })

  it("falls back to defaults for non-numeric or negative query values", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { limit: "abc", offset: "-5" }, service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 0, take: 20, order: { last_synced_at: "DESC" } }
    )
  })

  it("defaults to the error/sent/pending dashboard view when no ?state= is given", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ service }), res)

    const [filter] = service.listAndCountOngoingOrderSyncs.mock.calls[0]
    expect(filter).toEqual({ sync_state: ["error", "sent", "pending"] })
  })

  it("drills into a requested state via ?state= (bead on2)", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { state: "shipped" }, service }), res)

    const [filter] = service.listAndCountOngoingOrderSyncs.mock.calls[0]
    expect(filter).toEqual({ sync_state: ["shipped"] })
  })

  it("accepts multiple states (repeated params, comma-separated) and dedupes them", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { state: ["shipped", "cancelled,shipped"] }, service }), res)

    const [filter] = service.listAndCountOngoingOrderSyncs.mock.calls[0]
    expect(filter).toEqual({ sync_state: ["shipped", "cancelled"] })
  })

  it("drops unknown states and falls back to the default view when none are valid", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { state: "bogus" }, service }), res)

    const [filter] = service.listAndCountOngoingOrderSyncs.mock.calls[0]
    expect(filter).toEqual({ sync_state: ["error", "sent", "pending"] })
  })

  it("responds with { syncs, count, limit, offset, states, summary } — summary covers all 5 states", async () => {
    const rows = [
      {
        id: "oos_1",
        ongoing_order_number: "1001-a",
        medusa_order_id: "order_1",
        sync_state: "error",
        error_class: "retryable",
        retry_count: 1,
        last_error: "boom",
        last_synced_at: null,
      },
    ]
    const service = makeService({
      rows,
      count: 1,
      summaryCounts: { pending: 2, sent: 1, shipped: 5, cancelled: 3, error: 1 },
    })
    const res = makeRes()

    await GET(makeReq({ query: { limit: "5", offset: "0" }, service }), res)

    expect(res.json).toHaveBeenCalledWith({
      syncs: rows,
      count: 1,
      limit: 5,
      offset: 0,
      states: ["error", "sent", "pending"],
      summary: { pending: 2, sent: 1, shipped: 5, cancelled: 3, error: 1 },
    })
  })
})

import { retryOngoingSyncsHandler } from "../retry-ongoing-syncs"

type Row = { id: string; sync_state: string; error_class: "retryable" | "terminal" | null }

function makeContainer(rows: Row[]) {
  const listOngoingOrderSyncs = jest.fn().mockResolvedValue(rows)
  const updateOngoingOrderSyncs = jest.fn().mockResolvedValue({})
  const service = { listOngoingOrderSyncs, updateOngoingOrderSyncs }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, service }
}

// The createStep wrapper does not expose its invoke fn; test the exported handler
// directly, same pattern as pushOrderRecordSyncHandler
// (src/workflows/steps/__tests__/push-order-record-sync.test.ts).
const invoke = (input: { sync_ids: string[] }, ctx: any) =>
  retryOngoingSyncsHandler(input, ctx)

describe("retryOngoingSyncsHandler", () => {
  it("retries an error/retryable row: resets last_synced_at to null", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "retryable" },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: ["oos_1"] })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      last_synced_at: null,
    })
    expect(output).toEqual({ retried: ["oos_1"], skipped: [] })
  })

  it("skips a terminal row (does not reset last_synced_at)", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "terminal" },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["oos_1"] })
  })

  it("skips a row that is not in the error state (e.g. sent)", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "sent", error_class: null },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["oos_1"] })
  })

  it("skips a sync_id that does not exist", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ sync_ids: ["missing"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["missing"] })
  })

  it("handles a mix of eligible, terminal, and missing ids in one call", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "retryable" },
      { id: "oos_2", sync_state: "error", error_class: "terminal" },
    ])

    const output = await invoke(
      { sync_ids: ["oos_1", "oos_2", "oos_3"] },
      { container }
    )

    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      last_synced_at: null,
    })
    expect(output).toEqual({ retried: ["oos_1"], skipped: ["oos_2", "oos_3"] })
  })

  it("returns empty retried/skipped for an empty sync_ids array (no service calls)", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ sync_ids: [] }, { container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: [] })
    expect(output).toEqual({ retried: [], skipped: [] })
  })
})

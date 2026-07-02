import { computeSyncStateSummary, ALL_SYNC_STATES, type OngoingSyncsCountService } from "../summary"

function makeService(countsByState: Partial<Record<string, number>>): OngoingSyncsCountService {
  const listAndCountOngoingOrderSyncs = jest.fn(
    async (filter: { sync_state: string }) => [[], countsByState[filter.sync_state] ?? 0] as [unknown[], number]
  )
  return { listAndCountOngoingOrderSyncs }
}

describe("computeSyncStateSummary", () => {
  it("queries all 5 sync_states and returns their counts keyed by state", async () => {
    const service = makeService({
      pending: 3,
      sent: 1,
      shipped: 10,
      cancelled: 2,
      error: 4,
    })

    const summary = await computeSyncStateSummary(service)

    expect(summary).toEqual({ pending: 3, sent: 1, shipped: 10, cancelled: 2, error: 4 })
    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledTimes(5)
    for (const state of ALL_SYNC_STATES) {
      expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
        { sync_state: state },
        { skip: 0, take: 0 }
      )
    }
  })

  it("defaults a state's count to 0 when the service returns none for it", async () => {
    const service = makeService({ error: 7 })

    const summary = await computeSyncStateSummary(service)

    expect(summary).toEqual({ pending: 0, sent: 0, shipped: 0, cancelled: 0, error: 7 })
  })
})

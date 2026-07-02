export type OngoingSyncState = "pending" | "sent" | "shipped" | "cancelled" | "error"

export type OngoingSyncStateSummary = Record<OngoingSyncState, number>

export const ALL_SYNC_STATES: readonly OngoingSyncState[] = [
  "pending",
  "sent",
  "shipped",
  "cancelled",
  "error",
]

// Structurally compatible with route.ts's OngoingServiceLike (below): its filter
// type (readonly string[] | string) is a supertype of OngoingSyncState here, and
// its row type is a subtype of `unknown[]`, so the resolved module service can be
// passed to computeSyncStateSummary without a separate cast.
export type OngoingSyncsCountService = {
  listAndCountOngoingOrderSyncs: (
    filter: { sync_state: OngoingSyncState },
    config: { skip: number; take: number }
  ) => Promise<[unknown[], number]>
}

// Spec §11 requires "success/failure counters" feeding the dashboard (#44 defers
// producing these to this issue). One count-only query per sync_state (take: 0 --
// rows are discarded, only the total is used) run in parallel; 5 states is a
// fixed, small fan-out, not an unbounded N+1.
export async function computeSyncStateSummary(
  ongoing: OngoingSyncsCountService
): Promise<OngoingSyncStateSummary> {
  const counts = await Promise.all(
    ALL_SYNC_STATES.map((sync_state) =>
      ongoing.listAndCountOngoingOrderSyncs({ sync_state }, { skip: 0, take: 0 })
    )
  )

  return ALL_SYNC_STATES.reduce((summary, state, index) => {
    summary[state] = counts[index][1]
    return summary
  }, {} as OngoingSyncStateSummary)
}

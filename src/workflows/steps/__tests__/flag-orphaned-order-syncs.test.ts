import { flagOrphanedOrderSyncsHandler } from "../flag-orphaned-order-syncs"

function makeContainer(rows: Array<{ id: string }>) {
  const listOngoingOrderSyncs = jest.fn().mockResolvedValue(rows)
  const updateOngoingOrderSyncs = jest.fn().mockResolvedValue({})
  const service = { listOngoingOrderSyncs, updateOngoingOrderSyncs }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, service }
}

// The createStep wrapper does not expose its invoke fn; test the exported handler
// directly, same pattern as retryOngoingSyncsHandler
// (src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts).
const invoke = (ctx: any) => flagOrphanedOrderSyncsHandler({}, ctx)

describe("flagOrphanedOrderSyncsHandler", () => {
  it("queries sent rows with a null ongoing_order_id", async () => {
    const { container, service } = makeContainer([])

    await invoke({ container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({
      sync_state: "sent",
      ongoing_order_id: null,
    })
  })

  it("flags each orphaned row to error/retryable and resets last_synced_at", async () => {
    const { container, service } = makeContainer([{ id: "oos_1" }, { id: "oos_2" }])

    const output = await invoke({ container })

    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledTimes(2)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      sync_state: "error",
      error_class: "retryable",
      last_error:
        "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push",
      last_synced_at: null,
    })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_2",
      sync_state: "error",
      error_class: "retryable",
      last_error:
        "#108: sync recorded sent with a missing ongoing_order_id; flagged for re-push",
      last_synced_at: null,
    })
    expect(output).toEqual({ repaired: ["oos_1", "oos_2"] })
  })

  it("returns an empty repaired list and issues no writes when there are no orphaned rows", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ repaired: [] })
  })
})

import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncCancelRefusedHandler } from "../mark-order-sync-cancel-refused"

const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
  return markOrderSyncCancelRefusedHandler(input, { container })
}

describe("markOrderSyncCancelRefusedStep", () => {
  it("stamps cancel_refused_at and the operator reason", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "osync_1" }])
    const res = await invoke(
      { order_sync_id: "osync_1", reason: "Ongoing status 500 (Hentet) is not cancellable" },
      { updateOngoingOrderSyncs }
    )

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("osync_1")
    expect(arg.cancel_refused_at).toBeInstanceOf(Date)
    expect(arg.cancel_refused_reason).toContain("not cancellable")
    expect(res.output).toEqual({ order_sync_id: "osync_1" })
  })

  it("stores a null reason when none is provided", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "osync_1" }])
    await invoke({ order_sync_id: "osync_1" }, { updateOngoingOrderSyncs })

    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.cancel_refused_reason).toBeNull()
  })
})

import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncCancelledHandler } from "../mark-order-sync-cancelled"

const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
  return markOrderSyncCancelledHandler(input, { container })
}

describe("markOrderSyncCancelledStep", () => {
  it("sets sync_state to cancelled and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "osync_1" }])
    const res = await invoke(
      { orderSyncId: "osync_1" },
      { updateOngoingOrderSyncs }
    )

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("osync_1")
    expect(arg.sync_state).toBe("cancelled")
    expect(arg.error_class).toBeNull()
    expect(arg.last_error).toBeNull()
    expect(res.output).toEqual({ orderSyncId: "osync_1" })
  })
})

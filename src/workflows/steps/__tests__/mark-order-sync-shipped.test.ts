import { markOrderSyncShippedHandler } from "../mark-order-sync-shipped"

describe("markOrderSyncShippedStep", () => {
  it("sets sync_state shipped, shipped_at, status fields and clears error fields", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "os_1" }])
    const service = { updateOngoingOrderSyncs }
    const res = await markOrderSyncShippedHandler(
      { order_sync_id: "os_1", status_code: 200, status_text: "Shipped" },
      { container: { resolve: (_: string) => service } }
    )
    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("os_1")
    expect(arg.sync_state).toBe("shipped")
    expect(arg.latest_status_code).toBe(200)
    expect(arg.latest_status_text).toBe("Shipped")
    expect(arg.error_class).toBeNull()
    expect(arg.last_error).toBeNull()
    expect(arg.shipped_at).toBeInstanceOf(Date)
    expect(arg.last_synced_at).toBeInstanceOf(Date)
    expect(res.output).toEqual({ order_sync_id: "os_1" })
  })
})

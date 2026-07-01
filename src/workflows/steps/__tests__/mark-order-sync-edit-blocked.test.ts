import { markOrderSyncEditBlockedHandler } from "../mark-order-sync-edit-blocked"

describe("markOrderSyncEditBlockedStep", () => {
  it("sets edit_blocked_at/category/reason when blocked=true", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    const res = await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
      { container: { resolve: (_: string) => service } }
    )

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("oos_1")
    expect(arg.edit_blocked_at).toBeInstanceOf(Date)
    expect(arg.edit_blocked_category).toBe("address_contact")
    expect(arg.edit_blocked_reason).toBe("status_blocked")
    expect(res.output).toEqual({ order_sync_id: "oos_1" })
  })

  it("clears edit_blocked_at/category/reason when blocked=false", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: false },
      { container: { resolve: (_: string) => service } }
    )

    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.edit_blocked_at).toBeNull()
    expect(arg.edit_blocked_category).toBeNull()
    expect(arg.edit_blocked_reason).toBeNull()
  })

  it("clears category/reason even if blocked=true is called without them (defensive)", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: true },
      { container: { resolve: (_: string) => service } }
    )

    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.edit_blocked_at).toBeInstanceOf(Date)
    expect(arg.edit_blocked_category).toBeNull()
    expect(arg.edit_blocked_reason).toBeNull()
  })
})

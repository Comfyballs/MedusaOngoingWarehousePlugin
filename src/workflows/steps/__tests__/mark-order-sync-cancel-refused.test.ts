import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncCancelRefusedHandler } from "../mark-order-sync-cancel-refused"

const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
  return markOrderSyncCancelRefusedHandler(input, { container })
}

// The error path resolves the logger (ContainerRegistrationKeys.LOGGER === "logger").
const invokeWithLogger = (input: any, service: any, logger: any) => {
  const container = {
    resolve: (key: string) => (key === "logger" ? logger : service),
  } as unknown as MedusaContainer
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

  // 98q: unlike the successful-cancel path, a refused row is deliberately NOT flipped
  // to error/retryable on a write failure — the generic retry pipeline only re-pushes,
  // and that re-push would hit the x5n canceled_at guard and record the row "cancelled",
  // falsely reporting the still-live Ongoing order as cancelled. It logs and rethrows,
  // leaving sync_state at its prior (more accurate) value.
  it("rethrows without a second (error-state) write when the refusal write fails", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockRejectedValue(new Error("db write timeout"))
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

    await expect(
      invokeWithLogger({ order_sync_id: "osync_1", reason: "status 500" }, { updateOngoingOrderSyncs }, logger)
    ).rejects.toThrow("db write timeout")

    // Only the single refusal write was attempted — no error/retryable flip.
    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("NOT flipped to error/retryable")
    )
  })
})

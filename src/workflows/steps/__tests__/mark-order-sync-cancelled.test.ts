import type { MedusaContainer } from "@medusajs/framework/types"
import { markOrderSyncCancelledHandler } from "../mark-order-sync-cancelled"

const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
  return markOrderSyncCancelledHandler(input, { container })
}

// Container that resolves both the ongoing module service and the logger (the
// error path resolves the logger). ContainerRegistrationKeys.LOGGER === "logger".
const invokeWithLogger = (input: any, service: any, logger: any) => {
  const container = {
    resolve: (key: string) => (key === "logger" ? logger : service),
  } as unknown as MedusaContainer
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
    // A successful cancel supersedes any prior refusal (eer).
    expect(arg.cancel_refused_at).toBeNull()
    expect(arg.cancel_refused_reason).toBeNull()
    expect(res.output).toEqual({ orderSyncId: "osync_1" })
  })

  // 98q: cancelOrder already succeeded (Ongoing order cancelled/deleted) but the
  // ledger write throws. The row must be flipped to error/retryable so the retry
  // pipeline sweeps it — not left stuck at its pre-cancel sync_state forever.
  it("flips the row to error/retryable when the cancelled write fails, then rethrows", async () => {
    const updateOngoingOrderSyncs = jest
      .fn()
      .mockRejectedValueOnce(new Error("db write timeout"))
      .mockResolvedValueOnce([{ id: "osync_1" }])
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

    await expect(
      invokeWithLogger({ orderSyncId: "osync_1" }, { updateOngoingOrderSyncs }, logger)
    ).rejects.toThrow("db write timeout")

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(2)
    // First call = the cancelled write that failed; second = the error/retryable flip.
    const errorWrite = updateOngoingOrderSyncs.mock.calls[1][0]
    expect(errorWrite).toMatchObject({
      id: "osync_1",
      sync_state: "error",
      error_class: "retryable",
      last_error: "db write timeout",
    })
  })

  it("still rethrows the original error even if the error-state write also fails", async () => {
    const updateOngoingOrderSyncs = jest
      .fn()
      .mockRejectedValue(new Error("db down"))
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

    await expect(
      invokeWithLogger({ orderSyncId: "osync_1" }, { updateOngoingOrderSyncs }, logger)
    ).rejects.toThrow("db down")

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to record error state")
    )
  })
})

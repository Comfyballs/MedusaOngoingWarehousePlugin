import type { MedusaContainer } from "@medusajs/framework/types"
import { cancelOngoingOrderHandler } from "../cancel-ongoing-order"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const invoke = (input: any, client: any) => {
  const service = { getClient: jest.fn().mockReturnValue(client) }
  const logger = { info: jest.fn(), error: jest.fn() }
  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  } as unknown as MedusaContainer
  return { result: cancelOngoingOrderHandler(input, { container }), logger }
}

describe("cancelOngoingOrderStep", () => {
  it("calls client.cancelOrder with the ongoing order id", async () => {
    const cancelOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(cancelOrder).toHaveBeenCalledWith(999)
    expect(res.output).toEqual({ cancelled: true, swallowed: false })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: cancelled")
    )
  })

  it("swallows a terminal 4xx whose message says already cancelled (idempotent success)", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("already cancelled", { status: 400, kind: "terminal" })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already cancelled")
    )
  })

  it("swallows an already-cancelled signal carried in the error body (real client shape)", async () => {
    // doFetch puts Ongoing's own message in `body`, not in the wrapper `message`.
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed (400)", {
        status: 400,
        kind: "terminal",
        body: { message: "Order has already been cancelled" },
      })
    )
    const { result } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
  })

  it("re-throws a terminal 4xx that is NOT already-cancelled (#111: don't fake success)", async () => {
    // Order can no longer be cancelled because the warehouse already started
    // working on it — a REAL failure that must surface, not be swallowed.
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed (400)", {
        status: 400,
        kind: "terminal",
        body: { message: "Order already shipped and cannot be cancelled" },
      })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    await expect(result).rejects.toBeInstanceOf(OngoingApiError)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: failed")
    )
    // The failure log must surface Ongoing's OWN reason (from err.body), not
    // just the generic wrapper string, so operators can see WHY it failed.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("already shipped and cannot be cancelled")
    )
  })

  it("swallows an already-cancelled signal under an alternately-cased body key", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed (400)", {
        status: 400,
        kind: "terminal",
        body: { Message: "Order already cancelled" },
      })
    )
    const { result } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
  })

  it("re-throws an unrelated terminal 4xx (bad id / auth) instead of swallowing it", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed (404)", {
        status: 404,
        kind: "terminal",
        body: { message: "Order not found" },
      })
    )
    const { result } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    await expect(result).rejects.toBeInstanceOf(OngoingApiError)
  })

  it("re-throws a retryable error (429/5xx) so retryFailedSyncs can re-attempt", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("down", { status: 503, kind: "retryable" })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    await expect(result).rejects.toBeInstanceOf(OngoingApiError)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: failed")
    )
  })
})

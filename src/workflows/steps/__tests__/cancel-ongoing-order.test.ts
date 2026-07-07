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

  it("swallows a terminal 4xx (already cancelled) as idempotent success", async () => {
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
      expect.stringContaining("already cancelled/terminal")
    )
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

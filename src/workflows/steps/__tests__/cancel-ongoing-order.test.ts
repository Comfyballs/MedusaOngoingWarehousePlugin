import { cancelOngoingOrderHandler } from "../cancel-ongoing-order"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const invoke = (input: any, client: any) => {
  const service = { getClient: jest.fn().mockReturnValue(client) }
  const container = { resolve: (_: string) => service }
  return cancelOngoingOrderHandler(input, { container })
}

describe("cancelOngoingOrderStep", () => {
  it("calls client.cancelOrder with the ongoing order id", async () => {
    const cancelOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const res = await invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    expect(cancelOrder).toHaveBeenCalledWith(999)
    expect(res.output).toEqual({ cancelled: true, swallowed: false })
  })

  it("swallows a terminal 4xx (already cancelled) as idempotent success", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("already cancelled", { status: 400, kind: "terminal" })
    )
    const res = await invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
  })

  it("re-throws a retryable error (429/5xx) so retryFailedSyncs can re-attempt", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("down", { status: 503, kind: "retryable" })
    )
    await expect(
      invoke({ ongoingOrderId: 999, credentialKey: "wh-a" }, { cancelOrder })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
})

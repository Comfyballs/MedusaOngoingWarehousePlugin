import { pushOrderRecordSyncHandler } from "../push-order-record-sync"
import { OngoingApiError } from "../../../lib/ongoing/errors"

const baseInput = {
  model: { orderNumber: "1001-ful1", goodsOwnerId: 7 } as any,
  ongoing_order_number: "1001-ful1",
  credential_key: "wh-a",
  integration_id: "int_1",
  goods_owner_id: 7,
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
}

function makeContainer({ putOrder }: { putOrder: jest.Mock }) {
  const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
  const service = {
    getClient: jest.fn().mockReturnValue({ putOrder }),
    recordSync,
  }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, recordSync, service }
}

// The createStep wrapper does not expose its invoke fn; test the exported handler.
const invoke = (input: any, ctx: any) => pushOrderRecordSyncHandler(input, ctx)

describe("pushOrderRecordSyncStep", () => {
  it("records pending before PUT, calls putOrder, then records sent + ongoing id", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { container, recordSync } = makeContainer({ putOrder })

    const output = await invoke(baseInput, { container })

    expect(output).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
    expect(putOrder).toHaveBeenCalledWith(baseInput.model)

    // First recordSync = pending (before PUT), second = sent (after PUT).
    expect(recordSync).toHaveBeenCalledTimes(2)
    expect(recordSync.mock.calls[0][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "pending",
    })
    expect(recordSync.mock.calls[1][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "sent",
      ongoing_order_id: 999,
    })

    // putOrder must be called AFTER the pending record (idempotent retry).
    const pendingOrder = recordSync.mock.invocationCallOrder[0]
    const putOrderOrder = putOrder.mock.invocationCallOrder[0]
    expect(pendingOrder).toBeLessThan(putOrderOrder)
  })

  it("records a retryable error for a retryable OngoingApiError, then rethrows", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503 down", { kind: "retryable", status: 503 }))
    const { container, recordSync } = makeContainer({ putOrder })

    await expect(invoke(baseInput, { container })).rejects.toMatchObject({ kind: "retryable" })

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({
        ongoing_order_number: "1001-ful1",
        sync_state: "error",
        error_class: "retryable",
        last_error: "503 down",
      })
    )
  })

  it("defaults to terminal for a non-classified error, then rethrows", async () => {
    const putOrder = jest.fn().mockRejectedValue(new Error("mapping blew up"))
    const { container, recordSync } = makeContainer({ putOrder })

    await expect(invoke(baseInput, { container })).rejects.toThrow("mapping blew up")

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "terminal", last_error: "mapping blew up" })
    )
  })
})

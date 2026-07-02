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
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const eventBus = { emit }
  const container = {
    resolve: jest.fn((key: string) => {
      switch (key) {
        case "logger":
          return logger
        case "event_bus":
          return eventBus
        default:
          return service
      }
    }),
  }
  return { container, recordSync, service, logger, emit }
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
    // pending + sent both clear any error columns left by a prior failed attempt.
    expect(recordSync.mock.calls[0][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "pending",
      error_class: null,
      last_error: null,
    })
    expect(recordSync.mock.calls[1][0]).toMatchObject({
      ongoing_order_number: "1001-ful1",
      sync_state: "sent",
      ongoing_order_id: 999,
      error_class: null,
      last_error: null,
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

  it("classifies a non-OngoingApiError (network/unknown) failure as retryable, then rethrows", async () => {
    // #67: a raw network error (ECONNRESET / timeout / DNS / fetch TypeError) must be
    // retryable, not dead-lettered as terminal.
    const putOrder = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    const { container, recordSync } = makeContainer({ putOrder })

    await expect(invoke(baseInput, { container })).rejects.toThrow("fetch failed")

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "retryable", last_error: "fetch failed" })
    )
  })

  it("keeps a terminal OngoingApiError (e.g. validation) terminal, then rethrows", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("bad request", { kind: "terminal", status: 400 }))
    const { container, recordSync } = makeContainer({ putOrder })

    await expect(invoke(baseInput, { container })).rejects.toMatchObject({ kind: "terminal" })

    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "terminal", last_error: "bad request" })
    )
  })

  it("records an error (not stuck pending) when getClient throws", async () => {
    const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
    const service = {
      getClient: jest.fn(() => {
        throw new Error("no credentials configured for credential_key \"wh-a\"")
      }),
      recordSync,
    }
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const emit = jest.fn().mockResolvedValue(undefined)
    const container = {
      resolve: jest.fn((key: string) => {
        switch (key) {
          case "logger":
            return logger
          case "event_bus":
            return { emit }
          default:
            return service
        }
      }),
    }

    await expect(invoke(baseInput, { container })).rejects.toThrow("no credentials configured")

    // pending was written first, then the failure is recorded. A misconfigured
    // credential_key is a plain Error (#67) → classified retryable so a later
    // reconfigure + retry can succeed.
    expect(recordSync.mock.calls[0][0]).toMatchObject({ sync_state: "pending" })
    expect(recordSync).toHaveBeenCalledWith(
      expect.objectContaining({ sync_state: "error", error_class: "retryable" })
    )
  })

  it("emits ongoing.sync.order_pushed on success", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { container, emit } = makeContainer({ putOrder })

    await invoke(baseInput, { container })

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_pushed",
      data: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_number: "1001-ful1",
        ongoing_order_id: 999,
        integration_id: "int_1",
      },
    })
  })

  it("emits ongoing.sync.push_failed with error_class on failure, then rethrows", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503 down", { kind: "retryable", status: 503 }))
    const { container, emit } = makeContainer({ putOrder })

    await expect(invoke(baseInput, { container })).rejects.toMatchObject({ kind: "retryable" })

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.push_failed",
      data: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_number: "1001-ful1",
        integration_id: "int_1",
        error_class: "retryable",
        error_message: "503 down",
      },
    })
  })

  it("still completes and returns the pushed output when the order_pushed emit rejects (event-bus outage must not negate a committed push)", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { container, logger, emit } = makeContainer({ putOrder })
    emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    const output = await invoke(baseInput, { container })

    expect(output).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable")
    )
  })

  it("rethrows the original error (not the emit failure) when the push_failed emit rejects", async () => {
    const putOrder = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503 down", { kind: "retryable", status: 503 }))
    const { container, logger, emit } = makeContainer({ putOrder })
    emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    await expect(invoke(baseInput, { container })).rejects.toMatchObject({
      kind: "retryable",
      message: "503 down",
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("event bus unavailable")
    )
  })
})

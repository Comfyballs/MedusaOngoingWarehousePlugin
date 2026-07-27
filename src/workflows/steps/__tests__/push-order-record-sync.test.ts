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

function makeContainer({
  putOrder,
  putArticle,
  // x5n: canceled_at seen by the pre-putOrder re-check. Default null (nothing
  // canceled) so all pre-existing tests behave as before. `orderCanceledAt` /
  // `fulfillmentCanceledAt` set the respective query.graph result.
  orderCanceledAt = null,
  fulfillmentCanceledAt = null,
}: {
  putOrder: jest.Mock
  putArticle?: jest.Mock
  orderCanceledAt?: Date | null
  fulfillmentCanceledAt?: Date | null
}) {
  const recordSync = jest.fn().mockResolvedValue({ id: "oos_1" })
  const article = putArticle ?? jest.fn().mockResolvedValue({ articleSystemId: 1 })
  const service = {
    getClient: jest.fn().mockReturnValue({ putOrder, putArticle: article }),
    recordSync,
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const eventBus = { emit }
  const graph = jest.fn(async ({ entity }: { entity: string }) => {
    if (entity === "order") {
      return { data: [{ canceled_at: orderCanceledAt }] }
    }
    if (entity === "fulfillment") {
      return { data: [{ canceled_at: fulfillmentCanceledAt }] }
    }
    return { data: [] }
  })
  const query = { graph }
  const container = {
    resolve: jest.fn((key: string) => {
      switch (key) {
        case "logger":
          return logger
        case "event_bus":
          return eventBus
        case "query":
          return query
        default:
          return service
      }
    }),
  }
  return { container, recordSync, service, logger, emit, article, graph }
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

  it("ensures the order's articles exist (PUT /articles) after pending, before putOrder", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const putArticle = jest.fn().mockResolvedValue({ articleSystemId: 1 })
    const { container, recordSync } = makeContainer({ putOrder, putArticle })

    await invoke(
      {
        ...baseInput,
        articles: [
          { articleNumber: "SKU-A", articleName: "Alpha" },
          { articleNumber: "SKU-B", articleName: "Beta" },
        ],
      },
      { container }
    )

    expect(putArticle).toHaveBeenCalledTimes(2)
    expect(putArticle).toHaveBeenNthCalledWith(1, {
      goodsOwnerId: 7,
      articleNumber: "SKU-A",
      articleName: "Alpha",
    })

    // Order: pending record < first putArticle < putOrder.
    const pendingOrder = recordSync.mock.invocationCallOrder[0]
    const firstArticleOrder = putArticle.mock.invocationCallOrder[0]
    const putOrderOrder = putOrder.mock.invocationCallOrder[0]
    expect(pendingOrder).toBeLessThan(firstArticleOrder)
    expect(firstArticleOrder).toBeLessThan(putOrderOrder)
  })

  it("records a retryable error when article sync fails, before any putOrder", async () => {
    const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const putArticle = jest
      .fn()
      .mockRejectedValue(new OngoingApiError("503 down", { kind: "retryable", status: 503 }))
    const { container, recordSync } = makeContainer({ putOrder, putArticle })

    await expect(
      invoke(
        { ...baseInput, articles: [{ articleNumber: "SKU-A", articleName: "Alpha" }] },
        { container }
      )
    ).rejects.toMatchObject({ kind: "retryable" })

    expect(putOrder).not.toHaveBeenCalled()
    // pending + error rows recorded; the error row carries the retryable class.
    expect(recordSync.mock.calls[1][0]).toMatchObject({
      sync_state: "error",
      error_class: "retryable",
    })
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
    const query = {
      graph: jest.fn(async () => ({ data: [{ canceled_at: null }] })),
    }
    const container = {
      resolve: jest.fn((key: string) => {
        switch (key) {
          case "logger":
            return logger
          case "event_bus":
            return { emit }
          case "query":
            return query
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

  // x5n: a cancel (order.canceled / fulfillment.canceled) can land in the window
  // after this push started but before putOrder. The step re-checks canceled_at
  // immediately before the PUT and must abort WITHOUT creating a live Ongoing order.
  describe("x5n: cancel racing the push window", () => {
    it("aborts before putOrder and records the row cancelled when the order is canceled_at", async () => {
      const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
      const putArticle = jest.fn().mockResolvedValue({ articleSystemId: 1 })
      const { container, recordSync, service } = makeContainer({
        putOrder,
        putArticle,
        orderCanceledAt: new Date("2026-07-27T00:00:00.000Z"),
      })

      await expect(
        invoke(
          { ...baseInput, articles: [{ articleNumber: "SKU-A", articleName: "Alpha" }] },
          { container }
        )
      ).rejects.toMatchObject({ type: "not_allowed" })

      // No live Ongoing order created, and no articles pushed for a canceled order.
      expect(putOrder).not.toHaveBeenCalled()
      expect(putArticle).not.toHaveBeenCalled()
      expect(service.getClient).not.toHaveBeenCalled()

      // Ledger converges to cancelled (not error/retryable — nothing to retry).
      const lastRecord = recordSync.mock.calls.at(-1)![0]
      expect(lastRecord).toMatchObject({
        sync_state: "cancelled",
        error_class: null,
        last_error: null,
      })
    })

    it("aborts when only the fulfillment is canceled_at", async () => {
      const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
      const { container, recordSync, service } = makeContainer({
        putOrder,
        fulfillmentCanceledAt: new Date("2026-07-27T00:00:00.000Z"),
      })

      await expect(invoke(baseInput, { container })).rejects.toMatchObject({
        type: "not_allowed",
      })

      expect(putOrder).not.toHaveBeenCalled()
      expect(service.getClient).not.toHaveBeenCalled()
      expect(recordSync.mock.calls.at(-1)![0]).toMatchObject({ sync_state: "cancelled" })
    })

    it("pushes normally when neither the order nor the fulfillment is canceled", async () => {
      const putOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
      const { container } = makeContainer({ putOrder })

      const output = await invoke(baseInput, { container })

      expect(output).toEqual({ ongoingOrderId: 999, orderNumber: "1001-ful1" })
      expect(putOrder).toHaveBeenCalledWith(baseInput.model)
    })
  })
})

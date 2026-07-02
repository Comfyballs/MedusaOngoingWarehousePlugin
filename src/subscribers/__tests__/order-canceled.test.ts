import type { SubscriberArgs } from "@medusajs/framework"

// Mock the #28 workflow module: named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({ result: { shouldCancel: true, reason: "ok" } })
jest.mock("../../workflows/cancel-ongoing-order", () => ({
  __esModule: true,
  cancelOngoingOrderWorkflow: jest.fn(() => ({ run })),
}))

import orderCanceledHandler, { config } from "../order-canceled"

type Row = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  medusa_fulfillment_id?: string
}

const makeArgs = (
  orderId: string,
  rows: Row[],
  overrides: { listImpl?: () => Promise<Row[]> } = {}
) => {
  const listOngoingOrderSyncs =
    overrides.listImpl ?? jest.fn().mockResolvedValue(rows)
  const service = { listOngoingOrderSyncs }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "event_bus") return { emit }
      return service
    }),
  }
  const args = {
    event: { eventName: "order.canceled", data: { id: orderId } },
    container,
  } as unknown as SubscriberArgs<{ id: string }>
  return { args, service, logger, container, listOngoingOrderSyncs, emit }
}

describe("order.canceled subscriber", () => {
  it("subscribes to the single-L order.canceled event", () => {
    expect(config.event).toBe("order.canceled")
  })

  it("runs cancelOngoingOrderWorkflow once per sync row with the canonical input", async () => {
    const rows: Row[] = [
      {
        id: "syn_1",
        ongoing_order_number: "1001-aaa",
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
      },
      {
        id: "syn_2",
        ongoing_order_number: "1001-bbb",
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
      },
    ]
    const { args, listOngoingOrderSyncs } = makeArgs("order_1", rows)

    await orderCanceledHandler(args)

    expect(listOngoingOrderSyncs).toHaveBeenCalledWith(
      { medusa_order_id: "order_1" },
      { select: ["id", "ongoing_order_number", "medusa_fulfillment_id"] }
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(1, {
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_number: "1001-aaa",
      },
    })
    expect(run).toHaveBeenNthCalledWith(2, {
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
        ongoing_order_number: "1001-bbb",
      },
    })
  })

  it("is a no-op when the order has no sync rows", async () => {
    const { args } = makeArgs("order_2", [])

    await orderCanceledHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("never throws when listOngoingOrderSyncs rejects", async () => {
    const { args, logger } = makeArgs("order_3", [], {
      listImpl: jest.fn().mockRejectedValue(new Error("db down")),
    })

    await expect(orderCanceledHandler(args)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it("never throws and keeps going when one workflow run rejects", async () => {
    const rows: Row[] = [
      {
        id: "syn_1",
        ongoing_order_number: "1001-aaa",
        medusa_order_id: "order_4",
        medusa_fulfillment_id: "ful_1",
      },
      {
        id: "syn_2",
        ongoing_order_number: "1001-bbb",
        medusa_order_id: "order_4",
        medusa_fulfillment_id: "ful_2",
      },
    ]
    run
      .mockRejectedValueOnce(new Error("ongoing 500"))
      .mockResolvedValueOnce({ result: {} })
    const { args, logger } = makeArgs("order_4", rows)

    await expect(orderCanceledHandler(args)).resolves.toBeUndefined()
    // Both rows attempted even though the first threw.
    expect(run).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalled()
  })

  it("is idempotent under a duplicate order.canceled event", async () => {
    const rows: Row[] = [
      {
        id: "syn_1",
        ongoing_order_number: "1001-aaa",
        medusa_order_id: "order_5",
        medusa_fulfillment_id: "ful_1",
      },
    ]
    const { args } = makeArgs("order_5", rows)

    await orderCanceledHandler(args)
    await orderCanceledHandler(args)

    // The subscriber re-runs the workflow each time; idempotency is the
    // workflow's responsibility (status-gated, no-op if already cancelled).
    // Assert the subscriber passes the same stable canonical input both times.
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(1, {
      input: {
        medusa_order_id: "order_5",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_number: "1001-aaa",
      },
    })
    expect(run).toHaveBeenNthCalledWith(2, {
      input: {
        medusa_order_id: "order_5",
        medusa_fulfillment_id: "ful_1",
        ongoing_order_number: "1001-aaa",
      },
    })
  })

  it("emits ongoing.sync.order_cancelled for each row the workflow actually cancels", async () => {
    const rows: Row[] = [
      {
        id: "syn_1",
        ongoing_order_number: "1001-aaa",
        medusa_order_id: "order_6",
        medusa_fulfillment_id: "ful_1",
      },
    ]
    const { args, emit } = makeArgs("order_6", rows)

    await orderCanceledHandler(args)

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_cancelled",
      data: {
        medusa_order_id: "order_6",
        ongoing_order_number: "1001-aaa",
        ongoing_order_sync_id: "syn_1",
        reason: "ok",
      },
    })
  })

  it("does not emit ongoing.sync.order_cancelled when the workflow does not cancel", async () => {
    const rows: Row[] = [
      {
        id: "syn_1",
        ongoing_order_number: "1001-aaa",
        medusa_order_id: "order_7",
        medusa_fulfillment_id: "ful_1",
      },
    ]
    run.mockResolvedValueOnce({
      result: { shouldCancel: false, reason: "already_cancelled" },
    })
    const { args, emit } = makeArgs("order_7", rows)

    await orderCanceledHandler(args)

    expect(emit).not.toHaveBeenCalled()
  })
})

import type { SubscriberArgs } from "@medusajs/framework"

// Mock the return-push workflow: named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({
  result: { ongoingReturnOrderId: 555, returnOrderNumber: "RET-1001" },
})
jest.mock("../../workflows/push-return-order-to-ongoing", () => ({
  __esModule: true,
  pushReturnOrderToOngoing: jest.fn(() => ({ run })),
}))

import exchangeCreatedHandler, { config } from "../exchange-created"

type ProbeFulfillment = {
  id?: string
  provider_id?: string
  canceled_at?: string | null
}

/**
 * The exchange path issues TWO query.graph calls: first on `order_exchange` to
 * resolve the return_id, then on `return` to resolve the live fulfillment. The
 * mock branches on `entity` to serve each shape.
 */
const makeArgs = (
  data: { order_id?: string; exchange_id?: string },
  opts: {
    returnId?: string | null
    fulfillments?: ProbeFulfillment[]
    exchangeRows?: unknown[]
  } = {}
) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const returnId = opts.returnId === undefined ? "ret_x1" : opts.returnId
  const fulfillments =
    opts.fulfillments ?? [{ id: "ret_ful_x1", provider_id: "ongoing_ongoing" }]

  const graph = jest.fn(async (input: { entity: string }) => {
    if (input.entity === "order_exchange") {
      return {
        data: opts.exchangeRows ?? [{ id: data.exchange_id, return_id: returnId }],
      }
    }
    if (input.entity === "return") {
      return { data: [{ id: returnId, fulfillments }] }
    }
    return { data: [] }
  })

  const query = { graph }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "query") return query
      return undefined
    }),
  }
  const args = {
    event: { eventName: "order.exchange_created", data },
    container,
  } as unknown as SubscriberArgs<{ order_id: string; exchange_id: string }>
  return { args, logger, graph }
}

describe("order.exchange_created subscriber (pyr)", () => {
  beforeEach(() => run.mockClear())

  it("subscribes to order.exchange_created", () => {
    expect(config.event).toBe("order.exchange_created")
  })

  it("resolves the exchange return leg and pushes it to Ongoing", async () => {
    const { args, graph } = makeArgs({ order_id: "order_1", exchange_id: "exc_1" })

    await exchangeCreatedHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ input: { return_fulfillment_id: "ret_ful_x1" } })

    // First graph call resolves the return_id off the exchange.
    expect((graph as jest.Mock).mock.calls[0][0].entity).toBe("order_exchange")
    expect((graph as jest.Mock).mock.calls[0][0].filters).toEqual({ id: "exc_1" })
  })

  it("falls back to the return.id relation when return_id FK is absent", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", exchange_id: "exc_2" },
      { exchangeRows: [{ id: "exc_2", return: { id: "ret_x1" } }] }
    )

    await exchangeCreatedHandler(args)

    expect(run).toHaveBeenCalledWith({ input: { return_fulfillment_id: "ret_ful_x1" } })
  })

  it("no-ops for an outbound-only exchange with no return leg", async () => {
    const { args, graph } = makeArgs(
      { order_id: "order_1", exchange_id: "exc_3" },
      { returnId: null }
    )

    await exchangeCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
    // Only the exchange lookup ran; never queried `return`.
    expect((graph as jest.Mock).mock.calls.every((c) => c[0].entity === "order_exchange")).toBe(
      true
    )
  })

  it("skips when the return fulfillment belongs to another provider", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", exchange_id: "exc_4" },
      { fulfillments: [{ id: "ret_ful_m", provider_id: "manual_manual" }] }
    )

    await exchangeCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("warns and skips when the event carries no exchange_id", async () => {
    const { args, logger, graph } = makeArgs({ order_id: "order_1" })

    await exchangeCreatedHandler(args)

    expect(graph).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("never throws when the exchange resolution query rejects", async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const graph = jest.fn().mockRejectedValue(new Error("query down"))
    const container = {
      resolve: jest.fn((key: string) => (key === "logger" ? logger : { graph })),
    }
    const args = {
      event: { eventName: "order.exchange_created", data: { exchange_id: "exc_5" } },
      container,
    } as unknown as SubscriberArgs<{ order_id: string; exchange_id: string }>

    await expect(exchangeCreatedHandler(args)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })
})

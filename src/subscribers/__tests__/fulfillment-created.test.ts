import type { SubscriberArgs } from "@medusajs/framework"

// Mock the push workflow: named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({
  result: { ongoingOrderId: 5900, orderNumber: "1001-abc" },
})
jest.mock("../../workflows/push-order-to-ongoing", () => ({
  __esModule: true,
  pushOrderToOngoing: jest.fn(() => ({ run })),
}))

import fulfillmentCreatedHandler, { config } from "../fulfillment-created"

const makeArgs = (
  data: { order_id?: string; fulfillment_id?: string },
  opts: { providerId?: string | null; queryImpl?: () => Promise<unknown> } = {}
) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const graph =
    opts.queryImpl ??
    jest.fn().mockResolvedValue({
      data:
        opts.providerId === undefined
          ? [{ id: data.fulfillment_id, provider_id: "ongoing_ongoing" }]
          : opts.providerId === null
            ? [{ id: data.fulfillment_id }]
            : [{ id: data.fulfillment_id, provider_id: opts.providerId }],
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
    event: { eventName: "order.fulfillment_created", data },
    container,
  } as unknown as SubscriberArgs<{ order_id: string; fulfillment_id: string }>
  return { args, logger, graph }
}

describe("order.fulfillment_created subscriber (ei4)", () => {
  beforeEach(() => run.mockClear())

  it("subscribes to order.fulfillment_created", () => {
    expect(config.event).toBe("order.fulfillment_created")
  })

  it("runs pushOrderToOngoing with the fulfillment id for an Ongoing fulfillment", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", fulfillment_id: "ful_1" },
      { providerId: "ongoing_ongoing" }
    )

    await fulfillmentCreatedHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_1" } })
  })

  it("skips (no push) when the fulfillment belongs to another provider", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", fulfillment_id: "ful_2" },
      { providerId: "manual_manual" }
    )

    await fulfillmentCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("skips when the fulfillment has no provider_id", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", fulfillment_id: "ful_3" },
      { providerId: null }
    )

    await fulfillmentCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("warns and skips when the event carries no fulfillment_id", async () => {
    const { args, logger, graph } = makeArgs({ order_id: "order_1" })

    await fulfillmentCreatedHandler(args)

    expect(graph).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("never throws when the provider lookup query rejects", async () => {
    const { args, logger } = makeArgs(
      { order_id: "order_1", fulfillment_id: "ful_4" },
      { queryImpl: jest.fn().mockRejectedValue(new Error("query down")) }
    )

    await expect(fulfillmentCreatedHandler(args)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it("never throws when the push workflow rejects (error row + retry job cover it)", async () => {
    run.mockRejectedValueOnce(new Error("ongoing 500"))
    const { args, logger } = makeArgs(
      { order_id: "order_1", fulfillment_id: "ful_5" },
      { providerId: "ongoing_ongoing" }
    )

    await expect(fulfillmentCreatedHandler(args)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})

import type { SubscriberArgs } from "@medusajs/framework"

// Mock the cancel workflow: named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({ result: { shouldCancel: true, reason: "ok" } })
jest.mock("../../workflows/cancel-ongoing-order", () => ({
  __esModule: true,
  cancelOngoingOrderWorkflow: jest.fn(() => ({ run })),
}))

import fulfillmentCanceledHandler, { config } from "../fulfillment-canceled"

const makeArgs = (data: { order_id?: string; fulfillment_id?: string }) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : undefined)),
  }
  const args = {
    event: { eventName: "order.fulfillment_canceled", data },
    container,
  } as unknown as SubscriberArgs<{ order_id: string; fulfillment_id: string }>
  return { args, logger }
}

describe("order.fulfillment_canceled subscriber (ei4)", () => {
  beforeEach(() => run.mockClear())

  it("subscribes to order.fulfillment_canceled", () => {
    expect(config.event).toBe("order.fulfillment_canceled")
  })

  it("runs cancelOngoingOrderWorkflow keyed by the fulfillment id", async () => {
    const { args } = makeArgs({ order_id: "order_1", fulfillment_id: "ful_1" })

    await fulfillmentCanceledHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: { medusa_fulfillment_id: "ful_1", medusa_order_id: "order_1" },
    })
  })

  it("warns and skips when the event carries no fulfillment_id", async () => {
    const { args, logger } = makeArgs({ order_id: "order_1" })

    await fulfillmentCanceledHandler(args)

    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("never throws when the workflow rejects", async () => {
    run.mockRejectedValueOnce(new Error("ongoing down"))
    const { args, logger } = makeArgs({ order_id: "order_2", fulfillment_id: "ful_2" })

    await expect(fulfillmentCanceledHandler(args)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})

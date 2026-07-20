import type { SubscriberArgs } from "@medusajs/framework"

// Mock the return-push workflow: named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({
  result: { ongoingReturnOrderId: 555, returnOrderNumber: "RET-1001" },
})
jest.mock("../../workflows/push-return-order-to-ongoing", () => ({
  __esModule: true,
  pushReturnOrderToOngoing: jest.fn(() => ({ run })),
}))

import returnCreatedHandler, { config } from "../return-created"

const makeArgs = (
  data: { order_id?: string; return_id?: string },
  opts: {
    fulfillment?: { id?: string; provider_id?: string } | null
    queryImpl?: () => Promise<unknown>
  } = {}
) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const fulfillment =
    opts.fulfillment === undefined
      ? { id: "ret_ful_1", provider_id: "ongoing_ongoing" }
      : opts.fulfillment
  const graph =
    opts.queryImpl ??
    jest.fn().mockResolvedValue({ data: [{ id: data.return_id, fulfillment }] })
  const query = { graph }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "query") return query
      return undefined
    }),
  }
  const args = {
    event: { eventName: "order.return_requested", data },
    container,
  } as unknown as SubscriberArgs<{ order_id: string; return_id: string }>
  return { args, logger, graph }
}

describe("order.return_requested subscriber (ei4)", () => {
  beforeEach(() => run.mockClear())

  it("subscribes to order.return_requested", () => {
    expect(config.event).toBe("order.return_requested")
  })

  it("resolves the return fulfillment and runs the return push for an Ongoing return", async () => {
    const { args } = makeArgs({ order_id: "order_1", return_id: "ret_1" })

    await returnCreatedHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ input: { return_fulfillment_id: "ret_ful_1" } })
  })

  it("skips when the return fulfillment belongs to another provider", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", return_id: "ret_2" },
      { fulfillment: { id: "ret_ful_2", provider_id: "manual_manual" } }
    )

    await returnCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("skips when the return has no fulfillment yet", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", return_id: "ret_3" },
      { fulfillment: null }
    )

    await returnCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("warns and skips when the event carries no return_id", async () => {
    const { args, logger, graph } = makeArgs({ order_id: "order_1" })

    await returnCreatedHandler(args)

    expect(graph).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("never throws when the return-resolution query rejects", async () => {
    const { args, logger } = makeArgs(
      { order_id: "order_1", return_id: "ret_4" },
      { queryImpl: jest.fn().mockRejectedValue(new Error("query down")) }
    )

    await expect(returnCreatedHandler(args)).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it("never throws when the return push rejects", async () => {
    run.mockRejectedValueOnce(new Error("ongoing 500"))
    const { args, logger } = makeArgs({ order_id: "order_1", return_id: "ret_5" })

    await expect(returnCreatedHandler(args)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})

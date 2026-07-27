import type { SubscriberArgs } from "@medusajs/framework"

const run = jest.fn().mockResolvedValue({
  result: { ongoingReturnOrderId: 556, returnOrderNumber: "RET-1002" },
})
jest.mock("../../workflows/push-return-order-to-ongoing", () => ({
  __esModule: true,
  pushReturnOrderToOngoing: jest.fn(() => ({ run })),
}))

import claimCreatedHandler, { config } from "../claim-created"

type ProbeFulfillment = {
  id?: string
  provider_id?: string
  canceled_at?: string | null
}

/**
 * The claim path issues TWO query.graph calls: first on `order_claim` to resolve
 * the return_id, then on `return` to resolve the live fulfillment.
 */
const makeArgs = (
  data: { order_id?: string; claim_id?: string },
  opts: {
    returnId?: string | null
    fulfillments?: ProbeFulfillment[]
    claimRows?: unknown[]
  } = {}
) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const returnId = opts.returnId === undefined ? "ret_c1" : opts.returnId
  const fulfillments =
    opts.fulfillments ?? [{ id: "ret_ful_c1", provider_id: "ongoing_ongoing" }]

  const graph = jest.fn(async (input: { entity: string }) => {
    if (input.entity === "order_claim") {
      return { data: opts.claimRows ?? [{ id: data.claim_id, return_id: returnId }] }
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
    event: { eventName: "order.claim_created", data },
    container,
  } as unknown as SubscriberArgs<{ order_id: string; claim_id: string }>
  return { args, logger, graph }
}

describe("order.claim_created subscriber (pyr)", () => {
  beforeEach(() => run.mockClear())

  it("subscribes to order.claim_created", () => {
    expect(config.event).toBe("order.claim_created")
  })

  it("resolves the claim return leg and pushes it to Ongoing", async () => {
    const { args, graph } = makeArgs({ order_id: "order_1", claim_id: "clm_1" })

    await claimCreatedHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ input: { return_fulfillment_id: "ret_ful_c1" } })
    expect((graph as jest.Mock).mock.calls[0][0].entity).toBe("order_claim")
    expect((graph as jest.Mock).mock.calls[0][0].filters).toEqual({ id: "clm_1" })
  })

  it("no-ops for a refund-only claim with no return leg", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", claim_id: "clm_2" },
      { returnId: null }
    )

    await claimCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("skips when the return fulfillment belongs to another provider", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", claim_id: "clm_3" },
      { fulfillments: [{ id: "ret_ful_m", provider_id: "manual_manual" }] }
    )

    await claimCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("warns and skips when the event carries no claim_id", async () => {
    const { args, logger, graph } = makeArgs({ order_id: "order_1" })

    await claimCreatedHandler(args)

    expect(graph).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })
})

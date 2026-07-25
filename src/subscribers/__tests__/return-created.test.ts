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

type ProbeFulfillment = {
  id?: string
  provider_id?: string
  canceled_at?: string | null
}

// Mirrors what a real booted app returns for
// query.graph({ entity: "return", fields: ["fulfillments.*"] }): the
// `return_fulfillment` link extends Return with the PLURAL, list-valued
// `fulfillments` alias only — there is no singular `fulfillment`, and query.graph
// silently omits unknown fields rather than throwing. Asking for the wrong field
// therefore yields a row with neither key. Keeping this mock faithful is what makes
// these tests able to fail on a field-name regression; the real shape is pinned by
// the L2 spec in integration-tests/full-app.spec.ts.
const graphRow = (returnId: string | undefined, fulfillments: ProbeFulfillment[]) => ({
  id: returnId,
  fulfillments,
})

const makeArgs = (
  data: { order_id?: string; return_id?: string },
  opts: {
    fulfillments?: ProbeFulfillment[]
    queryImpl?: () => Promise<unknown>
  } = {}
) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const fulfillments =
    opts.fulfillments ?? [{ id: "ret_ful_1", provider_id: "ongoing_ongoing" }]
  const graph =
    opts.queryImpl ??
    jest.fn().mockResolvedValue({ data: [graphRow(data.return_id, fulfillments)] })
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
    const { args, graph } = makeArgs({ order_id: "order_1", return_id: "ret_1" })

    await returnCreatedHandler(args)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ input: { return_fulfillment_id: "ret_ful_1" } })

    // Regression guard: the singular `fulfillment` field does not exist on `return`,
    // and query.graph drops unknown fields silently, so asking for it would skip
    // every return push without a trace.
    const requestedFields = (graph as jest.Mock).mock.calls[0][0].fields as string[]
    expect(requestedFields).toEqual(
      expect.arrayContaining(["fulfillments.id", "fulfillments.provider_id"])
    )
    expect(requestedFields.some((f) => /^fulfillment\./.test(f))).toBe(false)
  })

  it("skips when the return fulfillment belongs to another provider", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", return_id: "ret_2" },
      { fulfillments: [{ id: "ret_ful_2", provider_id: "manual_manual" }] }
    )

    await returnCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("skips when the return has no fulfillment yet", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", return_id: "ret_3" },
      { fulfillments: [] }
    )

    await returnCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
  })

  it("ignores a canceled return fulfillment and pushes the live one", async () => {
    const { args } = makeArgs(
      { order_id: "order_1", return_id: "ret_6" },
      {
        fulfillments: [
          {
            id: "ret_ful_old",
            provider_id: "ongoing_ongoing",
            canceled_at: "2026-07-01T00:00:00.000Z",
          },
          { id: "ret_ful_new", provider_id: "ongoing_ongoing", canceled_at: null },
        ],
      }
    )

    await returnCreatedHandler(args)

    expect(run).toHaveBeenCalledWith({
      input: { return_fulfillment_id: "ret_ful_new" },
    })
  })

  it("warns and skips when the return itself does not resolve", async () => {
    const { args, logger } = makeArgs(
      { order_id: "order_1", return_id: "ret_7" },
      { queryImpl: jest.fn().mockResolvedValue({ data: [] }) }
    )

    await returnCreatedHandler(args)

    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
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

// Mock the workflows barrel so the provider's `pushReturnOrderToOngoing` import is a
// jest fn. The barrel is replaced entirely, so the real workflow graph (and its heavy
// composer imports) is never evaluated here. Mirrors create-fulfillment.test.ts.
const run = jest.fn()
const pushReturnFactory = jest.fn().mockReturnValue({ run })
jest.mock("../../../workflows", () => ({
  pushReturnOrderToOngoing: (container: unknown) => pushReturnFactory(container),
}))

// Import AFTER the mock is registered (mirrors create-fulfillment.test.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: OngoingFulfillmentProviderService } = require("../service")

const makeProvider = () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  const container = {
    logger,
    resolve: jest.fn(),
  } as any
  return {
    provider: new OngoingFulfillmentProviderService(container, {}),
    container,
    logger,
  }
}

describe("OngoingFulfillmentProviderService.createReturnFulfillment", () => {
  beforeEach(() => {
    run.mockReset()
    pushReturnFactory.mockClear()
  })

  it("runs the return-push workflow off the return fulfillment id and returns the stash", async () => {
    const { provider, container } = makeProvider()

    run.mockResolvedValue({
      result: { ongoingReturnOrderId: 555, returnOrderNumber: "RET-1001-ret_1" },
    })

    const result = await provider.createReturnFulfillment({
      id: "ret_ful_1",
      location_id: "loc_1",
      shipping_option: { id: "so_1" },
    })

    expect(pushReturnFactory).toHaveBeenCalledWith(container)
    expect(run).toHaveBeenCalledWith({
      input: { return_fulfillment_id: "ret_ful_1" },
    })
    expect(result).toEqual({
      data: {
        ongoing_return_order_number: "RET-1001-ret_1",
        ongoing_return_order_id: 555,
        medusa_return_fulfillment_id: "ret_ful_1",
      },
      labels: [],
    })
  })

  it("throws a terminal error and never calls the workflow when fromData.id is missing", async () => {
    const { provider } = makeProvider()

    await expect(
      provider.createReturnFulfillment({ location_id: "loc_1" })
    ).rejects.toThrow(/return fulfillment\.id/i)

    expect(pushReturnFactory).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("propagates a workflow failure (aborts return fulfillment creation)", async () => {
    const { provider } = makeProvider()

    run.mockRejectedValue(new Error("Ongoing unreachable"))

    await expect(
      provider.createReturnFulfillment({ id: "ret_ful_2", location_id: "loc_1" })
    ).rejects.toThrow(/Ongoing unreachable/)
  })
})

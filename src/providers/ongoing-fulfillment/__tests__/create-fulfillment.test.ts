// Mock the workflows barrel so the provider's `pushOrderToOngoing` import is a jest fn.
// The barrel is replaced entirely, so the real workflow graph (and its heavy
// composer imports) is never evaluated here.
const run = jest.fn()
const pushFactory = jest.fn().mockReturnValue({ run })
jest.mock("../../../workflows", () => ({
  pushOrderToOngoing: (container: unknown) => pushFactory(container),
}))

// Import AFTER the mock is registered (mirrors cancel-fulfillment.test.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: OngoingFulfillmentProviderService } = require("../service")

const makeProvider = (ongoingService: any) => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  const container = {
    logger,
    resolve: jest.fn((key: string) => (key === "ongoing" ? ongoingService : undefined)),
  } as any
  return {
    provider: new OngoingFulfillmentProviderService(container, {}),
    container,
    logger,
  }
}

describe("OngoingFulfillmentProviderService.createFulfillment", () => {
  beforeEach(() => {
    run.mockReset()
    pushFactory.mockClear()
  })

  it("resolves the integration, runs the push, and returns the exact stash", async () => {
    const ongoingService = {
      getIntegrationByLocation: jest
        .fn()
        .mockResolvedValue({ credential_key: "warehouse-a", stock_location_id: "loc_1" }),
    }
    const { provider, container } = makeProvider(ongoingService)

    run.mockResolvedValue({
      result: { ongoingOrderId: 999, orderNumber: "1001-abc" },
    })

    const result = await provider.createFulfillment(
      {}, // data (thin)
      [{ id: "fi_1" }] as any, // items (thin)
      undefined, // order (may be undefined)
      { id: "ful_1", location_id: "loc_1" } as any // fulfillment (hydrated)
    )

    expect(ongoingService.getIntegrationByLocation).toHaveBeenCalledWith("loc_1")
    expect(container.resolve).toHaveBeenCalledWith("ongoing")
    // The push workflow is built with the provider's container.
    expect(pushFactory).toHaveBeenCalledWith(container)
    expect(run).toHaveBeenCalledWith({
      input: { fulfillment_id: "ful_1" },
    })
    expect(result).toEqual({
      data: {
        ongoing_order_number: "1001-abc",
        ongoing_order_id: 999,
        location_id: "loc_1",
        credential_key: "warehouse-a",
      },
      labels: [],
    })
  })

  it("throws a terminal error and never calls the workflow when location_id is undefined", async () => {
    const ongoingService = { getIntegrationByLocation: jest.fn() }
    const { provider, logger } = makeProvider(ongoingService)

    await expect(
      provider.createFulfillment({}, [] as any, undefined, { id: "ful_2" } as any)
    ).rejects.toThrow(/location_id/i)

    expect(pushFactory).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(ongoingService.getIntegrationByLocation).not.toHaveBeenCalled()
    // The undefined-location path logs once so a dev fulfillment surfaces it.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it("throws a terminal error and never calls the workflow when fulfillment.id is missing", async () => {
    const ongoingService = { getIntegrationByLocation: jest.fn() }
    const { provider } = makeProvider(ongoingService)

    await expect(
      provider.createFulfillment({}, [] as any, undefined, { location_id: "loc_1" } as any)
    ).rejects.toThrow(/fulfillment\.id/i)

    expect(pushFactory).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(ongoingService.getIntegrationByLocation).not.toHaveBeenCalled()
  })

  it("throws a terminal error and never calls the workflow when no integration exists for the location", async () => {
    const ongoingService = {
      getIntegrationByLocation: jest.fn().mockResolvedValue(undefined),
    }
    const { provider } = makeProvider(ongoingService)

    await expect(
      provider.createFulfillment({}, [] as any, undefined, {
        id: "ful_3",
        location_id: "loc_x",
      } as any)
    ).rejects.toThrow(/loc_x/)

    expect(pushFactory).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

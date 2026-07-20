// ei4: createFulfillment is now module-isolation-safe — it neither resolves the
// `ongoing` module nor runs any workflow (those need the app container). It only
// validates and stashes identifiers; the Ongoing push runs in the
// `order.fulfillment_created` subscriber. So these tests assert the thin contract
// and that NO cross-module work is attempted.
import OngoingFulfillmentProviderService from "../service"

const makeProvider = () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  // A container WITHOUT `.resolve()` / `ongoing` — the real module-isolated cradle.
  // If the provider tried any cross-module resolution these tests would throw.
  const container = { logger } as any
  return {
    provider: new OngoingFulfillmentProviderService(container, {}),
    container,
    logger,
  }
}

describe("OngoingFulfillmentProviderService.createFulfillment (ei4: thin, module-isolation-safe)", () => {
  it("returns the identifier stash without resolving any sibling module or running a workflow", async () => {
    const { provider } = makeProvider()

    const result = await provider.createFulfillment(
      {}, // data (thin)
      [{ id: "fi_1" }] as any, // items (thin)
      undefined, // order (may be undefined)
      { id: "ful_1", location_id: "loc_1" } as any // fulfillment (hydrated)
    )

    expect(result).toEqual({
      data: {
        location_id: "loc_1",
        medusa_fulfillment_id: "ful_1",
      },
      labels: [],
    })
  })

  it("throws a terminal error when location_id is undefined and logs once", async () => {
    const { provider, logger } = makeProvider()

    await expect(
      provider.createFulfillment({}, [] as any, undefined, { id: "ful_2" } as any)
    ).rejects.toThrow(/location_id/i)

    // The undefined-location path logs once so a dev fulfillment surfaces it.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it("throws a terminal error when fulfillment.id is missing", async () => {
    const { provider } = makeProvider()

    await expect(
      provider.createFulfillment({}, [] as any, undefined, { location_id: "loc_1" } as any)
    ).rejects.toThrow(/fulfillment\.id/i)
  })
})

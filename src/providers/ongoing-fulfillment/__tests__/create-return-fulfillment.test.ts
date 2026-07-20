// ei4: createReturnFulfillment is now module-isolation-safe — it runs no workflow
// (the Ongoing return push runs in the `order.return_requested` subscriber). It
// only validates and stashes the return fulfillment id.
import OngoingFulfillmentProviderService from "../service"

const makeProvider = () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  const container = { logger } as any
  return {
    provider: new OngoingFulfillmentProviderService(container, {}),
    container,
    logger,
  }
}

describe("OngoingFulfillmentProviderService.createReturnFulfillment (ei4: thin)", () => {
  it("returns the return-fulfillment-id stash without running a workflow", async () => {
    const { provider } = makeProvider()

    const result = await provider.createReturnFulfillment({
      id: "ret_ful_1",
      location_id: "loc_1",
      shipping_option: { id: "so_1" },
    })

    expect(result).toEqual({
      data: {
        medusa_return_fulfillment_id: "ret_ful_1",
      },
      labels: [],
    })
  })

  it("throws a terminal error when fromData.id is missing", async () => {
    const { provider } = makeProvider()

    await expect(
      provider.createReturnFulfillment({ location_id: "loc_1" })
    ).rejects.toThrow(/return fulfillment\.id/i)
  })
})

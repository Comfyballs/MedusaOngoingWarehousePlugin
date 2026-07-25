// ei4: cancelFulfillment is now a non-throwing no-op. The real Ongoing cancel runs
// in app scope (the `order.fulfillment_canceled` / `order.canceled` subscribers),
// because the module-isolated provider container cannot run the status-gated
// cancelOngoingOrderWorkflow. Core's FulfillmentModuleService.cancelFulfillment
// inspects only throw/no-throw, so this hook must resolve without throwing.
import OngoingFulfillmentProviderService from "../service"

const makeService = () => {
  // A container WITHOUT `.resolve()` — the real module-isolated cradle. If the hook
  // tried any cross-module resolution or workflow run, this would throw.
  const container = { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } } as any
  return new OngoingFulfillmentProviderService(container, {})
}

describe("OngoingFulfillmentProviderService.cancelFulfillment (ei4: non-throwing no-op)", () => {
  it("resolves (never throws) and echoes the stashed data back", async () => {
    const service = makeService()
    const data = {
      location_id: "sloc_1",
      medusa_fulfillment_id: "ful_1",
    }

    await expect(service.cancelFulfillment(data)).resolves.toEqual(data)
  })

  it("tolerates empty/undefined data without throwing", async () => {
    const service = makeService()
    await expect(service.cancelFulfillment(undefined as any)).resolves.toEqual({})
    await expect(service.cancelFulfillment({})).resolves.toEqual({})
  })

  it("returns a shallow copy (does not mutate the caller's data object)", async () => {
    const service = makeService()
    const data = { location_id: "sloc_1" }
    const result = await service.cancelFulfillment(data)
    expect(result).not.toBe(data)
    expect(result).toEqual(data)
  })
})

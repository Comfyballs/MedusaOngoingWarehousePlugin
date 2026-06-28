import OngoingFulfillmentProviderService from "../service"

const makeService = () =>
  // These stubs read neither container nor options; empty args are safe.
  new OngoingFulfillmentProviderService({} as any, {} as any)

describe("OngoingFulfillmentProviderService extension-point stubs", () => {
  describe("createReturnFulfillment", () => {
    it("resolves to an empty data/labels result and does NOT throw", async () => {
      const service = makeService()
      await expect(
        service.createReturnFulfillment({ id: "ful_ret_1" })
      ).resolves.toEqual({ data: {}, labels: [] })
    })

    it("does not throw the base-class 'must be overridden' error", async () => {
      const service = makeService()
      await expect(service.createReturnFulfillment({})).resolves.toBeDefined()
    })
  })

  describe("getFulfillmentDocuments", () => {
    it("resolves to an empty array", async () => {
      const service = makeService()
      await expect(
        service.getFulfillmentDocuments({ id: "ful_1" })
      ).resolves.toEqual([])
    })
  })
})

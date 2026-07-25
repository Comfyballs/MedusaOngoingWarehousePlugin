import { MedusaError } from "@medusajs/framework/utils"
import OngoingFulfillmentProviderService from "../service"

const makeService = () =>
  // These stubs read neither container nor options; empty args are safe.
  new OngoingFulfillmentProviderService({} as any, {} as any)

describe("OngoingFulfillmentProviderService.validateFulfillmentData (carrier config seam)", () => {
  it("passes method data through unchanged when the option has no carrier config", async () => {
    const service = makeService()
    const data = { some: "method-data" }
    await expect(service.validateFulfillmentData({}, data, {} as any)).resolves.toBe(data)
  })

  it("accepts a well-formed way_of_delivery/transporter on the option", async () => {
    const service = makeService()
    const data = { x: 1 }
    await expect(
      service.validateFulfillmentData(
        { way_of_delivery: { code: "dhl" }, transporter: { transporterCode: "DHL" } },
        data,
        {} as any
      )
    ).resolves.toBe(data)
  })

  it("throws INVALID_DATA when the option carries a malformed way_of_delivery", async () => {
    const service = makeService()
    await expect(
      service.validateFulfillmentData({ way_of_delivery: { name: "no code" } }, {}, {} as any)
    ).rejects.toBeInstanceOf(MedusaError)
  })
})

describe("OngoingFulfillmentProviderService extension-point stubs", () => {
  // createReturnFulfillment is no longer a stub — see
  // __tests__/create-return-fulfillment.test.ts for its thin, module-isolation-safe
  // behavior (ei4: the Ongoing return push runs in the order.return_requested subscriber).

  describe("getFulfillmentDocuments", () => {
    it("resolves to an empty array", async () => {
      const service = makeService()
      await expect(
        service.getFulfillmentDocuments({ id: "ful_1" })
      ).resolves.toEqual([])
    })
  })
})

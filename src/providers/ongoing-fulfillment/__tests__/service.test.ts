import {
  ONGOING_PROVIDER_ID,
  ONGOING_STANDARD_OPTION_ID,
  ONGOING_RETURN_OPTION_ID,
  ONGOING_FULFILLMENT_OPTIONS,
} from "../constants"

describe("ongoing fulfillment constants", () => {
  it("pins the provider identifier and option ids (do not rename — provider_id derives from these)", () => {
    expect(ONGOING_PROVIDER_ID).toBe("ongoing")
    expect(ONGOING_STANDARD_OPTION_ID).toBe("ongoing-standard")
    expect(ONGOING_RETURN_OPTION_ID).toBe("ongoing-return")
  })

  it("exposes a stable two-entry option list, with the return option flagged is_return", () => {
    expect(ONGOING_FULFILLMENT_OPTIONS).toEqual([
      { id: "ongoing-standard" },
      { id: "ongoing-return", is_return: true },
    ])
  })
})

import OngoingFulfillmentProviderService from "../service"
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"

const loggerStub = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger

// The provider receives the Medusa container (cradle) as its first constructor arg.
const containerStub = { logger: loggerStub } as any

const makeService = () =>
  new OngoingFulfillmentProviderService(containerStub, {})

describe("OngoingFulfillmentProviderService", () => {
  it("exposes the stable provider identifier", () => {
    expect(OngoingFulfillmentProviderService.identifier).toBe("ongoing")
  })

  it("captures the injected container as container_ (so #21/#22 can run workflows)", () => {
    const service = makeService() as any
    expect(service.container_).toBe(containerStub)
  })

  it("getFulfillmentOptions returns the stable option ids", async () => {
    const service = makeService()
    const options = await service.getFulfillmentOptions()
    expect(options).toEqual([
      { id: "ongoing-standard" },
      { id: "ongoing-return", is_return: true },
    ])
  })

  it("validateOption resolves true for a known option id", async () => {
    const service = makeService()
    await expect(service.validateOption({ id: "ongoing-standard" })).resolves.toBe(true)
    await expect(service.validateOption({ id: "ongoing-return" })).resolves.toBe(true)
  })

  it("validateOption resolves false for an unknown option id", async () => {
    const service = makeService()
    await expect(service.validateOption({ id: "not-ours" })).resolves.toBe(false)
    await expect(service.validateOption({})).resolves.toBe(false)
  })

  it("validateFulfillmentData returns the data it was passed", async () => {
    const service = makeService()
    const data = { foo: "bar" }
    const context = { from_location: { id: "sloc_1" } } as any
    await expect(
      service.validateFulfillmentData({ id: "ongoing-standard" }, data, context)
    ).resolves.toBe(data)
  })

  it("canCalculate resolves false (flat Ongoing rates)", async () => {
    const service = makeService()
    await expect(service.canCalculate({} as any)).resolves.toBe(false)
  })

  it("overrides createFulfillment (no longer the throwing base) — behavior covered in create-fulfillment.test.ts", () => {
    // #21 implements createFulfillment; it must not be the base 'must be overridden' stub.
    expect(OngoingFulfillmentProviderService.prototype.createFulfillment).not.toBe(
      AbstractFulfillmentProviderService.prototype.createFulfillment
    )
  })
})

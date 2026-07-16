import { MedusaError } from "@medusajs/framework/utils"
import {
  extractOngoingCarrier,
  assertValidOngoingCarrierConfig,
} from "../way-of-delivery"

describe("extractOngoingCarrier", () => {
  it("returns empty for null/undefined/non-object data", () => {
    expect(extractOngoingCarrier(null)).toEqual({})
    expect(extractOngoingCarrier(undefined)).toEqual({})
    expect(extractOngoingCarrier("nope")).toEqual({})
    expect(extractOngoingCarrier({})).toEqual({})
  })

  it("reads way_of_delivery from a string code", () => {
    expect(extractOngoingCarrier({ way_of_delivery: " dhl-express " })).toEqual({
      wayOfDelivery: { code: "dhl-express" },
    })
  })

  it("reads way_of_delivery from a { code, name } object", () => {
    expect(
      extractOngoingCarrier({ way_of_delivery: { code: "postnord", name: " PostNord " } })
    ).toEqual({ wayOfDelivery: { code: "postnord", name: "PostNord" } })
  })

  it("drops way_of_delivery when the code is blank", () => {
    expect(extractOngoingCarrier({ way_of_delivery: { code: "  " } })).toEqual({})
    expect(extractOngoingCarrier({ way_of_delivery: "" })).toEqual({})
  })

  it("reads a transporter object, trimming and keeping only set fields", () => {
    expect(
      extractOngoingCarrier({
        transporter: {
          transporterCode: " DHL ",
          transporterServiceCode: "EXP",
          paymentAdvanced: true,
          extra: "ignored",
        },
      })
    ).toEqual({
      transporter: {
        transporterCode: "DHL",
        transporterServiceCode: "EXP",
        paymentAdvanced: true,
      },
    })
  })

  it("omits an all-empty transporter object", () => {
    expect(extractOngoingCarrier({ transporter: {} })).toEqual({})
    expect(extractOngoingCarrier({ transporter: { transporterCode: "  " } })).toEqual({})
  })
})

describe("assertValidOngoingCarrierConfig", () => {
  it("accepts missing / valid config", () => {
    expect(() => assertValidOngoingCarrierConfig(null)).not.toThrow()
    expect(() => assertValidOngoingCarrierConfig({})).not.toThrow()
    expect(() => assertValidOngoingCarrierConfig({ way_of_delivery: "dhl" })).not.toThrow()
    expect(() =>
      assertValidOngoingCarrierConfig({ way_of_delivery: { code: "dhl" }, transporter: {} })
    ).not.toThrow()
  })

  it("throws INVALID_DATA when way_of_delivery has no resolvable code", () => {
    let thrown: unknown
    try {
      assertValidOngoingCarrierConfig({ way_of_delivery: { name: "DHL" } })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MedusaError)
    expect((thrown as MedusaError).type).toBe(MedusaError.Types.INVALID_DATA)
  })

  it("throws INVALID_DATA when way_of_delivery is an empty string", () => {
    expect(() => assertValidOngoingCarrierConfig({ way_of_delivery: "" })).toThrow(MedusaError)
  })

  it("throws INVALID_DATA when transporter is not an object", () => {
    expect(() => assertValidOngoingCarrierConfig({ transporter: "DHL" })).toThrow(MedusaError)
  })

  it("throws INVALID_DATA when a transporter code is present but not a non-empty string", () => {
    expect(() =>
      assertValidOngoingCarrierConfig({ transporter: { transporterCode: 123 } })
    ).toThrow(MedusaError)
    expect(() =>
      assertValidOngoingCarrierConfig({ transporter: { transporterServiceCode: "  " } })
    ).toThrow(MedusaError)
  })

  it("throws INVALID_DATA when paymentAdvanced is present but not a boolean", () => {
    expect(() =>
      assertValidOngoingCarrierConfig({ transporter: { paymentAdvanced: "yes" } })
    ).toThrow(MedusaError)
  })

  it("accepts a fully-specified valid transporter", () => {
    expect(() =>
      assertValidOngoingCarrierConfig({
        transporter: { transporterCode: "DHL", transporterServiceCode: "EXP", paymentAdvanced: true },
      })
    ).not.toThrow()
  })
})

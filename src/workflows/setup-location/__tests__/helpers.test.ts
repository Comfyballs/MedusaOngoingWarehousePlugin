import {
  composeProviderId,
  decideReuse,
  extractFulfillmentSetId,
  buildServiceZoneInput,
  buildShippingOptionInput,
  requireStockLocation,
  requireCountryCode,
  requireDefaultShippingProfileId,
  requireServiceZoneId,
  resolveStoreCurrencyCode,
} from "../helpers"
import {
  ONGOING_PROVIDER_IDENTIFIER,
  ONGOING_FULFILLMENT_OPTION_ID,
  ONGOING_SHIPPING_OPTION_NAME,
  ONGOING_SEED_OPTION_TYPE,
} from "../constants"

describe("composeProviderId", () => {
  it("joins identifier and option id with an underscore", () => {
    expect(composeProviderId("ongoing", "ongoing-standard")).toBe("ongoing_ongoing-standard")
  })

  it("matches `${identifier}_${optionId}` for the real constants", () => {
    expect(composeProviderId(ONGOING_PROVIDER_IDENTIFIER, ONGOING_FULFILLMENT_OPTION_ID)).toBe(
      `${ONGOING_PROVIDER_IDENTIFIER}_${ONGOING_FULFILLMENT_OPTION_ID}`
    )
  })
})

describe("decideReuse", () => {
  it("auto + existing: reuses and returns the existing set id (default mode)", () => {
    const result = decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] })
    expect(result).toEqual({ reuse: true, fulfillmentSetId: "fset_1" })
  })

  it("auto + none: does not reuse when there are no fulfillment sets (default mode)", () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] })).toEqual({ reuse: false })
    expect(decideReuse({ id: "loc_1" })).toEqual({ reuse: false })
  })

  it('"reuse" + existing: reuses the existing set id', () => {
    expect(
      decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] }, "reuse")
    ).toEqual({ reuse: true, fulfillmentSetId: "fset_1" })
  })

  it('"reuse" + none: creates when no set exists', () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] }, "reuse")).toEqual({
      reuse: false,
    })
  })

  it('"create" + existing: always creates a new set even when one exists', () => {
    expect(
      decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] }, "create")
    ).toEqual({ reuse: false })
  })

  it('"create" + none: creates a new set', () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] }, "create")).toEqual({
      reuse: false,
    })
  })
})

describe("extractFulfillmentSetId", () => {
  it("returns the first fulfillment set id", () => {
    expect(extractFulfillmentSetId({ id: "loc_1", fulfillment_sets: [{ id: "fset_9" }] })).toBe("fset_9")
  })

  it("throws when no fulfillment set is present", () => {
    expect(() => extractFulfillmentSetId({ id: "loc_1", fulfillment_sets: [] })).toThrow(/fulfillment set/i)
  })
})

describe("setup-location guard helpers (bead 0dc)", () => {
  describe("requireStockLocation", () => {
    it("returns the location when present", () => {
      const loc = { id: "loc_1" }
      expect(requireStockLocation(loc, "loc_1")).toBe(loc)
    })
    it("throws NOT_FOUND when the location is missing", () => {
      expect(() => requireStockLocation(undefined, "loc_missing")).toThrow(/loc_missing.*not found/)
    })
  })

  describe("requireCountryCode", () => {
    it("returns the address country code", () => {
      expect(requireCountryCode({ id: "loc_1", address: { country_code: "no" } })).toBe("no")
    })
    it("throws when there is no address", () => {
      expect(() => requireCountryCode({ id: "loc_1" })).toThrow(/country_code/)
    })
    it("throws when the country code is null/empty", () => {
      expect(() => requireCountryCode({ id: "loc_1", address: { country_code: null } })).toThrow(/country_code/)
    })
  })

  describe("requireDefaultShippingProfileId", () => {
    it("returns the profile id", () => {
      expect(requireDefaultShippingProfileId({ id: "sp_1" })).toBe("sp_1")
    })
    it("throws when no default profile exists", () => {
      expect(() => requireDefaultShippingProfileId(undefined)).toThrow(/shipping profile/)
    })
  })

  describe("requireServiceZoneId", () => {
    it("returns the zone id", () => {
      expect(requireServiceZoneId({ id: "sz_1" })).toBe("sz_1")
    })
    it("throws when the zone is missing", () => {
      expect(() => requireServiceZoneId(undefined)).toThrow(/service zone/)
    })
  })

  describe("resolveStoreCurrencyCode", () => {
    it("prefers the default currency", () => {
      expect(
        resolveStoreCurrencyCode({
          supported_currencies: [
            { currency_code: "usd", is_default: false },
            { currency_code: "nok", is_default: true },
          ],
        })
      ).toBe("nok")
    })
    it("falls back to the first currency when none is marked default", () => {
      expect(
        resolveStoreCurrencyCode({ supported_currencies: [{ currency_code: "usd" }] })
      ).toBe("usd")
    })
    it("throws when there is no store", () => {
      expect(() => resolveStoreCurrencyCode(undefined)).toThrow(/no store/)
    })
    it("throws when the store has no supported currencies", () => {
      expect(() => resolveStoreCurrencyCode({ supported_currencies: [] })).toThrow(/no supported currencies/)
    })
  })
})

describe("buildServiceZoneInput", () => {
  it("scopes a country geo zone to the location country", () => {
    const input = buildServiceZoneInput({ fulfillmentSetId: "fset_1", countryCode: "no" })
    expect(input).toEqual({
      data: [
        {
          name: "Ongoing",
          fulfillment_set_id: "fset_1",
          geo_zones: [{ type: "country", country_code: "no" }],
        },
      ],
    })
  })
})

describe("buildShippingOptionInput", () => {
  it("builds a flat seeded option with the composed provider_id", () => {
    const input = buildShippingOptionInput({
      serviceZoneId: "sz_1",
      shippingProfileId: "sp_1",
      providerId: "ongoing_ongoing-standard",
      currencyCode: "nok",
    })
    expect(input).toEqual([
      {
        name: ONGOING_SHIPPING_OPTION_NAME,
        service_zone_id: "sz_1",
        shipping_profile_id: "sp_1",
        provider_id: "ongoing_ongoing-standard",
        price_type: "flat",
        prices: [{ currency_code: "nok", amount: 0 }],
        type: ONGOING_SEED_OPTION_TYPE,
      },
    ])
  })
})

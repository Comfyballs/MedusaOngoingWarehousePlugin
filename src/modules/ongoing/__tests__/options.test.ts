import { validateOngoingOptions } from "../options"

const valid = {
  integrations: [
    { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

describe("validateOngoingOptions", () => {
  it("accepts a well-formed options object", () => {
    expect(validateOngoingOptions(valid).integrations[0].key).toBe("wh-a")
  })

  it("rejects missing integrations array", () => {
    expect(() => validateOngoingOptions({})).toThrow(/integrations/)
  })

  it("rejects an integration missing required fields", () => {
    expect(() =>
      validateOngoingOptions({ integrations: [{ key: "wh-a", baseUrl: "https://x" }] })
    ).toThrow(/wh-a/)
  })

  it("rejects duplicate credential keys", () => {
    expect(() =>
      validateOngoingOptions({ integrations: [valid.integrations[0], valid.integrations[0]] })
    ).toThrow(/duplicate/i)
  })

  it("accepts a valid rateLimitConcurrency", () => {
    expect(
      validateOngoingOptions({ ...valid, rateLimitConcurrency: 4 }).rateLimitConcurrency
    ).toBe(4)
  })

  it.each([0, -1, 1.5, "3"])(
    "rejects an invalid rateLimitConcurrency (%p)",
    (bad) => {
      expect(() =>
        validateOngoingOptions({ ...valid, rateLimitConcurrency: bad })
      ).toThrow(/rateLimitConcurrency/)
    }
  )

  it("accepts valid interval options", () => {
    expect(() =>
      validateOngoingOptions({
        ...valid,
        defaultStatusPollInterval: "30000",
        defaultStockSyncInterval: "600000",
      })
    ).not.toThrow()
  })

  it.each([
    ["defaultStatusPollInterval", "abc"],
    ["defaultStatusPollInterval", "0"],
    ["defaultStockSyncInterval", "-5"],
  ])("rejects a non-numeric/non-positive %s (%p)", (field, bad) => {
    expect(() =>
      validateOngoingOptions({ ...valid, [field]: bad })
    ).toThrow(new RegExp(field))
  })
})

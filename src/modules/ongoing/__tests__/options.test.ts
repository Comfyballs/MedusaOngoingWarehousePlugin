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
})

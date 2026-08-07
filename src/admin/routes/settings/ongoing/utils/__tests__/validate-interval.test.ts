import { isValidIntervalString, validateIntervalField } from "../validate-interval"

describe("isValidIntervalString", () => {
  it.each(["900000", "1", "600000"])("accepts a positive integer string (%s)", (value) => {
    expect(isValidIntervalString(value)).toBe(true)
  })

  it.each(["0", "-5", "abc", "", "  ", "NaN"])(
    "rejects a non-positive or non-numeric value (%p)",
    (value) => {
      expect(isValidIntervalString(value)).toBe(false)
    }
  )
})

describe("validateIntervalField", () => {
  it("returns null for a blank value (inherits the default)", () => {
    expect(validateIntervalField("", "Stock sync interval")).toBeNull()
    expect(validateIntervalField("   ", "Stock sync interval")).toBeNull()
  })

  it("returns null for a valid positive integer string", () => {
    expect(validateIntervalField("900000", "Stock sync interval")).toBeNull()
  })

  it.each(["abc", "0", "-5"])("returns a labelled error for an invalid value (%p)", (value) => {
    const message = validateIntervalField(value, "Stock sync interval")
    expect(message).toMatch(/^Stock sync interval must be a positive whole number/)
  })
})

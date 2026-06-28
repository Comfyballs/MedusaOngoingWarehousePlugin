import { buildOngoingOrderNumber } from "../order-number"

describe("buildOngoingOrderNumber", () => {
  it("produces `<display_id>-<fulfillment.id>` with the full fulfillment id", () => {
    expect(
      buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_01J9ABCDEF0123456789" })
    ).toBe("1001-ful_01J9ABCDEF0123456789")
  })

  it("is deterministic for the same inputs (stable across retries)", () => {
    const input = { displayId: 1001, fulfillmentId: "ful_01J9ABCDEF0123456789" }
    expect(buildOngoingOrderNumber(input)).toBe(buildOngoingOrderNumber(input))
  })

  it("produces different keys for different fulfillments of the same order", () => {
    const a = buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_A" })
    const b = buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_B" })
    expect(a).not.toBe(b)
    expect(a).toBe("1001-ful_A")
    expect(b).toBe("1001-ful_B")
  })

  it("accepts a string display_id", () => {
    expect(buildOngoingOrderNumber({ displayId: "1001", fulfillmentId: "ful_A" })).toBe("1001-ful_A")
  })

  it("always returns a non-empty key", () => {
    const key = buildOngoingOrderNumber({ displayId: 1, fulfillmentId: "f" })
    expect(key.length).toBeGreaterThan(0)
  })

  it("throws when display_id is missing or empty", () => {
    expect(() =>
      buildOngoingOrderNumber({ displayId: undefined as unknown as number, fulfillmentId: "ful_A" })
    ).toThrow(/display/i)
    expect(() => buildOngoingOrderNumber({ displayId: "", fulfillmentId: "ful_A" })).toThrow(/display/i)
  })

  it("throws when fulfillment id is missing or empty", () => {
    expect(() =>
      buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: undefined as unknown as string })
    ).toThrow(/fulfillment/i)
    expect(() => buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "" })).toThrow(/fulfillment/i)
  })
})

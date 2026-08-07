import { parseEditSyncRulesJson } from "../parse-codes"

describe("parseEditSyncRulesJson", () => {
  it("returns null for an empty or whitespace-only string", () => {
    expect(parseEditSyncRulesJson("")).toBeNull()
    expect(parseEditSyncRulesJson("   ")).toBeNull()
  })

  it("parses a valid JSON object of category -> number[]", () => {
    expect(parseEditSyncRulesJson('{"address_contact": [200, 300]}')).toEqual({
      address_contact: [200, 300],
    })
  })

  it("parses an object with an empty array value", () => {
    expect(parseEditSyncRulesJson('{"line_items": []}')).toEqual({ line_items: [] })
  })

  it("throws on invalid JSON", () => {
    expect(() => parseEditSyncRulesJson("{not json")).toThrow("Edit sync rules must be valid JSON")
  })

  it("throws when the JSON parses to a non-object (array, number, string)", () => {
    expect(() => parseEditSyncRulesJson("[1,2,3]")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson("5")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson('"hello"')).toThrow("Edit sync rules must be a JSON object")
  })

  // bead atq: valid JSON, wrong schema — the more common mistake than malformed JSON.
  it.each([
    ['{"address_contact": "resync"}', "address_contact"],
    ['{"line_items": 200}', "line_items"],
    ['{"line_items": [200, "300"]}', "line_items"],
    ['{"line_items": null}', "line_items"],
  ])("throws when a category's value isn't an array of numbers (%s)", (json, category) => {
    expect(() => parseEditSyncRulesJson(json)).toThrow(
      `"${category}" must be an array of status-code numbers`
    )
  })
})

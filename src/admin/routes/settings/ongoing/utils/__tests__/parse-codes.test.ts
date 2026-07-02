import { parseCodesCsv, parseEditSyncRulesJson } from "../parse-codes"

describe("parseCodesCsv", () => {
  it("parses a comma/space-separated list into numbers", () => {
    expect(parseCodesCsv("300, 320  410")).toEqual([300, 320, 410])
  })

  it("returns null for an empty or whitespace-only string", () => {
    expect(parseCodesCsv("")).toBeNull()
    expect(parseCodesCsv("   ")).toBeNull()
  })

  it("throws on a non-integer token", () => {
    expect(() => parseCodesCsv("300, abc")).toThrow('"abc" is not a valid status code')
  })

  it("throws on a decimal token", () => {
    expect(() => parseCodesCsv("300.5")).toThrow('"300.5" is not a valid status code')
  })
})

describe("parseEditSyncRulesJson", () => {
  it("returns null for an empty or whitespace-only string", () => {
    expect(parseEditSyncRulesJson("")).toBeNull()
    expect(parseEditSyncRulesJson("   ")).toBeNull()
  })

  it("parses a valid JSON object", () => {
    expect(parseEditSyncRulesJson('{"address": "resync"}')).toEqual({ address: "resync" })
  })

  it("throws on invalid JSON", () => {
    expect(() => parseEditSyncRulesJson("{not json")).toThrow("Edit sync rules must be valid JSON")
  })

  it("throws when the JSON parses to a non-object (array, number, string)", () => {
    expect(() => parseEditSyncRulesJson("[1,2,3]")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson("5")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson('"hello"')).toThrow("Edit sync rules must be a JSON object")
  })
})

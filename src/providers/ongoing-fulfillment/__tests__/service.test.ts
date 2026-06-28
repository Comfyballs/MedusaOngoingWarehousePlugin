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

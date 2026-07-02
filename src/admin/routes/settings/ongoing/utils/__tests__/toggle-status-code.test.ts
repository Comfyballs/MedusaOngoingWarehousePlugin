import { toggleStatusCode } from "../toggle-status-code"

describe("toggleStatusCode", () => {
  it("adds a status number when checked and not already selected", () => {
    expect(toggleStatusCode([100, 200], 300, true)).toEqual([100, 200, 300])
  })

  it("keeps the result sorted ascending regardless of insertion order", () => {
    expect(toggleStatusCode([300, 100], 200, true)).toEqual([100, 200, 300])
  })

  it("is a no-op when checking a status number that is already selected", () => {
    expect(toggleStatusCode([100, 200], 100, true)).toEqual([100, 200])
  })

  it("removes a status number when unchecked", () => {
    expect(toggleStatusCode([100, 200, 300], 200, false)).toEqual([100, 300])
  })

  it("is a no-op when unchecking a status number that is not selected", () => {
    expect(toggleStatusCode([100, 200], 300, false)).toEqual([100, 200])
  })

  it("returns an empty array when the last selected code is unchecked", () => {
    expect(toggleStatusCode([100], 100, false)).toEqual([])
  })
})

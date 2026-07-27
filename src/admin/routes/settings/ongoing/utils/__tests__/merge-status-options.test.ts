import { mergeStatusOptions } from "../merge-status-options"

describe("mergeStatusOptions", () => {
  it("returns the live statuses sorted by number when nothing is selected", () => {
    expect(
      mergeStatusOptions(
        [
          { number: 200, text: "Åpen" },
          { number: 100, text: "Ny" },
        ],
        []
      )
    ).toEqual([
      { number: 100, text: "Ny" },
      { number: 200, text: "Åpen" },
    ])
  })

  it("surfaces stored codes that are not in the live list as label-less options", () => {
    expect(mergeStatusOptions([], [400, 200])).toEqual([
      { number: 200, text: "" },
      { number: 400, text: "" },
    ])
  })

  it("prefers the labelled live status over a stored code with the same number", () => {
    expect(
      mergeStatusOptions([{ number: 200, text: "Åpen" }], [200])
    ).toEqual([{ number: 200, text: "Åpen" }])
  })

  it("merges live and stored-only codes and keeps them sorted", () => {
    expect(
      mergeStatusOptions(
        [
          { number: 200, text: "Åpen" },
          { number: 300, text: "Plukk" },
        ],
        [450, 200]
      )
    ).toEqual([
      { number: 200, text: "Åpen" },
      { number: 300, text: "Plukk" },
      { number: 450, text: "" },
    ])
  })

  it("returns an empty list when there are no statuses and nothing selected", () => {
    expect(mergeStatusOptions([], [])).toEqual([])
  })
})

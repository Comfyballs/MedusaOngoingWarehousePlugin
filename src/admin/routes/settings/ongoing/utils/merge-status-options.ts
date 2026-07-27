export type StatusOption = { number: number; text: string }

// Merge the live status list returned by "Test connection" with the codes
// already stored on the integration. Stored codes that are not (yet) in the
// live list are surfaced as label-less options (text: "") so an operator can
// see and un-select them without first re-running Test connection; when a live
// fetch resolves, the labelled entry from `statuses` wins. Result is sorted by
// number so the checkbox order is stable across mount and post-fetch.
export function mergeStatusOptions(
  statuses: StatusOption[],
  selected: number[]
): StatusOption[] {
  const byNumber = new Map<number, StatusOption>()
  for (const status of statuses) {
    byNumber.set(status.number, status)
  }
  for (const code of selected) {
    if (!byNumber.has(code)) {
      byNumber.set(code, { number: code, text: "" })
    }
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number)
}

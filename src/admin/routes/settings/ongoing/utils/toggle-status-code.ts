export function toggleStatusCode(
  selected: number[],
  statusNumber: number,
  checked: boolean
): number[] {
  if (checked) {
    if (selected.includes(statusNumber)) {
      return selected
    }
    return [...selected, statusNumber].sort((a, b) => a - b)
  }
  return selected.filter((code) => code !== statusNumber)
}

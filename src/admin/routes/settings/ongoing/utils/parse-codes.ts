// Parses the "Edit sync rules" JSON textarea into a plain object, or null if
// empty. Throws a friendly error both on unparseable JSON and on JSON that
// parses but isn't an object (an array, number, string, or null literal).
export function parseEditSyncRulesJson(json: string): Record<string, unknown> | null {
  const trimmed = json.trim()
  if (!trimmed) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error("Edit sync rules must be valid JSON")
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Edit sync rules must be a JSON object")
  }

  return parsed as Record<string, unknown>
}

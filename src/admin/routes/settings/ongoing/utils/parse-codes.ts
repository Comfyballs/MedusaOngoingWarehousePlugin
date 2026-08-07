// Parses the "Edit sync rules" JSON textarea into a plain object, or null if
// empty. Throws a friendly error on unparseable JSON, on JSON that parses but
// isn't an object (an array, number, string, or null literal), and — bead atq —
// on an object whose shape doesn't match the real edit_sync_rules type used at
// runtime (Record<string, number[]>, see IntegrationRow in
// src/workflows/steps/gate-order-edit.ts): each category's value must be an
// array of numbers. Valid-JSON-wrong-schema (e.g. a string or a single number
// instead of an array) is the more common mistake than malformed JSON, so this
// check catches it before Save rather than at gateOrderEditStep runtime.
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

  for (const [category, codes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(codes) || !codes.every((code) => typeof code === "number")) {
      throw new Error(`"${category}" must be an array of status-code numbers, e.g. [200, 300]`)
    }
  }

  return parsed as Record<string, unknown>
}

// Interval fields (stock_sync_interval / status_poll_interval) accept a string of
// milliseconds. The stored value is parsed with `parseInt` at read time
// (resolveIntervalMs in src/jobs/status-poll.ts and its stock-sync counterpart) —
// anything that doesn't parse to a positive number silently falls back to the
// default, so a saved-but-broken value looks like it worked. Mirrors
// validateIntervalOption's semantics (src/modules/ongoing/options.ts) and the
// route-level check (src/api/admin/ongoing/integrations/interval-validation.ts) so
// the form, the route, and boot-time option validation all agree on what counts as
// a valid interval (bead atq). Keep all three in sync on change.
export function isValidIntervalString(value: string): boolean {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0
}

// Returns a field-level error message, or null when the value is valid. A blank
// value is valid — it means "inherit the default" — only a non-blank value that
// fails to parse is rejected.
export function validateIntervalField(value: string, label: string): string | null {
  if (value.trim() === "") {
    return null
  }
  return isValidIntervalString(value)
    ? null
    : `${label} must be a positive whole number of milliseconds (e.g. 900000).`
}

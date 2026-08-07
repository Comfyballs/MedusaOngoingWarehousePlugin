import { validateIntervalOption } from "../../../../modules/ongoing/options"

// stock_sync_interval / status_poll_interval are stored as raw strings and parsed with
// `parseInt` at read time (resolveIntervalMs in src/jobs/status-poll.ts and its stock-sync
// counterpart) — a value that doesn't parse to a positive number silently falls back to the
// default instead of erroring, so a saved-but-broken value looks like it worked. Reject it
// at the route instead (bead atq).
//
// This delegates to the module's own validateIntervalOption rather than restating the rule,
// so the DB path and the plugin-options boot path can't drift apart. The admin form has a
// separate client-side mirror (src/admin/routes/settings/ongoing/utils/validate-interval.ts)
// — that one is unavoidable, since the admin bundle can't import server module code.
export function validateIntervalString(value: string, field: string): void {
  validateIntervalOption(value, field)
}

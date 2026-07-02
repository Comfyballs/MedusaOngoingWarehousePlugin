export type OngoingIntegrationHealth = "healthy" | "stale" | "disabled"

export type OngoingIntegrationRow = {
  id: string
  credential_key: string
  enabled: boolean
  status_poll_interval: string | null
  last_status_poll_at: string | null
}

// --- Consumes from #40 (GET /admin/ongoing/integrations) ---
// CONFIRMED (see Global Constraints in the plan): #40's plan pins the response
// as res.json({ integrations }) -- a pluralized resource key, matching this
// issue's own GET /admin/ongoing/syncs convention (`{ syncs, ... }`).
export type OngoingIntegrationsListResponse = {
  integrations: OngoingIntegrationRow[]
}

// Mirrors OngoingModuleService.getDefaultStatusPollIntervalMs()'s default
// (src/modules/ongoing/service.ts:84, "60000") -- the admin UI has no access
// to plugin options, so it falls back to the same literal default.
const DEFAULT_STATUS_POLL_INTERVAL_MS = 60_000
const STALE_MULTIPLIER = 2

/**
 * Static connection-health derivation (no live "Test connection" call -- that
 * stays on #40's settings page). Pure function, no I/O, easy to reason about.
 *
 * - disabled: integration.enabled === false
 * - healthy: enabled AND last polled within STALE_MULTIPLIER x its poll interval
 * - stale: enabled AND (never polled OR last poll older than that window)
 */
export function deriveConnectionHealth(
  integration: OngoingIntegrationRow,
  nowMs: number = Date.now()
): OngoingIntegrationHealth {
  if (!integration.enabled) {
    return "disabled"
  }

  if (!integration.last_status_poll_at) {
    return "stale"
  }

  const intervalMs = parseIntervalMs(integration.status_poll_interval)
  const lastPollMs = new Date(integration.last_status_poll_at).getTime()
  const ageMs = nowMs - lastPollMs

  return ageMs <= intervalMs * STALE_MULTIPLIER ? "healthy" : "stale"
}

// Same parseInt-with-fallback convention as resolveIntervalMs in
// src/jobs/status-poll.ts:66-73.
function parseIntervalMs(raw: string | null): number {
  if (raw != null) {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_STATUS_POLL_INTERVAL_MS
}

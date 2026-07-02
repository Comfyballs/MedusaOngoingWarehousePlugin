import { deriveConnectionHealth } from "../connection-health"

const BASE = {
  id: "int_1",
  credential_key: "wh-1",
  enabled: true,
  status_poll_interval: null as string | null,
  last_status_poll_at: null as string | null,
}

const NOW = new Date("2026-07-01T12:00:00.000Z").getTime()

describe("deriveConnectionHealth", () => {
  it("returns disabled when the integration is not enabled (regardless of poll recency)", () => {
    const integration = {
      ...BASE,
      enabled: false,
      last_status_poll_at: new Date(NOW).toISOString(),
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("disabled")
  })

  it("returns stale when enabled but never polled (last_status_poll_at is null)", () => {
    const integration = { ...BASE, enabled: true, last_status_poll_at: null }

    expect(deriveConnectionHealth(integration, NOW)).toBe("stale")
  })

  it("returns healthy when enabled and last polled within 2x the poll interval", () => {
    const intervalMs = 60_000
    const lastPollMs = NOW - intervalMs // 1x interval ago -- within the 2x window

    const integration = {
      ...BASE,
      enabled: true,
      status_poll_interval: String(intervalMs),
      last_status_poll_at: new Date(lastPollMs).toISOString(),
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("healthy")
  })

  it("returns stale when enabled but last polled more than 2x the poll interval ago", () => {
    const intervalMs = 60_000
    const lastPollMs = NOW - intervalMs * 3 // 3x interval ago -- outside the 2x window

    const integration = {
      ...BASE,
      enabled: true,
      status_poll_interval: String(intervalMs),
      last_status_poll_at: new Date(lastPollMs).toISOString(),
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("stale")
  })

  it("is healthy exactly at the 2x-interval boundary (<=, not <)", () => {
    const intervalMs = 60_000

    const integration = {
      ...BASE,
      enabled: true,
      status_poll_interval: String(intervalMs),
      last_status_poll_at: new Date(NOW - intervalMs * 2).toISOString(),
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("healthy")
  })

  it("falls back to the default 60s interval when status_poll_interval is null (healthy case)", () => {
    const integration = {
      ...BASE,
      enabled: true,
      status_poll_interval: null,
      last_status_poll_at: new Date(NOW - 60_000).toISOString(), // 1x default interval ago
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("healthy")
  })

  it("falls back to the default 60s interval when status_poll_interval is non-numeric (stale case)", () => {
    const integration = {
      ...BASE,
      enabled: true,
      status_poll_interval: "not-a-number",
      last_status_poll_at: new Date(NOW - 200_000).toISOString(), // > 2x default interval ago
    }

    expect(deriveConnectionHealth(integration, NOW)).toBe("stale")
  })
})

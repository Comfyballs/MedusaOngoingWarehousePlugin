import OngoingModuleService from "../service"

const validOptions = {
  integrations: [
    { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

// Build a service instance the same way sync-lock.test.ts / record-sync.test.ts do
// (no MikroORM / DB) — attemptRetrySyncTransition receives its manager directly via
// the sharedContext argument in these tests, bypassing baseRepository_ entirely.
function makeService() {
  return new OngoingModuleService({} as any, validOptions as any)
}

function makeManager(affectedRows: number) {
  return { nativeUpdate: jest.fn().mockResolvedValue(affectedRows) }
}

describe("OngoingModuleService.attemptRetrySyncTransition", () => {
  it("issues a guarded nativeUpdate keyed on id + sync_state='error' + expected retry_count, and returns true on a single-row match", async () => {
    const svc = makeService()
    const manager = makeManager(1)

    const won = await svc.attemptRetrySyncTransition(
      {
        id: "sync_1",
        expected_retry_count: 0,
        retry_count: 1,
        last_synced_at: new Date("2026-07-03T12:00:00.000Z"),
      },
      { manager } as any
    )

    expect(won).toBe(true)
    expect(manager.nativeUpdate).toHaveBeenCalledTimes(1)
    expect(manager.nativeUpdate).toHaveBeenCalledWith(
      "OngoingOrderSync",
      { id: "sync_1", sync_state: "error", retry_count: 0 },
      { retry_count: 1, last_synced_at: new Date("2026-07-03T12:00:00.000Z") }
    )
  })

  it("includes error_class: 'terminal' in the guarded write when dead-lettering", async () => {
    const svc = makeService()
    const manager = makeManager(1)

    const won = await svc.attemptRetrySyncTransition(
      {
        id: "sync_1",
        expected_retry_count: 4,
        retry_count: 5,
        last_synced_at: new Date("2026-07-03T12:00:00.000Z"),
        error_class: "terminal",
      },
      { manager } as any
    )

    expect(won).toBe(true)
    expect(manager.nativeUpdate).toHaveBeenCalledWith(
      "OngoingOrderSync",
      { id: "sync_1", sync_state: "error", retry_count: 4 },
      {
        retry_count: 5,
        last_synced_at: new Date("2026-07-03T12:00:00.000Z"),
        error_class: "terminal",
      }
    )
  })

  it("returns false when the guarded update matches zero rows — simulates a second overlapping tick that already won (retry_count no longer matches expected)", async () => {
    const svc = makeService()
    const manager = makeManager(0)

    const won = await svc.attemptRetrySyncTransition(
      {
        id: "sync_1",
        expected_retry_count: 0,
        retry_count: 1,
        last_synced_at: new Date(),
      },
      { manager } as any
    )

    expect(won).toBe(false)
  })

  it("returns false when the row left the error state between listing and this call (e.g. cancelled concurrently) — same guard, sync_state no longer 'error'", async () => {
    const svc = makeService()
    const manager = makeManager(0)

    const won = await svc.attemptRetrySyncTransition(
      {
        id: "sync_1",
        expected_retry_count: 2,
        retry_count: 3,
        last_synced_at: new Date(),
      },
      { manager } as any
    )

    expect(won).toBe(false)
    // The guard is a single WHERE clause covering both races (retry_count OR
    // sync_state having changed) — the caller cannot distinguish which fired,
    // and per the CAS contract it does not need to: either way, skip.
    expect(manager.nativeUpdate).toHaveBeenCalledWith(
      "OngoingOrderSync",
      { id: "sync_1", sync_state: "error", retry_count: 2 },
      expect.any(Object)
    )
  })
})

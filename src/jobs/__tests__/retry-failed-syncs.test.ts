import type { MedusaContainer } from "@medusajs/framework/types"

// Prevent the @medusajs/framework/utils import chain from loading jsonwebtoken
// (which requires a native binary not available in the unit-test environment).
// ContainerRegistrationKeys.LOGGER resolves to the string "logger" at runtime.
jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    LOGGER: "logger",
  },
  Modules: {
    EVENT_BUS: "event_bus",
  },
}))

// Prevent the modules/ongoing import from triggering model.define loading.
// Only ONGOING_MODULE (a string constant) is needed by the job.
jest.mock("../../modules/ongoing", () => ({
  ONGOING_MODULE: "ongoing",
}))

// Mock the push-order-to-ongoing workflow BEFORE importing the job.
// The mock must be hoisted above the import.
const pushRun = jest.fn().mockResolvedValue({ result: {} })
jest.mock("../../workflows", () => ({
  __esModule: true,
  pushOrderToOngoing: jest.fn(() => ({ run: pushRun })),
}))

import retryFailedSyncsJob, { config } from "../retry-failed-syncs"

type ErrorRow = {
  id: string
  medusa_fulfillment_id: string | null
  last_synced_at: Date | string | null
  retry_count: number
  error_class: "retryable" | "terminal" | null
}

/** Far-past timestamp so all backoff windows have long elapsed. */
const FAR_PAST = new Date(Date.now() - 10 * 60 * 60 * 1000) // 10 hours ago

function makeHarness(opts: {
  rows?: ErrorRow[]
  listImpl?: () => Promise<ErrorRow[]>
  transitionImpl?: jest.Mock
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const service = {
    listOngoingOrderSyncs: jest.fn(
      opts.listImpl ?? (async () => opts.rows ?? [])
    ),
    // Defaults to "this tick won the CAS" (true) unless a test overrides it to
    // simulate a losing tick (see the CAS-lost tests below).
    attemptRetrySyncTransition: opts.transitionImpl ?? jest.fn(async () => true),
  }

  const emit = jest.fn().mockResolvedValue(undefined)

  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "event_bus") return { emit }
      return service
    }),
  } as unknown as MedusaContainer

  return { container, service, logger, emit }
}

function row(over: Partial<ErrorRow> = {}): ErrorRow {
  return {
    id: "sync_1",
    medusa_fulfillment_id: "ful_abc",
    last_synced_at: FAR_PAST,
    retry_count: 0,
    error_class: "retryable",
    ...over,
  }
}

beforeEach(() => {
  pushRun.mockClear()
})

describe("retryFailedSyncsJob", () => {
  it("registers with the correct name and a once-per-minute schedule", () => {
    expect(config).toEqual({ name: "ongoing-retry-failed-syncs", schedule: "* * * * *" })
  })

  it("queries only error/retryable rows", async () => {
    const h = makeHarness({ rows: [] })
    await retryFailedSyncsJob(h.container)
    expect(h.service.listOngoingOrderSyncs).toHaveBeenCalledWith({
      sync_state: "error",
      error_class: "retryable",
    })
  })

  it("re-invokes pushOrderToOngoing for a single due retryable row, incrementing retry_count exactly once via the CAS guard", async () => {
    // retry_count=0 → backoff=5 min; last_synced_at=10h ago → due
    const r = row({ retry_count: 0 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    // Guarded write: expected_retry_count pins the row to the exact state this
    // tick observed when it listed the row; retry_count + last_synced_at are
    // the next state to write if the guard holds.
    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledTimes(1)
    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 0,
      retry_count: 1,
      last_synced_at: expect.any(Date),
    })

    // Re-invokes the push workflow.
    expect(pushRun).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_abc" } })

    expect(h.emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_retried",
      data: {
        ongoing_order_sync_id: "sync_1",
        medusa_fulfillment_id: "ful_abc",
        retry_count: 1,
      },
    })
  })

  it("skips a row when the CAS guard loses — simulates a second overlapping tick that already won: no re-invoke, no event emit, no error, logs at info", async () => {
    const r = row({ retry_count: 0 })
    const transitionImpl = jest.fn(async () => false)
    const h = makeHarness({ rows: [r], transitionImpl })

    await retryFailedSyncsJob(h.container)

    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 0,
      retry_count: 1,
      last_synced_at: expect.any(Date),
    })
    expect(pushRun).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.logger.error).not.toHaveBeenCalled()
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("lost the retry_count CAS guard")
    )
  })

  it("skips a row that left the error state between listing and updating (e.g. concurrently cancelled) — same CAS-lost path as a raced retry_count, correct", async () => {
    // The job cannot distinguish "another tick raced retry_count" from "the row
    // was cancelled concurrently" — both make attemptRetrySyncTransition's guarded
    // WHERE match zero rows, so both return false and take the same skip path.
    const r = row({ retry_count: 2 })
    const transitionImpl = jest.fn(async () => false)
    const h = makeHarness({ rows: [r], transitionImpl })

    await retryFailedSyncsJob(h.container)

    expect(pushRun).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it("skips dead-lettering when the CAS guard loses on the dead-letter branch too", async () => {
    // retry_count=4 → resolveRetryOutcome increments to 5 = MAX_SYNC_RETRIES → dead-letter branch
    const r = row({ retry_count: 4 })
    const transitionImpl = jest.fn(async () => false)
    const h = makeHarness({ rows: [r], transitionImpl })

    await retryFailedSyncsJob(h.container)

    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 4,
      retry_count: 5,
      last_synced_at: expect.any(Date),
      error_class: "terminal",
    })
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.logger.error).not.toHaveBeenCalled()
  })

  it("skips a row whose backoff window has not yet elapsed", async () => {
    // retry_count=0 → 5-min window; last_synced_at=2 min ago → NOT due
    const r = row({
      retry_count: 0,
      last_synced_at: new Date(Date.now() - 2 * 60 * 1000),
    })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.service.attemptRetrySyncTransition).not.toHaveBeenCalled()
    expect(pushRun).not.toHaveBeenCalled()
  })

  it("dead-letters a row that has exhausted MAX_SYNC_RETRIES and does not re-invoke", async () => {
    // retry_count=4 → resolveRetryOutcome increments to 5 = MAX_SYNC_RETRIES → dead-letter
    const r = row({ retry_count: 4 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 4,
      retry_count: 5,
      last_synced_at: expect.any(Date),
      error_class: "terminal",
    })
    expect(pushRun).not.toHaveBeenCalled()

    expect(h.emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_dead_lettered",
      data: {
        ongoing_order_sync_id: "sync_1",
        medusa_fulfillment_id: "ful_abc",
        retry_count: 5,
      },
    })
  })

  // Regression for bead MedusaOngoingWarehousePlugin-dpa: a null-fulfillment
  // row used to be warned-and-skipped without any state transition, so the
  // error/retryable sweep re-listed it every tick forever.
  it("dead-letters a row with null medusa_fulfillment_id (cannot be retried) instead of skipping it forever", async () => {
    const r = row({ medusa_fulfillment_id: null, retry_count: 2 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    // Flips error_class to terminal via the CAS guard, without spending an
    // attempt (retry_count unchanged) — the sweep query excludes it afterwards.
    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 2,
      retry_count: 2,
      last_synced_at: expect.any(Date),
      error_class: "terminal",
    })
    expect(pushRun).not.toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dead-lettered row sync_1")
    )
    expect(h.emit).toHaveBeenCalledWith({
      name: "ongoing.sync.order_dead_lettered",
      data: {
        ongoing_order_sync_id: "sync_1",
        medusa_fulfillment_id: null,
        retry_count: 2,
      },
    })
  })

  it("skips the null-fulfillment dead-letter when the CAS guard loses — no event emit, no error", async () => {
    const r = row({ medusa_fulfillment_id: null })
    const transitionImpl = jest.fn(async () => false)
    const h = makeHarness({ rows: [r], transitionImpl })

    await retryFailedSyncsJob(h.container)

    expect(pushRun).not.toHaveBeenCalled()
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.logger.error).not.toHaveBeenCalled()
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("lost the CAS guard")
    )
  })

  it("does not log the row as failed when the null-fulfillment dead-letter emit rejects (the write itself succeeded)", async () => {
    const r = row({ medusa_fulfillment_id: null })
    const h = makeHarness({ rows: [r] })
    h.emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    await expect(retryFailedSyncsJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\[ongoing\] retry: row sync_1 /)
    )
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit ongoing.sync.order_dead_lettered")
    )
  })

  it("continues processing remaining rows when one row throws during re-invocation", async () => {
    const r1 = row({ id: "sync_1", medusa_fulfillment_id: "ful_1" })
    const r2 = row({ id: "sync_2", medusa_fulfillment_id: "ful_2" })
    const h = makeHarness({ rows: [r1, r2] })

    pushRun
      .mockRejectedValueOnce(new Error("ongoing 503"))
      .mockResolvedValueOnce({ result: {} })

    await expect(retryFailedSyncsJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    // Both rows win their CAS guard and attempt re-invoke; only the second
    // succeeds but neither aborts the loop.
    expect(pushRun).toHaveBeenCalledTimes(2)
  })

  it("never throws and logs when listOngoingOrderSyncs fails", async () => {
    const h = makeHarness({
      listImpl: async () => {
        throw new Error("db down")
      },
    })

    await expect(retryFailedSyncsJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(pushRun).not.toHaveBeenCalled()
  })

  it("treats null last_synced_at as epoch (always due)", async () => {
    const r = row({ last_synced_at: null })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    // null → treated as 0 ms → always due → proceed to CAS guard + push
    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalled()
    expect(pushRun).toHaveBeenCalled()
  })

  it("does not log the row as failed when the order_retried emit rejects (the re-invocation itself succeeded)", async () => {
    const r = row({ retry_count: 0 })
    const h = makeHarness({ rows: [r] })
    h.emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    await expect(retryFailedSyncsJob(h.container)).resolves.toBeUndefined()

    expect(pushRun).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_abc" } })
    // The row-level sweep catch (`row ${id} ... failed: ...`) must not fire —
    // the re-invocation itself succeeded, only the best-effort emit failed.
    expect(h.logger.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\[ongoing\] retry: row sync_1 /)
    )
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit ongoing.sync.order_retried")
    )
  })

  it("does not log the row as failed when the order_dead_lettered emit rejects (the dead-letter write itself succeeded)", async () => {
    const r = row({ retry_count: 4 })
    const h = makeHarness({ rows: [r] })
    h.emit.mockRejectedValueOnce(new Error("event bus unavailable"))

    await expect(retryFailedSyncsJob(h.container)).resolves.toBeUndefined()

    expect(h.service.attemptRetrySyncTransition).toHaveBeenCalledWith({
      id: "sync_1",
      expected_retry_count: 4,
      retry_count: 5,
      last_synced_at: expect.any(Date),
      error_class: "terminal",
    })
    expect(h.logger.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\[ongoing\] retry: row sync_1 /)
    )
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit ongoing.sync.order_dead_lettered")
    )
  })
})

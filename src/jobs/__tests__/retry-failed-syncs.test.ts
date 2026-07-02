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
  updateImpl?: jest.Mock
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const service = {
    listOngoingOrderSyncs: jest.fn(
      opts.listImpl ?? (async () => opts.rows ?? [])
    ),
    updateOngoingOrderSyncs: opts.updateImpl ?? jest.fn(async () => ({})),
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

  it("re-invokes pushOrderToOngoing for a due retryable row and persists incremented retry_count with last_synced_at", async () => {
    // retry_count=0 → backoff=5 min; last_synced_at=10h ago → due
    const r = row({ retry_count: 0 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    // Persists incremented retry_count AND stamps last_synced_at BEFORE re-invocation.
    // last_synced_at advances the backoff anchor so the next sweep respects the
    // exponential interval even if the workflow rejects before its recordSync step.
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sync_1",
        retry_count: 1,
        last_synced_at: expect.any(Date),
      })
    )

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

  it("stamps last_synced_at before re-invocation so the backoff is anchored even when the workflow rejects before recordSync", async () => {
    // Bug scenario: early workflow step throws (e.g. fulfillment deleted),
    // so recordSync inside pushOrderToOngoing never runs and never advances
    // last_synced_at. Without stamping it in the pre-invocation update, the row
    // would appear "due" again on the very next tick and re-fire every minute
    // until dead-lettered — bypassing all exponential spacing.
    const r = row({ retry_count: 0, last_synced_at: FAR_PAST })
    const updateCalls: Array<Record<string, unknown>> = []
    const updateImpl = jest.fn(async (data: Record<string, unknown>) => {
      updateCalls.push({ ...data })
      return {}
    })
    const h = makeHarness({ rows: [r], updateImpl })

    pushRun.mockRejectedValueOnce(new Error("step 1 throws: fulfillment not found"))

    await retryFailedSyncsJob(h.container)

    // The pre-invocation update MUST include last_synced_at so the next sweep
    // treats the row as not-due for the full 5-min backoff window.
    expect(updateImpl).toHaveBeenCalledTimes(1)
    const updateArg = updateCalls[0]
    expect(updateArg).toHaveProperty("id", "sync_1")
    expect(updateArg).toHaveProperty("retry_count", 1)
    expect(updateArg).toHaveProperty("last_synced_at")
    expect(updateArg["last_synced_at"]).toBeInstanceOf(Date)
    // The stamped time must be recent (within 1 s of this test run).
    expect(Date.now() - (updateArg["last_synced_at"] as Date).getTime()).toBeLessThan(1000)
  })

  it("skips a row whose backoff window has not yet elapsed", async () => {
    // retry_count=0 → 5-min window; last_synced_at=2 min ago → NOT due
    const r = row({
      retry_count: 0,
      last_synced_at: new Date(Date.now() - 2 * 60 * 1000),
    })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(pushRun).not.toHaveBeenCalled()
  })

  it("dead-letters a row that has exhausted MAX_SYNC_RETRIES and does not re-invoke", async () => {
    // retry_count=4 → resolveRetryOutcome increments to 5 = MAX_SYNC_RETRIES → dead-letter
    const r = row({ retry_count: 4 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "sync_1",
      retry_count: 5,
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

  it("skips a row with null medusa_fulfillment_id and logs a warning — does not dead-letter", async () => {
    const r = row({ medusa_fulfillment_id: null })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("sync_1"))
    expect(h.service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(pushRun).not.toHaveBeenCalled()
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
    // Both rows attempt re-invoke; only the second succeeds but neither aborts the loop.
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

    // null → treated as 0 ms → always due → proceed to update + push
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalled()
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

    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "sync_1",
      retry_count: 5,
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

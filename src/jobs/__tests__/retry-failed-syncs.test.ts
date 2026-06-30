import type { MedusaContainer } from "@medusajs/framework/types"

// Prevent the @medusajs/framework/utils import chain from loading jsonwebtoken
// (which requires a native binary not available in the unit-test environment).
// ContainerRegistrationKeys.LOGGER resolves to the string "logger" at runtime.
jest.mock("@medusajs/framework/utils", () => ({
  ContainerRegistrationKeys: {
    LOGGER: "logger",
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

  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  } as unknown as MedusaContainer

  return { container, service, logger }
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

  it("re-invokes pushOrderToOngoing for a due retryable row and persists incremented retry_count", async () => {
    // retry_count=0 → backoff=5 min; last_synced_at=10h ago → due
    const r = row({ retry_count: 0 })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    // Persists incremented retry_count BEFORE re-invocation.
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "sync_1",
      retry_count: 1,
    })

    // Re-invokes the push workflow.
    expect(pushRun).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_abc" } })
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
})

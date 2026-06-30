# retryFailedSyncs Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a once-a-minute Medusa scheduled job that sweeps `OngoingOrderSync` rows in the `error/retryable` state, applies per-row exponential backoff to decide which are due, dead-letters rows that have exhausted `MAX_SYNC_RETRIES`, and re-invokes `pushOrderToOngoing` for the rest.

**Architecture:** One job file `src/jobs/retry-failed-syncs.ts` exporting a default async `retryFailedSyncsJob(container)` plus `export const config`. The job lists all `{ sync_state: "error", error_class: "retryable" }` rows (across all integrations), applies an in-memory due-check (`Date.now() - last_synced_at >= computeRetryBackoffMs(retry_count)`), and for each due row either dead-letters it (via `resolveRetryOutcome`) or increments `retry_count` and re-invokes `pushOrderToOngoing`. A new pure helper `computeRetryBackoffMs` is co-located with the existing retry-policy module. **This MUST be a plain Medusa scheduled job function, not a `createWorkflow`** — Medusa workflow bodies cannot iterate dynamic runtime arrays returned from a DB query (no for-loop over a row set inside `createWorkflow`). The status-poll job (`src/jobs/status-poll.ts`) is the canonical structural precedent.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` (already wired: `jest.config.js`, `yarn test`).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Node **>= 20**, package manager **yarn 4.6.0**.
- Module id is `"ongoing"` (string literal); import the constant `ONGOING_MODULE` from `src/modules/ongoing/index.ts`.
- A scheduled job exports a **default async `handler(container: MedusaContainer): Promise<void>`** plus `export const config = { name: string; schedule: string }`.
- **Job function, not workflow.** Never use `createWorkflow` here — workflow bodies cannot loop over a runtime DB-returned array. The structural precedent is `src/jobs/status-poll.ts`.
- **Module isolation:** the job resolves only the `ongoing` module service (`ONGOING_MODULE`) plus `pushOrderToOngoing` workflow. No cross-module service calls.
- The job handler **never rethrows**: per-row `try/catch`, log error + `continue`. One row's failure must not abort the sweep.
- Backoff: `computeRetryBackoffMs(retryCount) = Math.min(3_600_000, 300_000 * 2 ** retryCount)`. Delays at retries 0..4: 5 min → 10 min → 20 min → 40 min → 60 min (capped). Due-check: `(Date.now() - new Date(row.last_synced_at).getTime()) >= computeRetryBackoffMs(row.retry_count)`.
- Two retry layers — **do not conflate**: `OngoingClient.maxRetries` (default 3, ~250 ms back-off) governs per-HTTP-call transient retries **within** one invocation (`src/lib/ongoing/client.ts:31,52`). `MAX_SYNC_RETRIES = 5` governs workflow-level passes across the row's lifetime (`src/lib/ongoing/retry-policy.ts:10`).
- `error_class` is dead-lettered by flipping it to `"terminal"` (no new column, no migration). The query filter `{ sync_state: "error", error_class: "retryable" }` then naturally excludes the row.
- Consumption contract for `resolveRetryOutcome` (see JSDoc at `src/lib/ongoing/retry-policy.ts:52-60`): if `outcome.dead_lettered` → `updateOngoingOrderSyncs({ id, retry_count: outcome.retry_count, error_class: "terminal" })` and skip re-invoke; else → `updateOngoingOrderSyncs({ id, retry_count: outcome.retry_count })` then re-invoke.
- `recordSync()` inside `pushOrderToOngoing` does **not** write `retry_count` (`RecordSyncInput` has no such field), so the persisted increment from `updateOngoingOrderSyncs` remains authoritative.
- Null `medusa_fulfillment_id`: skip with `logger.warn(...)`, do **not** dead-letter.
- Cron schedule: `"* * * * *"` (every minute). Per-row backoff ensures actual work is proportional to due rows.
- Plugin build output is `.medusa/server`; verify the plugin compiles with **`yarn build`**.
- Tests are **pure unit tests** (mock the module service + workflow); no local Postgres or Medusa instance.

---

## File Structure

**Create:**
- `src/jobs/retry-failed-syncs.ts` — scheduled job: default `retryFailedSyncsJob` handler + `config`, plus private helpers `isRetryDue` and `processRow`.
- `src/jobs/__tests__/retry-failed-syncs.test.ts` — unit tests for the job (mocked service + workflow).

**Modify:**
- `src/lib/ongoing/retry-policy.ts` — append exported `computeRetryBackoffMs(retryCount: number, opts?: { baseMs?: number; capMs?: number }): number` plus constants `BASE_RETRY_BACKOFF_MS = 300_000` and `MAX_RETRY_BACKOFF_MS = 3_600_000` after the existing `resolveRetryOutcome` (line 92).
- `src/lib/ongoing/__tests__/retry-policy.test.ts` — append a `describe("computeRetryBackoffMs")` block covering boundary values.

**Depends on (must already exist — do not redefine):**
- `src/modules/ongoing/index.ts` — exports `ONGOING_MODULE = "ongoing"` (exists).
- `src/modules/ongoing/service.ts` — `OngoingModuleService` with auto-CRUD including `listOngoingOrderSyncs`, `updateOngoingOrderSyncs` (exists).
- `src/lib/ongoing/retry-policy.ts` — exports `MAX_SYNC_RETRIES`, `resolveRetryOutcome`, `RetryPolicyInput`, `RetryOutcome` (exists at lines 10, 65–92).
- `src/workflows/push-order-to-ongoing.ts` — exports `pushOrderToOngoing` and `PushOrderToOngoingInput = { fulfillment_id: string }` (exists).
- `src/workflows/index.ts` (barrel) — must re-export `pushOrderToOngoing` (verify with `grep pushOrderToOngoing src/workflows/index.ts` before Task 2; add the export if missing).

---

## Task 1: `computeRetryBackoffMs` in retry-policy.ts

Add the exponential backoff helper to `src/lib/ongoing/retry-policy.ts` and cover it with boundary unit tests. This is a pure function (no I/O, no container) so it can be tested and committed independently before the job exists.

**Files:**
- Modify: `src/lib/ongoing/retry-policy.ts` (append after line 92)
- Modify: `src/lib/ongoing/__tests__/retry-policy.test.ts` (append new `describe` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeRetryBackoffMs(retryCount: number, opts?: { baseMs?: number; capMs?: number }): number` — exported from `src/lib/ongoing/retry-policy.ts`. Also exports `BASE_RETRY_BACKOFF_MS = 300_000` and `MAX_RETRY_BACKOFF_MS = 3_600_000`. Consumed by Task 2's `isRetryDue`.

- [ ] **Step 1: Write the failing tests**

Append the following import and `describe` block to the **bottom** of `src/lib/ongoing/__tests__/retry-policy.test.ts`:

```ts
import { computeRetryBackoffMs } from "../retry-policy"

describe("computeRetryBackoffMs", () => {
  it("retry 0 → BASE (5 min = 300_000 ms)", () => {
    expect(computeRetryBackoffMs(0)).toBe(300_000)
  })

  it("retry 1 → 2× BASE (10 min = 600_000 ms)", () => {
    expect(computeRetryBackoffMs(1)).toBe(600_000)
  })

  it("retry 2 → 4× BASE (20 min = 1_200_000 ms)", () => {
    expect(computeRetryBackoffMs(2)).toBe(1_200_000)
  })

  it("retry 3 → 8× BASE (40 min = 2_400_000 ms)", () => {
    expect(computeRetryBackoffMs(3)).toBe(2_400_000)
  })

  it("retry 4 → capped at MAX (60 min = 3_600_000 ms)", () => {
    expect(computeRetryBackoffMs(4)).toBe(3_600_000)
  })

  it("retry 10 → still capped at MAX (3_600_000 ms)", () => {
    expect(computeRetryBackoffMs(10)).toBe(3_600_000)
  })

  it("retry 0 with explicit opts base=1000, cap=4000 → 1000", () => {
    expect(computeRetryBackoffMs(0, { baseMs: 1_000, capMs: 4_000 })).toBe(1_000)
  })

  it("retry 2 with explicit opts base=1000, cap=4000 → capped at 4000", () => {
    expect(computeRetryBackoffMs(2, { baseMs: 1_000, capMs: 4_000 })).toBe(4_000)
  })
})
```

- [ ] **Step 2: Run the failing tests**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/lib/ongoing/__tests__/retry-policy.test.ts --testNamePattern="computeRetryBackoffMs"
```

Expected: FAIL — `computeRetryBackoffMs is not a function` (the import resolves but the export does not exist yet).

- [ ] **Step 3: Implement `computeRetryBackoffMs`**

Append the following block to the **bottom** of `src/lib/ongoing/retry-policy.ts` (after the closing brace of `resolveRetryOutcome` on line 92):

```ts
/**
 * Compute the exponential backoff delay (in ms) before a failed sync row is eligible
 * for re-invocation. The due-check in `retryFailedSyncsJob` is:
 *   `(Date.now() - new Date(row.last_synced_at).getTime()) >= computeRetryBackoffMs(row.retry_count)`
 *
 * Defaults: BASE=300_000 ms (5 min), factor=2, CAP=3_600_000 ms (60 min).
 * Resulting delays for retries 0..4: 5 / 10 / 20 / 40 / 60 min.
 *
 * The optional `opts` parameter allows overriding base/cap in unit tests.
 */
export const BASE_RETRY_BACKOFF_MS = 300_000
export const MAX_RETRY_BACKOFF_MS = 3_600_000

export function computeRetryBackoffMs(
  retryCount: number,
  opts: { baseMs?: number; capMs?: number } = {}
): number {
  const base = opts.baseMs ?? BASE_RETRY_BACKOFF_MS
  const cap = opts.capMs ?? MAX_RETRY_BACKOFF_MS
  return Math.min(cap, base * 2 ** retryCount)
}
```

- [ ] **Step 4: Run the full retry-policy test file**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/lib/ongoing/__tests__/retry-policy.test.ts
```

Expected: all existing `resolveRetryOutcome` cases pass; all 8 new `computeRetryBackoffMs` cases pass.

- [ ] **Step 5: Lint and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint && yarn build
```

Expected: no lint errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/lib/ongoing/retry-policy.ts src/lib/ongoing/__tests__/retry-policy.test.ts && git commit -m "feat(retry-policy): add computeRetryBackoffMs helper (5-min base, 60-min cap)"
```

---

## Task 2: `retryFailedSyncsJob` scheduled job

Create the job that drives the retry sweep. It lists all error/retryable rows, filters to those whose backoff has elapsed, and for each due row either dead-letters it or re-invokes `pushOrderToOngoing`.

**Files:**
- Create: `src/jobs/retry-failed-syncs.ts`
- Create: `src/jobs/__tests__/retry-failed-syncs.test.ts`

**Interfaces:**
- Consumes from Task 1: `computeRetryBackoffMs` from `../lib/ongoing/retry-policy`.
- Consumes from existing code:
  - `resolveRetryOutcome` from `../lib/ongoing/retry-policy` (exists, `src/lib/ongoing/retry-policy.ts:65`)
  - `ONGOING_MODULE` from `../modules/ongoing` (exists, `src/modules/ongoing/index.ts:5`)
  - `pushOrderToOngoing` from `../workflows` (barrel — verify before proceeding, see pre-condition below)
  - `ContainerRegistrationKeys` from `@medusajs/framework/utils`
- Produces: `default export async function retryFailedSyncsJob(container: MedusaContainer): Promise<void>` and `export const config = { name: "ongoing-retry-failed-syncs", schedule: "* * * * *" }`.

**Pre-condition — verify the barrel exports `pushOrderToOngoing`:**

```bash
grep "pushOrderToOngoing" /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/.claude/worktrees/plan-39-retryfailedsyncs-workflow/src/workflows/index.ts
```

If the output is empty, add the following line to `src/workflows/index.ts` and commit it before proceeding:

```ts
export { pushOrderToOngoing } from "./push-order-to-ongoing"
```

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/__tests__/retry-failed-syncs.test.ts`:

```ts
import type { MedusaContainer } from "@medusajs/framework/types"

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
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/jobs/__tests__/retry-failed-syncs.test.ts
```

Expected: FAIL — `Cannot find module '../retry-failed-syncs'`.

- [ ] **Step 3: Implement the job**

Create `src/jobs/retry-failed-syncs.ts`:

```ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { pushOrderToOngoing } from "../workflows"
import {
  resolveRetryOutcome,
  computeRetryBackoffMs,
} from "../lib/ongoing/retry-policy"

// Shape of an OngoingOrderSync row in the error/retryable state.
// Fields are the subset we read or write — matches OngoingOrderSync model
// (src/modules/ongoing/models/order-sync.ts).
type ErrorSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  last_synced_at: Date | string | null
  retry_count: number
  error_class: "retryable" | "terminal" | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: string
    error_class: string
  }) => Promise<ErrorSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    retry_count: number
    error_class?: "terminal"
  }) => Promise<unknown>
}

type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug?: (msg: string) => void
}

/**
 * Returns true when the exponential backoff window for this row has elapsed.
 * null last_synced_at is treated as epoch 0 (always due).
 */
function isRetryDue(row: ErrorSyncRow, now: number): boolean {
  const lastMs =
    row.last_synced_at != null ? new Date(row.last_synced_at).getTime() : 0
  return now - lastMs >= computeRetryBackoffMs(row.retry_count)
}

/**
 * Process a single due error row: dead-letter or increment retry_count + re-invoke.
 * Throws on hard failure — callers wrap each row in try/catch.
 */
async function processRow(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  row: ErrorSyncRow
): Promise<void> {
  if (row.medusa_fulfillment_id == null) {
    logger.warn(
      `[ongoing] retry: row ${row.id} has no medusa_fulfillment_id — skipping (not dead-lettering)`
    )
    return
  }

  const outcome = resolveRetryOutcome({
    retry_count: row.retry_count,
    error_class: row.error_class,
  })

  if (outcome.dead_lettered) {
    await service.updateOngoingOrderSyncs({
      id: row.id,
      retry_count: outcome.retry_count,
      error_class: "terminal",
    })
    logger.info(
      `[ongoing] retry: dead-lettered row ${row.id} after ${outcome.retry_count} attempts`
    )
    return
  }

  // Persist the incremented count BEFORE re-invoking: a crash between the two
  // operations must not cause the count to regress (it is safe to lose one
  // re-invocation but not to reset the counter).
  await service.updateOngoingOrderSyncs({
    id: row.id,
    retry_count: outcome.retry_count,
  })

  await pushOrderToOngoing(container).run({
    input: { fulfillment_id: row.medusa_fulfillment_id },
  })

  logger.info(
    `[ongoing] retry: re-invoked push for row ${row.id} (attempt ${outcome.retry_count})`
  )
}

export default async function retryFailedSyncsJob(
  container: MedusaContainer
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let rows: ErrorSyncRow[]
  try {
    rows = await service.listOngoingOrderSyncs({
      sync_state: "error",
      error_class: "retryable",
    })
  } catch (error) {
    logger.error(
      `[ongoing] retry: failed to list error rows: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()

  for (const row of rows) {
    if (!isRetryDue(row, now)) {
      continue
    }

    try {
      await processRow(container, service, logger, row)
    } catch (error) {
      logger.error(
        `[ongoing] retry: row ${row.id} (ful=${row.medusa_fulfillment_id ?? "null"}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one row's failure must not abort the sweep.
    }
  }
}

export const config = {
  name: "ongoing-retry-failed-syncs",
  schedule: "* * * * *",
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/jobs/__tests__/retry-failed-syncs.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
```

Expected: all existing tests plus the new tests pass. Zero failures.

- [ ] **Step 6: Lint and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint && yarn build
```

Expected: zero lint errors; `yarn build` produces `.medusa/server` with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/jobs/retry-failed-syncs.ts src/jobs/__tests__/retry-failed-syncs.test.ts && git commit -m "feat(ongoing-retry): retryFailedSyncs scheduled job — exponential backoff, dead-letter cap (#39)"
```

---

## Self-Review Checklist

**Spec coverage (§9 retry semantics + error-classification sections):**
- `MAX_SYNC_RETRIES = 5` cap: enforced via `resolveRetryOutcome` (consumed, not redefined). ✓
- `error_class: "retryable"` filter — only retryable rows swept. ✓
- Dead-letter by flipping `error_class → "terminal"` (no new column, no migration). ✓
- `retry_count` incremented and persisted before re-invoke. ✓
- Exponential backoff with 5-min base, 2x factor, 60-min cap. ✓
- Due-check via `last_synced_at` (no `next_retry_at` column needed). ✓
- Re-invoke via `pushOrderToOngoing` (idempotent PUT upsert covers both initial-push and edit-sync failures). ✓
- Two retry layers distinguished in plan rationale and Global Constraints. ✓
- Per-row `try/catch`; job never rethrows. ✓
- Null `medusa_fulfillment_id` skip with warn (not dead-letter). ✓
- Plain Medusa scheduled job (not `createWorkflow`), rationale stated. ✓
- `classifyError` / `error_class` already stamped on rows by `pushOrderRecordSyncStep` and `upsertOngoingOrderEditStep` — consumed here, not redefined. ✓

**Type consistency:**
- `ErrorSyncRow` fields match `OngoingOrderSync` model (`src/modules/ongoing/models/order-sync.ts`): `id`, `medusa_fulfillment_id`, `last_synced_at`, `retry_count`, `error_class`. ✓
- `updateOngoingOrderSyncs` call shape matches MedusaService auto-CRUD (single-object patch: `{ id, ...fields }`). ✓
- `pushOrderToOngoing(container).run({ input: { fulfillment_id: string } })` matches `PushOrderToOngoingInput` (`src/workflows/push-order-to-ongoing.ts:8`). ✓
- `resolveRetryOutcome({ retry_count, error_class })` matches `RetryPolicyInput` (`src/lib/ongoing/retry-policy.ts:17`). ✓
- `computeRetryBackoffMs(retryCount)` is exported from `src/lib/ongoing/retry-policy.ts` by Task 1 before Task 2 consumes it. ✓

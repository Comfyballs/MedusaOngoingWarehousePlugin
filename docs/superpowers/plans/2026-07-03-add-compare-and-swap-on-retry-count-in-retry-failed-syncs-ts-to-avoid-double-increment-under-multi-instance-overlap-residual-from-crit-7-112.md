# Compare-and-Swap on `retry_count` in `retry-failed-syncs.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the residual race from issue #39 (CRIT-7 refutation): two overlapping ticks of `retryFailedSyncsJob` (multi-instance deployment, or a slow prior tick still in flight past the next minute boundary) can both list the same due `OngoingOrderSync` row and both write `retry_count`, because the current write is a plain read-then-write (`updateOngoingOrderSyncs`) with no guard. Replace it with a single atomic, WHERE-guarded native update so only one overlapping tick's write can land.

**Architecture:** Add one new guarded write method, `OngoingModuleService.attemptRetrySyncTransition`, that drops below Medusa's auto-CRUD `updateOngoingOrderSyncs` (which is read-then-write via Mikro-ORM's `manager.assign()+persist()` — confirmed by reading `@medusajs/utils`'s `MikroOrmBaseRepository.update()` and `MedusaInternalService.update()`, neither of which supports a WHERE guard) to a direct `EntityManager.nativeUpdate(entityName, where, data)` call scoped to `{ id, sync_state: "error", retry_count: expected }`. `retry-failed-syncs.ts`'s `processRow` calls this once per row instead of `updateOngoingOrderSyncs`; a `false` return ("CAS lost" — zero rows matched) means another tick already processed the row, and the caller skips it silently (info-level log only, no re-invoke, no event emit). This requires enabling TypeScript legacy decorators (`@InjectManager()` / `@MedusaContext()`, the standard Medusa pattern for custom raw-DB service methods) in the `@swc/jest` test transform, which this codebase has never used before — a repo-root `.swcrc` is the fix (see Task 1 Step 1; verified empirically, see below).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `@medusajs/utils`), TypeScript 5.6 (Node16 module resolution, `experimentalDecorators: true` already set in `tsconfig.json`), Mikro-ORM (bundled via `@medusajs/utils`'s `@medusajs/deps/mikro-orm/core`), yarn 4.6, Jest + `@swc/jest`.

## Global Constraints

- Medusa version floor: **2.16.0**. Node **>= 20** for `yarn dev`; **`yarn build` and `yarn lint` crash on Node 26** (`SlowBuffer` removed) — run them under Node 20/22 via `nvm use 22`. `yarn test` (`@swc/jest`) is unaffected by the Node 26 issue and was verified to pass under both Node 22 and Node 26 during plan research.
- Module id is `"ongoing"` (string literal); the module service class is `OngoingModuleService` (`src/modules/ongoing/service.ts`), extending `MedusaService({ OngoingIntegration, OngoingOrderSync })`.
- The Mikro-ORM entity class name for the `OngoingOrderSync` DML model (`model.define("ongoing_order_sync", {...})`, `src/modules/ongoing/models/order-sync.ts`) is **`"OngoingOrderSync"`** — confirmed by reading `@medusajs/utils`'s `parseEntityName()` (`dist/dml/helpers/entity-builder/parse-entity-name.js:25`): `modelName = upperCaseFirst(toCamelCase("ongoing_order_sync"))` → `"OngoingOrderSync"`. This is the literal string to pass as `entityName` to `manager.nativeUpdate(...)`.
- **Chosen mechanism: compare-and-swap (CAS) on `retry_count`, not a per-row lock.** Rationale:
  - No schema change. `OngoingIntegration.sync_lock_until` (used by `acquireSyncLock`/`releaseSyncLock`, `src/modules/ongoing/service.ts:104-121`) exists only on the *integration* row; a per-row lock would need a new nullable `lock_until` column (+ migration) on `OngoingOrderSync`, plus TTL-expiry handling, plus a release-on-finally that itself isn't atomic against a second acquire (the existing `acquireSyncLock` is explicitly documented as "read-then-write is fine for a single-instance cron" — i.e. it is *not* itself race-free; copying that pattern to a new per-row lock would import the same class of race the per-row-column approach exists to fix into a new column).
  - The #39 plan explicitly opted out of the sibling-job `acquireSyncLock`/`releaseSyncLock` pattern for `retry-failed-syncs.ts` (see `docs/superpowers/plans/2026-06-30-retryfailedsyncs-workflow-39.md` and the CRIT-7 refutation this issue is a residual of) — reintroducing a lock (even a narrower per-row one) for this fix would partially reverse that decision for no schema-free benefit.
  - A single guarded `UPDATE ... WHERE id = ? AND sync_state = 'error' AND retry_count = ?` is one DB round-trip, enforced by Postgres itself (row-level `UPDATE` visibility/locking), not by application-level read-then-write — it cannot itself race.
- The guard also naturally covers the row-cancelled-between-listing-and-updating case for free: the `WHERE` clause requires `sync_state = 'error'`, so if the row transitioned out of `error` (e.g. cancelled) between listing and this call, the guarded update matches zero rows exactly like a `retry_count` mismatch — same "CAS lost" return value, same skip path. The job cannot (and does not need to) distinguish *why* the guard failed.
- CAS-lost is a **skip, not a failure**: log at `info` level (not `warn`/`error`) with a distinct, greppable message. It is an expected, correct outcome under multi-instance overlap — the tick that won the CAS already persisted the row's next state and (for the re-invoke branch) already re-triggered `pushOrderToOngoing`; re-processing would double-increment `retry_count` and double the Ongoing API calls, which is exactly the bug this guard exists to prevent.
- Backoff computation (`computeRetryBackoffMs`, `src/lib/ongoing/retry-policy.ts:107-114`) is unaffected by this change: it only reads `row.retry_count` and `row.last_synced_at` from the **listed** snapshot to decide whether a row is due *before* attempting the guarded write. On CAS success, the write already stamps `last_synced_at` as before (unchanged 2-crash-safety-properties rationale, `src/jobs/retry-failed-syncs.ts:109-123`, preserved verbatim). On CAS-lost, no write happens on this tick at all — the winning tick's write is what advances the backoff anchor.
- Test harness is **pure unit tests only** (mocked service methods, no local Postgres or Medusa instance — same convention as `src/jobs/__tests__/retry-failed-syncs.test.ts` and `src/modules/ongoing/__tests__/sync-lock.test.ts`). There is no way in this harness to run two real concurrent DB transactions, so "two overlapping ticks" is simulated by mocking `attemptRetrySyncTransition` to resolve `false` (as if a concurrent `nativeUpdate` from another tick had already consumed the guard) — this exercises exactly the branch the real guard protects, without needing a live database.
- Plugin build output is `.medusa/server`; verify the plugin compiles with `yarn build` (run under Node 22).

---

## File Structure

**Create:**
- `.swcrc` (repo root) — enables TypeScript legacy-decorator parsing in the `@swc/jest` test transform (`jest.config.js`'s `transform: {"^.+\\.(t|j)s$": ["@swc/jest"]}` has no inline options, so `@swc/jest` falls back to reading `.swcrc` from `process.cwd()` — confirmed by reading `@swc/jest`'s `buildSwcTransformOpts()`/`getOptionsFromSwrc()`). Without this, any file using `@InjectManager()`/`@MedusaContext()` decorator syntax fails to compile under `yarn test` with `Unexpected token '@'` (reproduced during plan research). `yarn build` (`medusa plugin:build`) does **not** need this — it already compiles with `tsc`, which honors `tsconfig.json`'s existing `experimentalDecorators: true` (verified during plan research: `yarn build` succeeded with a decorator-using scratch file present even before `.swcrc` existed).
- `src/modules/ongoing/__tests__/retry-transition.test.ts` — unit tests for `OngoingModuleService.attemptRetrySyncTransition`.

**Modify:**
- `src/modules/ongoing/service.ts` — add exported type `RetrySyncTransitionInput` and method `attemptRetrySyncTransition` to `OngoingModuleService` (after `releaseSyncLock`, end of class body, line 121).
- `src/jobs/retry-failed-syncs.ts` — `processRow` (lines 60-154) calls `service.attemptRetrySyncTransition(...)` instead of `service.updateOngoingOrderSyncs(...)`; `OngoingServiceLike` type (lines 26-37) updated to match.
- `src/jobs/__tests__/retry-failed-syncs.test.ts` — harness's `service` mock exposes `attemptRetrySyncTransition` instead of `updateOngoingOrderSyncs`; existing assertions updated; new CAS-lost test cases added.
- `src/lib/ongoing/retry-policy.ts` — update the `resolveRetryOutcome` doc comment's "Consumption contract for #39" section (lines 52-59), which currently documents the plain `updateOngoingOrderSyncs` two-branch pattern this plan replaces.

**Depends on (must already exist — do not redefine):**
- `src/modules/ongoing/models/order-sync.ts` — default-exports the `OngoingOrderSync` DML model (exists, `model.define("ongoing_order_sync", {...})`).
- `src/lib/ongoing/retry-policy.ts` — exports `resolveRetryOutcome`, `RetryOutcome = { retry_count: number; error_class: "retryable" | "terminal"; dead_lettered: boolean }` (exists, lines 27-31, 65-92).
- `src/jobs/retry-failed-syncs.ts` — existing `isRetryDue`, `processRow`, `retryFailedSyncsJob`, `config`, `ErrorSyncRow` type, imports of `ONGOING_EVENTS`, `OrderRetriedPayload`, `OrderDeadLetteredPayload` from `../lib/ongoing/events` (all exist, from #39/#94/#103).
- `@medusajs/framework/utils` — exports `InjectManager`, `MedusaContext` (verified: `node -e "console.log(typeof require('@medusajs/framework/utils').InjectManager)"` → `"function"`).
- `@medusajs/framework/types` — exports `Context<TManager = unknown>` (verified: `@medusajs/types/dist/shared-context.d.ts:24`, re-exported via `@medusajs/framework/types`'s `export * from "@medusajs/types"`).

---

## Task 1: `OngoingModuleService.attemptRetrySyncTransition` — guarded native update

Add the CAS-guarded write to the module service, enabling decorator support in the test toolchain first (a one-time prerequisite fix, not itself a business-logic change, so it is not test-driven — verified by re-running the existing suite).

**Files:**
- Create: `.swcrc`
- Modify: `src/modules/ongoing/service.ts`
- Create: `src/modules/ongoing/__tests__/retry-transition.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `OngoingModuleService.attemptRetrySyncTransition(input: RetrySyncTransitionInput, sharedContext?: Context): Promise<boolean>`, exported type `RetrySyncTransitionInput = { id: string; expected_retry_count: number; retry_count: number; last_synced_at: Date; error_class?: "terminal" }`, both from `src/modules/ongoing/service.ts`. Consumed by Task 2.

- [ ] **Step 1: Add `.swcrc` and verify it doesn't regress the existing suite**

Create `.swcrc` at the repo root:

```json
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "target": "es2021",
    "keepClassNames": true
  },
  "module": {
    "type": "commonjs"
  }
}
```

Run the full existing suite to confirm this is a no-op for current tests (no decorator syntax exists in `src/` yet, so this only changes how the parser is configured, not what it accepts beyond decorators):

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
```

Expected: all existing tests still pass (360 tests across 66 suites as of this plan; exact count will drift as the codebase grows — the point is zero new failures).

- [ ] **Step 2: Write the failing tests for `attemptRetrySyncTransition`**

Create `src/modules/ongoing/__tests__/retry-transition.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/modules/ongoing/__tests__/retry-transition.test.ts
```

Expected: FAIL — `svc.attemptRetrySyncTransition is not a function` (the method does not exist yet).

- [ ] **Step 4: Implement `attemptRetrySyncTransition`**

Read the current file first:

```bash
cat /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/src/modules/ongoing/service.ts
```

Change the import block at the top of `src/modules/ongoing/service.ts` from:

```ts
import { MedusaError, MedusaService } from "@medusajs/framework/utils"
import OngoingIntegration from "./models/integration"
import OngoingOrderSync from "./models/order-sync"
import { validateOngoingOptions } from "./options"
import { OngoingClient } from "../../lib/ongoing/client"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"
```

to:

```ts
import { InjectManager, MedusaContext, MedusaError, MedusaService } from "@medusajs/framework/utils"
import type { Context } from "@medusajs/framework/types"
import OngoingIntegration from "./models/integration"
import OngoingOrderSync from "./models/order-sync"
import { validateOngoingOptions } from "./options"
import { OngoingClient } from "../../lib/ongoing/client"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

export type RetrySyncTransitionInput = {
  id: string
  expected_retry_count: number
  retry_count: number
  last_synced_at: Date
  error_class?: "terminal"
}
```

Then, after `releaseSyncLock` (currently the last method, ending at line 121, just before the class's closing `}` on line 122), add:

```ts

  /**
   * Guarded write for the retry-sweep driver (`src/jobs/retry-failed-syncs.ts`).
   * Atomically transitions a row's `retry_count` (and, when dead-lettering,
   * `error_class`) only if the row still matches the exact state this call site
   * observed when it listed the row: `sync_state = "error" AND retry_count =
   * expected_retry_count`.
   *
   * Returns `true` when this call won the race and the write landed. Returns
   * `false` ("CAS lost") when zero rows matched — another overlapping tick
   * already advanced `retry_count` for this row (multi-instance deployment, or
   * a slow prior tick still in flight), or the row left the `error` state
   * between listing and this call (e.g. a concurrent cancellation). The caller
   * cannot distinguish which case fired and does not need to: both mean skip
   * without re-invoking the sync or emitting a retry/dead-letter event, since
   * whichever tick won the guard already did so.
   *
   * Bypasses the auto-CRUD `updateOngoingOrderSyncs` (read-then-write via
   * `manager.assign()+persist()` — last-write-wins, confirmed by reading
   * `@medusajs/utils`'s `MikroOrmBaseRepository.update()`) in favour of a single
   * native `UPDATE ... WHERE id = ? AND sync_state = 'error' AND retry_count = ?`
   * so the guard is enforced by the database in one round-trip, not by
   * application-level read-then-write.
   */
  @InjectManager()
  async attemptRetrySyncTransition(
    input: RetrySyncTransitionInput,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<boolean> {
    const manager = sharedContext.manager as {
      nativeUpdate: (
        entityName: string,
        where: Record<string, unknown>,
        data: Record<string, unknown>
      ) => Promise<number>
    }

    const data: Record<string, unknown> = {
      retry_count: input.retry_count,
      last_synced_at: input.last_synced_at,
    }
    if (input.error_class) {
      data.error_class = input.error_class
    }

    const affectedRows = await manager.nativeUpdate(
      "OngoingOrderSync",
      {
        id: input.id,
        sync_state: "error",
        retry_count: input.expected_retry_count,
      },
      data
    )

    return affectedRows === 1
  }
```

- [ ] **Step 5: Run the new tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/modules/ongoing/__tests__/retry-transition.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 6: Run the full suite, lint, and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
nvm use 22 && yarn lint && yarn build
```

Expected: full test suite passes with zero failures; `yarn lint` reports 0 errors (pre-existing warnings in unrelated files are fine — do not fix them here); `yarn build` completes and writes `.medusa/server`.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add .swcrc src/modules/ongoing/service.ts src/modules/ongoing/__tests__/retry-transition.test.ts && git commit -m "feat(ongoing): add attemptRetrySyncTransition CAS-guarded update (#112)"
```

---

## Task 2: Wire the CAS guard into `retryFailedSyncsJob`

Replace `processRow`'s plain `updateOngoingOrderSyncs` write with the guarded `attemptRetrySyncTransition`, add the CAS-lost skip branch, and update the job's tests and the `resolveRetryOutcome` doc comment to match.

**Files:**
- Modify: `src/jobs/retry-failed-syncs.ts`
- Modify: `src/jobs/__tests__/retry-failed-syncs.test.ts`
- Modify: `src/lib/ongoing/retry-policy.ts`

**Interfaces:**
- Consumes from Task 1: `OngoingModuleService.attemptRetrySyncTransition(input: RetrySyncTransitionInput, sharedContext?: Context): Promise<boolean>` (only the call shape is used here; the job's local `OngoingServiceLike` type mirrors it structurally, matching the existing pattern where the job never imports the concrete service class).
- Consumes from existing code: `resolveRetryOutcome`, `ONGOING_EVENTS`, `OrderRetriedPayload`, `OrderDeadLetteredPayload` (all exist, unchanged).
- Produces: nothing new consumed by later tasks (this is the last task).

- [ ] **Step 1: Update the failing/changed tests in `retry-failed-syncs.test.ts`**

Read the current file first:

```bash
cat /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/src/jobs/__tests__/retry-failed-syncs.test.ts
```

Replace the entire contents of `src/jobs/__tests__/retry-failed-syncs.test.ts` with:

```ts
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

  it("skips a row with null medusa_fulfillment_id and logs a warning — does not dead-letter", async () => {
    const r = row({ medusa_fulfillment_id: null })
    const h = makeHarness({ rows: [r] })

    await retryFailedSyncsJob(h.container)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("sync_1"))
    expect(h.service.attemptRetrySyncTransition).not.toHaveBeenCalled()
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
```

- [ ] **Step 2: Run to verify the CAS-related tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/jobs/__tests__/retry-failed-syncs.test.ts
```

Expected: FAIL — the harness's `service` mock now exposes `attemptRetrySyncTransition`, but `processRow` in `src/jobs/retry-failed-syncs.ts` still calls `service.updateOngoingOrderSyncs`, which is `undefined` on the mock. Tests asserting `attemptRetrySyncTransition` was called fail with "0 calls"; the "skips a row with null medusa_fulfillment_id" and "skips a row whose backoff window has not yet elapsed" tests still pass (they never reach the write). The re-invoke/dead-letter/CAS-lost tests fail.

- [ ] **Step 3: Update `processRow` and `OngoingServiceLike` in `retry-failed-syncs.ts`**

Read the current file first:

```bash
cat /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/src/jobs/retry-failed-syncs.ts
```

Replace the `OngoingServiceLike` type (currently lines 26-37):

```ts
type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: string
    error_class: string
  }) => Promise<ErrorSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    retry_count: number
    last_synced_at?: Date
    error_class?: "terminal"
  }) => Promise<unknown>
}
```

with:

```ts
type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    sync_state: string
    error_class: string
  }) => Promise<ErrorSyncRow[]>
  attemptRetrySyncTransition: (input: {
    id: string
    expected_retry_count: number
    retry_count: number
    last_synced_at: Date
    error_class?: "terminal"
  }) => Promise<boolean>
}
```

Replace the entire `processRow` function (currently lines 60-154) with:

```ts
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
  const eventBus = (container as any).resolve(Modules.EVENT_BUS)

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

  // Guarded write: only succeeds if `id` still has `sync_state = "error" AND
  // retry_count = row.retry_count` — i.e. nothing else has touched this row
  // since it was listed at the top of the sweep. This closes the residual
  // race from #39: two overlapping ticks (multi-instance deployment, or a
  // slow prior tick still in flight past the next minute boundary) can both
  // list the same due row, but only one of them can win this guarded update.
  const won = await service.attemptRetrySyncTransition({
    id: row.id,
    expected_retry_count: row.retry_count,
    retry_count: outcome.retry_count,
    last_synced_at: new Date(),
    ...(outcome.dead_lettered ? { error_class: "terminal" as const } : {}),
  })

  if (!won) {
    // CAS lost: another tick already advanced this row's retry_count (or the
    // row left `sync_state = "error"` between listing and this call, e.g. a
    // concurrent cancellation). Skipping is correct — the tick/actor that won
    // already persisted the outcome and, for the re-invoke branch, already
    // re-triggered `pushOrderToOngoing`. Re-processing here would double the
    // retry_count and double the Ongoing API calls, which is exactly the bug
    // this guard exists to prevent. Logged at info (not warn/error): this is
    // an expected outcome under multi-instance overlap, not a failure.
    logger.info(
      `[ongoing] retry: row ${row.id} lost the retry_count CAS guard (expected retry_count=${row.retry_count}, sync_state="error") — another tick already processed it; skipping`
    )
    return
  }

  if (outcome.dead_lettered) {
    logger.info(
      `[ongoing] retry: dead-lettered row ${row.id} after ${outcome.retry_count} attempts`
    )
    // Best-effort emit: the dead-letter write above already committed — an
    // event-bus outage here must not surface as a "row failed" log for a row
    // that was actually processed successfully.
    try {
      await eventBus.emit({
        name: ONGOING_EVENTS.ORDER_DEAD_LETTERED,
        data: {
          ongoing_order_sync_id: row.id,
          medusa_fulfillment_id: row.medusa_fulfillment_id,
          retry_count: outcome.retry_count,
        } satisfies OrderDeadLetteredPayload,
      })
    } catch (emitErr) {
      logger.error(
        `[ongoing] retry: failed to emit ${ONGOING_EVENTS.ORDER_DEAD_LETTERED} for row ${row.id}: ${(emitErr as Error).message}`
      )
    }
    return
  }

  await pushOrderToOngoing(container).run({
    input: { fulfillment_id: row.medusa_fulfillment_id },
  })

  logger.info(
    `[ongoing] retry: re-invoked push for row ${row.id} (attempt ${outcome.retry_count})`
  )
  // Best-effort emit: the re-invocation above already ran to completion — an
  // event-bus outage here must not surface as a "row failed" log for a row
  // that was actually processed successfully.
  try {
    await eventBus.emit({
      name: ONGOING_EVENTS.ORDER_RETRIED,
      data: {
        ongoing_order_sync_id: row.id,
        medusa_fulfillment_id: row.medusa_fulfillment_id,
        retry_count: outcome.retry_count,
      } satisfies OrderRetriedPayload,
    })
  } catch (emitErr) {
    logger.error(
      `[ongoing] retry: failed to emit ${ONGOING_EVENTS.ORDER_RETRIED} for row ${row.id}: ${(emitErr as Error).message}`
    )
  }
}
```

No other part of `src/jobs/retry-failed-syncs.ts` changes — `isRetryDue`, `retryFailedSyncsJob`, `config`, `ErrorSyncRow`, `Logger`, and all imports stay exactly as they are.

- [ ] **Step 4: Update the `resolveRetryOutcome` doc comment in `retry-policy.ts`**

Read the current file first:

```bash
cat /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/src/lib/ongoing/retry-policy.ts
```

In the `resolveRetryOutcome` doc comment, replace the "Consumption contract for #39" block (currently lines 52-59):

```ts
 * Consumption contract for #39 (`retryFailedSyncs`):
 * 1. Query rows with `sync_state = "error" AND error_class = "retryable"`.
 * 2. For each, before re-invoking, call
 *    `resolveRetryOutcome({ retry_count: row.retry_count, error_class: row.error_class })`.
 * 3. If `outcome.dead_lettered`: do NOT re-invoke; persist via
 *    `updateOngoingOrderSyncs({ id, retry_count: outcome.retry_count, error_class: "terminal" })`.
 * 4. Else: persist `updateOngoingOrderSyncs({ id, retry_count: outcome.retry_count })`,
 *    then re-invoke the sync.
```

with:

```ts
 * Consumption contract for #39/#112 (`retryFailedSyncs`):
 * 1. Query rows with `sync_state = "error" AND error_class = "retryable"`.
 * 2. For each, before re-invoking, call
 *    `resolveRetryOutcome({ retry_count: row.retry_count, error_class: row.error_class })`.
 * 3. Persist the outcome via the CAS-guarded
 *    `attemptRetrySyncTransition({ id, expected_retry_count: row.retry_count, retry_count:
 *    outcome.retry_count, last_synced_at, error_class: outcome.dead_lettered ? "terminal" :
 *    undefined })` (`src/modules/ongoing/service.ts`) instead of the plain, unguarded
 *    `updateOngoingOrderSyncs` — this prevents two overlapping ticks from double-incrementing
 *    the same row's `retry_count` (#112).
 * 4. If the guarded write returns `false` ("CAS lost" — another tick already processed this
 *    row), skip it: do not re-invoke, do not emit an event.
 * 5. Else if `outcome.dead_lettered`: do NOT re-invoke.
 * 6. Else: re-invoke the sync.
```

- [ ] **Step 5: Run the job's tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/jobs/__tests__/retry-failed-syncs.test.ts
```

Expected: all 15 tests pass.

- [ ] **Step 6: Run the full suite, lint, and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
nvm use 22 && yarn lint && yarn build
```

Expected: full test suite passes with zero failures; `yarn lint` reports 0 errors; `yarn build` completes and writes `.medusa/server`.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/jobs/retry-failed-syncs.ts src/jobs/__tests__/retry-failed-syncs.test.ts src/lib/ongoing/retry-policy.ts && git commit -m "fix(ongoing): CAS-guard retry_count writes in retry-failed-syncs to prevent double-increment under multi-instance overlap (#112)"
```

---

## Self-Review Checklist

**Issue coverage:**
- Chosen mechanism (CAS vs per-row lock) with justification: documented in Global Constraints, cross-referencing #39's rationale without restating it. ✓
- SQL/Mikro-ORM shape of the guarded update: `manager.nativeUpdate("OngoingOrderSync", { id, sync_state: "error", retry_count: expected }, { retry_count: next, last_synced_at, error_class? })`, Task 1 Step 4. ✓
- "Someone else got there first" branch: skip silently, logged at `info` (not `warn`/`error`) with a distinct greppable message — Task 2 Step 3, `processRow`'s `if (!won)` branch. ✓
- Impact on backoff computation: documented in Global Constraints — no change on CAS success (unchanged stamping of `last_synced_at`); no work at all on CAS-lost (the winning tick already advanced the anchor). ✓
- Test cases: single-tick due row increments once (Task 2 "re-invokes pushOrderToOngoing for a single due retryable row..."); two overlapping ticks (Task 2 "skips a row when the CAS guard loses..." + Task 1's `attemptRetrySyncTransition` "returns false when...zero rows" test); row cancelled between listing and updating (Task 2 "skips a row that left the error state..." + Task 1's "returns false when the row left the error state..." test). ✓
- Integration test / two-tick simulation: no real-DB harness exists in this repo (unit tests only, no Postgres); documented in Global Constraints why the guarded-update mock returning `false` is the correct stand-in — it exercises exactly the branch the real `WHERE` guard protects. ✓

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate error handling" — every step shows exact code, exact file paths, exact commands with expected output. ✓

**Type consistency:**
- `RetrySyncTransitionInput` (Task 1, `src/modules/ongoing/service.ts`) matches the `OngoingServiceLike.attemptRetrySyncTransition` input shape (Task 2, `src/jobs/retry-failed-syncs.ts`) field-for-field: `id`, `expected_retry_count`, `retry_count`, `last_synced_at`, optional `error_class`. ✓
- `attemptRetrySyncTransition` returns `Promise<boolean>` in both the service (Task 1) and the job's local type (Task 2); `processRow`'s `won` variable and the `if (!won)` branch match. ✓
- `manager.nativeUpdate` call shape (`entityName: "OngoingOrderSync"`, `where`, `data`) is identical between the Task 1 implementation and the Task 1 test assertions. ✓

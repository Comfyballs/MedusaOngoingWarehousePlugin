# Stock-Sync Dispatcher Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a once-a-minute Medusa scheduled job that, per enabled+stock-sync-enabled Ongoing integration on its own `stock_sync_interval`, acquires the shared `sync_lock_until` advisory lock and dispatches `syncOngoingInventoryWorkflow` (#37), stamping `last_stock_sync_at` and releasing the lock in a `finally` regardless of workflow outcome.

**Architecture:** One job file `src/jobs/stock-sync.ts` exporting a default dispatcher `ongoingStockSyncJob(container)` plus a `config` (`{ name: "ongoing-stock-sync", schedule: "* * * * *" }`). The job runs every minute and acts as its own cadence gate: for each integration filtered by `{ enabled: true, stock_sync_enabled: true }`, it computes whether the integration is *due* (`now - last_stock_sync_at >= interval`), attempts to acquire `sync_lock_until` (shared with the status-poll job — no second lock field), resolves `goods_owner_id` from plugin options via `service.getCredentials`, and calls `syncOngoingInventoryWorkflow(container).run({ input })`. One new pure-sync service method (`getDefaultStockSyncIntervalMs`) backs the per-integration interval fallback. **Never rethrows** — each integration is wrapped so one failure cannot abort the tick; lock always released in `finally`.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (`yarn test`).

## Global Constraints

- Medusa version floor: **2.16.0**. Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase); import the constant `ONGOING_MODULE` from `src/modules/ongoing/index.ts`.
- A scheduled job exports a default async `handler(container: MedusaContainer)` plus `export const config = { name, schedule }` (Medusa v2 jobs API; see `src/jobs/README.md`).
- The job mutates only the plugin's own `OngoingIntegration` rows (stamp `last_stock_sync_at`) and delegates inventory writes to `syncOngoingInventoryWorkflow` (#37). No cross-module service calls except through that workflow.
- `getDefaultStockSyncIntervalMs()` is a **pure sync** in-memory option reader — it carries `// eslint-disable-next-line @medusajs/service-methods-must-be-async`, same pattern as `getDefaultStatusPollIntervalMs` at `src/modules/ongoing/service.ts:82-85`.
- Hard-coded fallback default for `getDefaultStockSyncIntervalMs` when `defaultStockSyncInterval` is unset: **600000** (10 minutes).
- `defaultStockSyncInterval` option key already exists in `OngoingPluginOptions` at `src/lib/ongoing/types.ts:12` (`defaultStockSyncInterval?: string`).
- **Interval string format:** milliseconds as an integer string (e.g. `"600000"`); parse with `parseInt(v, 10)`.
- `sync_lock_until`, `last_stock_sync_at`, `stock_sync_enabled`, `stock_sync_interval`, `stock_location_id`, `stock_reconcile_mode` all already exist on the `ongoing_integration` model (`src/modules/ongoing/models/integration.ts`) and its migration (`Migration20260623211927.ts`). **NO new migration**.
- `acquireSyncLock` / `releaseSyncLock` already exist on `OngoingModuleService` (`src/modules/ongoing/service.ts:90-107`). Both are shared between the status-poll job and this job via the same `sync_lock_until` field — by design (spec §9 / §11).
- **Shared-lock TTL asymmetry (crash-recovery edge):** this job acquires `sync_lock_until` with `ttlMs = intervalMs` (default 600 000 ms / 10 min), whereas the status-poll job acquires the *same* field with its own ~60 s interval. In normal operation both release in `finally`, so the TTL never matters. But if the process crashes mid-stock-sync, the lock persists for up to 10 min and blocks status-poll for that integration until it expires (the reverse window is only ~60 s). This is an accepted consequence of the single-lock design, not a defect — noted so the implementer is not surprised by the asymmetric stale-lock windows.
- The job handler **never throws**: catch + log per integration so one warehouse's failure does not kill the tick. Lock always released in `finally`.
- **Build-time dependency:** `syncOngoingInventoryWorkflow` must be exported from `src/workflows/index.ts` (barrel) before this issue can compile — **#37 must land first**. Tests mock the barrel, so tests can be written and run before #37 merges, but `yarn build` will fail until then.
- Tests are **pure unit tests** (mock the module service and the workflow); no local Postgres/Medusa instance.
- Verify with `yarn lint`, `yarn test`, and `yarn build` (build gated on #37).

---

## File Structure

**Create:**
- `src/jobs/stock-sync.ts` — default `ongoingStockSyncJob` handler + `config`, plus private helpers `resolveStockSyncIntervalMs`, `isStockSyncDue`, `syncIntegration`.
- `src/jobs/__tests__/stock-sync.test.ts` — unit tests for the dispatcher (mocked service + workflow).

**Modify:**
- `src/modules/ongoing/service.ts` — add `getDefaultStockSyncIntervalMs()` after the existing `getDefaultStatusPollIntervalMs` (line 83).
- `src/modules/ongoing/__tests__/sync-lock.test.ts` — extend with a `getDefaultStockSyncIntervalMs` describe block.

**Depends on (must already exist):**
- `src/modules/ongoing/index.ts` — exports `ONGOING_MODULE = "ongoing"` (exists).
- `src/modules/ongoing/service.ts` — `OngoingModuleService` with auto-CRUD `listOngoingIntegrations`, `updateOngoingIntegrations`, `retrieveOngoingIntegration`; `getCredentials(key)` returning `{ goodsOwnerId: number; ... }`; `acquireSyncLock`, `releaseSyncLock` (all exist).
- `src/lib/ongoing/types.ts:10-14` — `OngoingPluginOptions` with `defaultStockSyncInterval?: string` (exists).
- `src/workflows/index.ts` (barrel) — **`syncOngoingInventoryWorkflow`** — **build-time dependency on #37**.

**Consumed interface from #37 (`syncOngoingInventoryWorkflow`) — call EXACTLY this:**
- Import: `import { syncOngoingInventoryWorkflow } from "../workflows"` (named export from barrel).
- Invocation: `syncOngoingInventoryWorkflow(container).run({ input: { integration_id: string; credential_key: string; stock_location_id: string; goods_owner_id: number; stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand" } })`.
- Returns `{ result: { written: number; skipped: number } }`. The dispatcher logs `result.written`/`result.skipped` at `info` level for operational visibility (this is why #37 returns the summary).
- Called **once per due, unlocked integration** per dispatcher tick.

---

## Task 1: Add `getDefaultStockSyncIntervalMs` to `OngoingModuleService`

Add the pure-sync option reader that mirrors `getDefaultStatusPollIntervalMs` but for stock-sync, with a 600 000 ms (10-minute) default.

**Files:**
- Modify: `src/modules/ongoing/service.ts` (after line 85)
- Modify: `src/modules/ongoing/__tests__/sync-lock.test.ts` (extend existing describe)

**Interfaces:**
- Consumes: `this.options_.defaultStockSyncInterval` (`OngoingPluginOptions.defaultStockSyncInterval?: string`).
- Produces: `OngoingModuleService.getDefaultStockSyncIntervalMs(): number` — called by the stock-sync dispatcher.

- [ ] **Step 1: Write the failing tests**

Open `src/modules/ongoing/__tests__/sync-lock.test.ts` and append a new `describe` block **inside** the outer `describe("OngoingModuleService sync lock + default interval", ...)` block, after the existing `releaseSyncLock` describe:

```typescript
  describe("getDefaultStockSyncIntervalMs", () => {
    it("parses the configured interval string into a number of ms", () => {
      const svc = makeService({ defaultStockSyncInterval: "300000" })
      expect(svc.getDefaultStockSyncIntervalMs()).toBe(300000)
    })

    it("falls back to 600000 when no default interval is configured", () => {
      const svc = makeService()
      expect(svc.getDefaultStockSyncIntervalMs()).toBe(600000)
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
yarn test src/modules/ongoing/__tests__/sync-lock.test.ts
```

Expected: FAIL — `TypeError: svc.getDefaultStockSyncIntervalMs is not a function`.

- [ ] **Step 3: Implement `getDefaultStockSyncIntervalMs` in the service**

In `src/modules/ongoing/service.ts`, add the new method immediately after `getDefaultStatusPollIntervalMs` (after line 85):

```typescript
  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getDefaultStatusPollIntervalMs above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStockSyncIntervalMs(): number {
    return parseInt(this.options_.defaultStockSyncInterval ?? "600000", 10)
  }
```

The two methods together in the file (lines 80-93 approximately):

```typescript
  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getCredentials/getClient above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStatusPollIntervalMs(): number {
    return parseInt(this.options_.defaultStatusPollInterval ?? "60000", 10)
  }

  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getDefaultStatusPollIntervalMs above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStockSyncIntervalMs(): number {
    return parseInt(this.options_.defaultStockSyncInterval ?? "600000", 10)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
yarn test src/modules/ongoing/__tests__/sync-lock.test.ts
```

Expected: All tests in the file PASS (including the pre-existing `getDefaultStatusPollIntervalMs`, `acquireSyncLock`, and `releaseSyncLock` suites).

- [ ] **Step 5: Lint**

```bash
yarn lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ongoing/service.ts src/modules/ongoing/__tests__/sync-lock.test.ts
git commit -m "feat(ongoing-service): add getDefaultStockSyncIntervalMs (600 000 ms default) (#38)"
```

---

## Task 2: Stock-sync dispatcher job + tests

Create the Medusa scheduled job that dispatches `syncOngoingInventoryWorkflow` for each due, unlocked, stock-sync-enabled integration.

**Files:**
- Create: `src/jobs/__tests__/stock-sync.test.ts`
- Create: `src/jobs/stock-sync.ts`

**Interfaces:**
- Consumes:
  - `ONGOING_MODULE` from `src/modules/ongoing/index.ts`
  - `OngoingModuleService.getDefaultStockSyncIntervalMs(): number` (Task 1)
  - `OngoingModuleService.listOngoingIntegrations({ enabled: boolean; stock_sync_enabled: boolean }): Promise<IntegrationRow[]>`
  - `OngoingModuleService.getCredentials(credentialKey: string): { goodsOwnerId: number }`
  - `OngoingModuleService.acquireSyncLock(id: string, ttlMs: number): Promise<boolean>`
  - `OngoingModuleService.releaseSyncLock(id: string): Promise<void>`
  - `OngoingModuleService.updateOngoingIntegrations({ id: string; last_stock_sync_at: Date }): Promise<unknown>`
  - `syncOngoingInventoryWorkflow` from `src/workflows/index.ts` (barrel — #37 dependency)
- Produces:
  - Default export: `ongoingStockSyncJob(container: MedusaContainer): Promise<void>`
  - Named export: `config = { name: "ongoing-stock-sync", schedule: "* * * * *" }`

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/__tests__/stock-sync.test.ts`:

```typescript
import type { MedusaContainer } from "@medusajs/framework/types"

// Mock the #37 workflow barrel: named export is a factory (container) => { run }.
// run() resolves to { result: { written, skipped } } — the shape #37 returns and the
// dispatcher logs. Keep the summary populated so the `logger.info` call site type-checks
// and can be asserted.
const run = jest.fn().mockResolvedValue({ result: { written: 0, skipped: 0 } })
jest.mock("../../workflows", () => ({
  __esModule: true,
  syncOngoingInventoryWorkflow: jest.fn(() => ({ run })),
}))

import ongoingStockSyncJob, { config } from "../stock-sync"

type Integration = {
  id: string
  credential_key: string
  stock_location_id: string
  stock_sync_interval: string | null
  last_stock_sync_at: Date | null
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

function makeHarness(opts: {
  integrations: Integration[]
  acquireImpl?: (id: string, ttlMs: number) => Promise<boolean>
  defaultIntervalMs?: number
  goodsOwnerIdByKey?: Record<string, number>
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const service = {
    listOngoingIntegrations: jest.fn(async () => opts.integrations),
    getCredentials: jest.fn((key: string) => ({
      goodsOwnerId: opts.goodsOwnerIdByKey?.[key] ?? 1,
    })),
    getDefaultStockSyncIntervalMs: jest.fn(() => opts.defaultIntervalMs ?? 600000),
    acquireSyncLock: jest.fn(opts.acquireImpl ?? (async () => true)),
    releaseSyncLock: jest.fn(async () => undefined),
    updateOngoingIntegrations: jest.fn(async () => ({})),
  }

  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  } as unknown as MedusaContainer

  return { container, service, logger }
}

const integ = (over: Partial<Integration> = {}): Integration => ({
  id: "int_1",
  credential_key: "wh-a",
  stock_location_id: "sloc_1",
  stock_sync_interval: "600000",
  last_stock_sync_at: null,
  stock_reconcile_mode: "sellable_plus_reserved",
  ...over,
})

describe("ongoing stock-sync job", () => {
  it("registers the dispatcher to run once a minute", () => {
    expect(config).toEqual({ name: "ongoing-stock-sync", schedule: "* * * * *" })
  })

  it("filters integrations by enabled AND stock_sync_enabled", async () => {
    const h = makeHarness({ integrations: [] })

    await ongoingStockSyncJob(h.container)

    expect(h.service.listOngoingIntegrations).toHaveBeenCalledWith({
      enabled: true,
      stock_sync_enabled: true,
    })
  })

  it("skips a locked integration without dispatching or releasing", async () => {
    const h = makeHarness({
      integrations: [integ()],
      acquireImpl: async () => false,
    })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 600000)
    expect(run).not.toHaveBeenCalled()
    expect(h.service.releaseSyncLock).not.toHaveBeenCalled()
  })

  it("skips an integration that is not yet due", async () => {
    const notDue = integ({
      stock_sync_interval: "600000",
      last_stock_sync_at: new Date(Date.now() - 1000),
    })
    const h = makeHarness({ integrations: [notDue] })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("dispatches syncOngoingInventoryWorkflow with the correct input for a due integration", async () => {
    const due = integ({ last_stock_sync_at: new Date(Date.now() - 700000) })
    const h = makeHarness({
      integrations: [due],
      goodsOwnerIdByKey: { "wh-a": 42 },
    })

    await ongoingStockSyncJob(h.container)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        integration_id: "int_1",
        credential_key: "wh-a",
        stock_location_id: "sloc_1",
        goods_owner_id: 42,
        stock_reconcile_mode: "sellable_plus_reserved",
      },
    })
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_stock_sync_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
  })

  it("uses the default interval when stock_sync_interval is null", async () => {
    const due = integ({
      stock_sync_interval: null,
      last_stock_sync_at: new Date(Date.now() - 700000),
    })
    const h = makeHarness({ integrations: [due], defaultIntervalMs: 600000 })

    await ongoingStockSyncJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 600000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("stamps last_stock_sync_at and releases the lock even when the workflow throws", async () => {
    const due = integ({ last_stock_sync_at: new Date(Date.now() - 700000) })
    const h = makeHarness({ integrations: [due] })
    run.mockRejectedValueOnce(new Error("sync failed"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_stock_sync_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
    expect(h.logger.error).toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("never throws and does no work when listing integrations fails", async () => {
    const h = makeHarness({ integrations: [] })
    ;(h.service.listOngoingIntegrations as jest.Mock).mockRejectedValue(new Error("db down"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
  })

  it("does not let one integration failure stop the others", async () => {
    const a = integ({ id: "int_a", credential_key: "wh-a", stock_location_id: "sloc_1" })
    const b = integ({ id: "int_b", credential_key: "wh-b", stock_location_id: "sloc_2" })
    const h = makeHarness({
      integrations: [a, b],
      goodsOwnerIdByKey: { "wh-a": 1, "wh-b": 2 },
    })
    run.mockRejectedValueOnce(new Error("boom"))

    await expect(ongoingStockSyncJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_b")
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ integration_id: "int_b", goods_owner_id: 2 }),
      })
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
yarn test src/jobs/__tests__/stock-sync.test.ts
```

Expected: FAIL — `Cannot find module '../stock-sync'`.

- [ ] **Step 3: Implement `src/jobs/stock-sync.ts`**

Create `src/jobs/stock-sync.ts`:

```typescript
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOngoingInventoryWorkflow } from "../workflows"

// Local structural types — no runtime import of the model class (mirrors status-poll.ts pattern).
type IntegrationRow = {
  id: string
  credential_key: string
  stock_location_id: string
  stock_sync_interval: string | null
  last_stock_sync_at: Date | string | null
  stock_reconcile_mode: "sellable_plus_reserved" | "precise" | "onhand"
}

type OngoingServiceLike = {
  listOngoingIntegrations: (filter: {
    enabled: boolean
    stock_sync_enabled: boolean
  }) => Promise<IntegrationRow[]>
  getCredentials: (credentialKey: string) => { goodsOwnerId: number }
  getDefaultStockSyncIntervalMs: () => number
  acquireSyncLock: (integrationId: string, ttlMs: number) => Promise<boolean>
  releaseSyncLock: (integrationId: string) => Promise<void>
  updateOngoingIntegrations: (data: {
    id: string
    last_stock_sync_at: Date
  }) => Promise<unknown>
}

type Logger = {
  info: (message: string) => void
  error: (message: string) => void
  debug?: (message: string) => void
}

function resolveStockSyncIntervalMs(
  service: OngoingServiceLike,
  integration: IntegrationRow
): number {
  if (integration.stock_sync_interval != null) {
    const parsed = parseInt(integration.stock_sync_interval, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return service.getDefaultStockSyncIntervalMs()
}

function isStockSyncDue(
  integration: IntegrationRow,
  intervalMs: number,
  now: number
): boolean {
  if (integration.last_stock_sync_at == null) {
    return true
  }
  const last = new Date(integration.last_stock_sync_at).getTime()
  return now - last >= intervalMs
}

async function syncIntegration(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  now: number
): Promise<void> {
  const intervalMs = resolveStockSyncIntervalMs(service, integration)
  if (!isStockSyncDue(integration, intervalMs, now)) {
    return
  }

  const acquired = await service.acquireSyncLock(integration.id, intervalMs)
  if (!acquired) {
    logger.debug?.(
      `[ongoing] stock-sync: integration ${integration.id} is locked by another run, skipping`
    )
    return
  }

  try {
    const { goodsOwnerId } = service.getCredentials(integration.credential_key)
    const { result } = await syncOngoingInventoryWorkflow(container).run({
      input: {
        integration_id: integration.id,
        credential_key: integration.credential_key,
        stock_location_id: integration.stock_location_id,
        goods_owner_id: goodsOwnerId,
        stock_reconcile_mode: integration.stock_reconcile_mode,
      },
    })
    // #37 returns { written, skipped } expressly for the dispatcher to log (operational visibility).
    logger.info(
      `[ongoing] stock-sync: integration ${integration.id} reconciled ${result.written} level(s), skipped ${result.skipped}`
    )
  } finally {
    try {
      await service.updateOngoingIntegrations({
        id: integration.id,
        last_stock_sync_at: new Date(),
      })
    } catch (error) {
      logger.error(
        `[ongoing] stock-sync: failed to stamp last_stock_sync_at for ${integration.id}: ${
          (error as Error).message
        }`
      )
    }
    await service.releaseSyncLock(integration.id)
  }
}

export default async function ongoingStockSyncJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let integrations: IntegrationRow[]
  try {
    integrations = await service.listOngoingIntegrations({
      enabled: true,
      stock_sync_enabled: true,
    })
  } catch (error) {
    logger.error(
      `[ongoing] stock-sync: failed to list integrations: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()
  for (const integration of integrations) {
    try {
      await syncIntegration(container, service, logger, integration, now)
    } catch (error) {
      logger.error(
        `[ongoing] stock-sync: integration ${integration.id} (${integration.credential_key}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one integration's failure must not kill the tick.
    }
  }
}

export const config = {
  name: "ongoing-stock-sync",
  schedule: "* * * * *",
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
yarn test src/jobs/__tests__/stock-sync.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Run the full test suite**

```bash
yarn test
```

Expected: All tests across `src/` PASS (no regressions in `status-poll`, `sync-lock`, `options`, `record-sync` suites).

- [ ] **Step 6: Lint**

```bash
yarn lint
```

Expected: no errors.

- [ ] **Step 7: Build (gated on #37)**

```bash
yarn build
```

Expected: **FAILS** until `syncOngoingInventoryWorkflow` is exported from `src/workflows/index.ts` by issue #37. Once #37 merges and the barrel export is present, re-run `yarn build` and confirm it succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/stock-sync.ts src/jobs/__tests__/stock-sync.test.ts
git commit -m "feat(ongoing-stock-sync): dispatcher job — per-integration interval, sync_lock_until lock (#38)"
```

---

## Self-Review

**Spec coverage (§9):**
- Dispatcher runs frequently and gates on `now - last_stock_sync_at` — covered (Task 2 `isStockSyncDue`).
- Acquires `sync_lock_until` — covered (`acquireSyncLock` in `syncIntegration`).
- Runs `syncOngoingInventory` (the workflow from #37) — covered (workflow dispatch in Task 2).
- Updates `last_stock_sync_at` and releases the lock — covered (`finally` block).
- Per-integration `stock_sync_interval` with plugin-level default (600 000 ms) — covered (`resolveStockSyncIntervalMs` + `getDefaultStockSyncIntervalMs`).
- `stock_sync_enabled` per-feature toggle — covered (filter `{ enabled: true, stock_sync_enabled: true }`).

**Blocked by #37:** noted in Global Constraints and Step 7. Tests pass without #37; build requires it.

**No placeholders:** all steps contain complete code.

**Type consistency:** `OngoingServiceLike.updateOngoingIntegrations` accepts `{ id: string; last_stock_sync_at: Date }` — matches the call site in the `finally` block. `syncOngoingInventoryWorkflow` input shape (`integration_id`, `credential_key`, `stock_location_id`, `goods_owner_id`, `stock_reconcile_mode`) matches the interface documented in the consumed-interface block and mirrors the issue description.

# Dashboard Page Implementation Plan (Issue #43)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin dashboard page at `/app/ongoing` (`src/admin/routes/ongoing/page.tsx`) showing failed/pending `OngoingOrderSync` rows across all orders with a selection-based bulk-retry action, plus a static per-integration connection-health panel. Backed by two new admin API routes (`GET /admin/ongoing/syncs`, `POST /admin/ongoing/syncs/retry`) and one new workflow (`retryOngoingSyncsWorkflow`) that performs the retry mutation.

**Spec:** `docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md` §10 ("Dashboard page — failed/pending syncs across all orders with bulk retry, plus per-integration connection health").

**Blocked-by #40:** The connection-health panel consumes `GET /admin/ongoing/integrations`, owned and implemented by #40. This plan does **not** create that route — see Task 5 and the "Consumes from #40" note in Global Constraints, which confirms the exact response contract against #40's own plan. `src/admin/lib/sdk.ts` is also owned by #40; this plan creates it **only if it does not already exist** by the time Task 5 runs (see Task 4), using #40's exact canonical content.

**Architecture:**

```
OngoingOrderSync (existing model, src/modules/ongoing/models/order-sync.ts)
  ↓ read by
GET /admin/ongoing/syncs           (src/api/admin/ongoing/syncs/route.ts)
  ↓ rendered in
DataTable on /app/ongoing           (src/admin/routes/ongoing/page.tsx)
  ↓ bulk-retry command (selected rows) calls
POST /admin/ongoing/syncs/retry     (src/api/admin/ongoing/syncs/retry/route.ts)
  ↓ executes
retryOngoingSyncsWorkflow           (src/workflows/retry-ongoing-syncs.ts)
  ↓ single step
retryOngoingSyncsStep               (src/workflows/steps/retry-ongoing-syncs.ts)
  ↓ resets last_synced_at=null on eligible rows, picked up next tick by
retryFailedSyncsJob                 (src/jobs/retry-failed-syncs.ts, issue #39 — not modified here)
```

`GET /admin/ongoing/integrations` (owned by #40, consumed read-only) feeds the connection-health panel, which derives `healthy | stale | disabled` **statically** from stored integration fields — no live "Test connection" call from the dashboard (that stays on #40's settings page).

`GET /admin/ongoing/syncs` also returns a `summary: Record<SyncState, number>` object — counts across **all 5** `sync_state` values (`pending|sent|shipped|cancelled|error`), not just the `error|sent|pending` rows in the paginated listing — computed by `computeSyncStateSummary` (`src/api/admin/ongoing/syncs/summary.ts`). This satisfies spec §11's "success/failure counters" requirement, which issue #44 (observability) explicitly defers to this issue rather than producing itself. The dashboard renders it as a summary strip above the syncs table (Task 5).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `@medusajs/admin-sdk`), `@medusajs/ui` 4.1.16, `@tanstack/react-query` **5.64.2** (verified via `node_modules/@tanstack/react-query/package.json` — this matters, see Global Constraints), TypeScript 5.6 (Node16 module resolution for the server; Vite/bundler resolution for `src/admin`), yarn 4.6, Jest + `@swc/jest`.

## Global Constraints

- Medusa version floor: **2.16.0**. Node **>= 20**, package manager **yarn 4.6.0**.
- Module id is `"ongoing"` (string literal); import the constant `ONGOING_MODULE` from `src/modules/ongoing/index.ts:5`.
- **Only GET/POST/DELETE HTTP methods** — both new routes comply (GET, POST).
- **Mutations must go through a workflow, never call the module service directly from a route** (`arch-workflow-required`, CRITICAL rule enforced by the mandatory Medusa-aware code review per `CLAUDE.md` — "mutations not wrapped in workflows"). This is a deliberate, minimal deviation from the stage-6 resolved research, which described the retry route calling `service.updateOngoingOrderSyncs({ id, last_synced_at: null })` directly. The business logic is unchanged — it just now lives inside `retryOngoingSyncsStep`'s handler instead of the route body, mirroring the existing `cancelOngoingOrderWorkflow` → `cancelOngoingOrderStep` precedent (`src/workflows/cancel-ongoing-order.ts:17`, `src/workflows/steps/cancel-ongoing-order.ts:33`, where the step's `createStep` name string equals the workflow's `createWorkflow` name string — confirmed safe, they are separate Medusa registries). "Do not duplicate retry logic" still holds: the step is the only place that resets `last_synced_at`.
- **GET route reads directly from `req.query`, no Zod validator/middleware.** This follows the resolved research literally (`parseInt(req.query.limit, 10)` with default 20, same for `offset` default 0) rather than adding `validateAndTransformQuery` + a new `src/api/middlewares.ts`. Reason: query validation is a "best practice", not a CRITICAL `arch-` rule (the `building-with-medusa` skill's own `reference/api-routes.md` documents a "Manual Query" pattern for exactly this case), and `src/api/middlewares.ts` is a single top-level file that **#40's integration CRUD routes will also need** — the issue's ownership map does not allocate it to either issue, so avoiding it here removes a real cross-branch merge point. Keeping the parsing inline also means the mandated pagination/filter unit test (Task 2) exercises the real logic, not a validator.
- **POST route also skips body-validation middleware for the same shared-file reason.** `sync_ids` shape is checked inline in the route handler with `MedusaError.Types.INVALID_DATA` (verified: `MedusaError.Types.INVALID_DATA === "invalid_data"` and thrown instances carry `.type` — `node_modules/@medusajs/utils/dist/common/errors.js:13,38`).
- **MedusaService auto-CRUD method names** (verified against `src/modules/ongoing/service.ts`, which already uses `listOngoingOrderSyncs`, `createOngoingOrderSyncs`, `updateOngoingOrderSyncs`): the model `ongoing_order_sync` (`src/modules/ongoing/models/order-sync.ts:3`) also exposes `listAndCountOngoingOrderSyncs(filters, config)` → `Promise<[rows, count]>`. Passing an array for a field (e.g. `sync_state: ["error","sent","pending"]`) is the `$in` shorthand, already relied on elsewhere in this codebase's filter usage.
- **`OngoingOrderSync` fields consumed** (from `src/modules/ongoing/models/order-sync.ts`): `id`, `ongoing_order_number` (unique), `medusa_order_id`, `sync_state` (`"pending"|"sent"|"shipped"|"cancelled"|"error"`), `error_class` (`"retryable"|"terminal"|null`), `retry_count` (number, default 0), `last_error` (text, nullable), `last_synced_at` (dateTime, nullable).
- **`OngoingIntegration` fields consumed** (from `src/modules/ongoing/models/integration.ts`): `id`, `credential_key` (unique), `enabled` (boolean), `status_poll_interval` (text, nullable — parsed as an integer-ms string, same convention as `src/jobs/status-poll.ts:66-73`'s `resolveIntervalMs`), `last_status_poll_at` (dateTime, nullable).
- **Consumes from #40 — `GET /admin/ongoing/integrations` (CONFIRMED response shape).** #40's plan pins the exact response as `res.json({ integrations })` — a pluralized resource key, `{ integrations: OngoingIntegrationRow[] }` — matching this issue's own `GET /admin/ongoing/syncs` convention (`{ syncs, count, limit, offset }`). This plan's `OngoingIntegrationsListResponse` type (`src/admin/routes/ongoing/connection-health.ts`) is aligned with #40's contract; no adjustment expected once #40 merges.
- **`@medusajs/ui` 4.1.16 exports verified directly against `node_modules/@medusajs/ui/dist/esm/index.d.ts`** (do not trust memory/skill examples blindly — one mismatch was caught this way, see next bullet):
  - `DataTable`, `useDataTable`, `createDataTableColumnHelper`, `createDataTableCommandHelper`, `DataTableRowSelectionState`, `DataTablePaginationState`, `DataTableCommand` — all exported from `@medusajs/ui` (re-exported via `export * from "./blocks/data-table"` at `index.d.ts:45`).
  - `DataTable.CommandBar` sub-component exists (`data-table.d.ts:50`) and renders as a self-positioning floating bar (`data-table-command-bar.js` uses the `CommandBar` primitive internally) — JSX placement within `<DataTable>` does not affect its visual position.
  - `DataTableCommand.action` signature: `(selection: DataTableRowSelectionState) => void | Promise<void>` (`blocks/data-table/types.d.ts:268-284`).
  - `Badge` `color` prop accepts exactly: `"green"|"red"|"blue"|"orange"|"grey"|"purple"` (`components/badge/badge.d.ts`).
  - `toast` (lowercase function, `toast.success(title, {description})` / `toast.error(...)`) is exported from `@medusajs/ui` at `index.d.ts:49` (`export { toast } from "./utils/toast"`) — separate from the `Toast` **component** export at line 42; use the function.
  - **`Spinner` is NOT exported from `@medusajs/ui`.** It is exported from `@medusajs/icons` (`node_modules/@medusajs/icons/dist/components/index.d.ts:385` — `export { default as Spinner } from "./spinner"`). Import `Spinner` from `@medusajs/icons` alongside `Server`.
  - `Server` icon confirmed exported from `@medusajs/icons` (`components/index.d.ts:365`).
- **`@tanstack/react-query` is v5.64.2 in this repo** (`node_modules/@tanstack/react-query/package.json`). React Query v5 removed the `keepPreviousData: true` option key used in v4-era examples — use `placeholderData: keepPreviousData` (import `keepPreviousData` from `@tanstack/react-query`). Using the v4 key type-errors and fails the `npx tsc -p src/admin/tsconfig.json --noEmit` admin type-gate (see below — `yarn build` does **not** type-check `src/admin`).
- **`src/admin/lib/sdk.ts` does not exist yet in this repo** (verified: `find src/admin -type f` shows only `README.md`, `tsconfig.json`, `vite-env.d.ts`, `i18n/`). It is owned by #40; **do not add `@medusajs/js-sdk` to `package.json`** — it is already resolvable (verified present at `node_modules/@medusajs/js-sdk` v2.16.0, a transitive dependency via `@medusajs/admin-sdk`'s peer chain, same version as this repo's other pinned `@medusajs/*` packages). Task 4 creates `sdk.ts` **only if absent** with byte-identical content to #40's canonical file — including the `debug: import.meta.env.DEV` line (see Task 4 Step 2 for the exact text; do not omit it).
- **`yarn build` (`medusa plugin:build`) does NOT type-check `src/admin`.** `src/admin/**` is excluded from the root `tsconfig.json` server build; the admin UI is bundled separately via Vite/esbuild, which is transpile-only and does not catch TypeScript errors — a wrong `useDataTable`/`DataTable` prop shape, or exactly the `keepPreviousData` v4-vs-v5 mismatch flagged above, would build "successfully" and only surface at runtime. **The real type-gate for Tasks 4–5 is `npx tsc -p src/admin/tsconfig.json --noEmit`**, run directly against `src/admin/tsconfig.json` (bundler resolution, `strict: true`, `noEmit: true` — confirmed at `src/admin/tsconfig.json`). `yarn build` is still run afterward in both tasks as the packaging/bundling check (confirms the admin bundle actually builds end-to-end), but it is not a substitute for the `tsc` gate.
- **"React/JSX is exempt from TDD" applies only to `.tsx` component files, not to logic factored out of them.** `deriveConnectionHealth` (Task 5) is real branching business logic (disabled/stale/healthy derivation, interval parsing with a default fallback, time-window math) deliberately isolated into a JSX-free `.ts` module specifically so it CAN be unit-tested under the existing node-env Jest config — and per the point above, the `tsc` type-gate would not verify its logic either (only its types). Task 5 therefore follows the same failing-test-first TDD pattern as `retryOngoingSyncsHandler` (Task 1).
- Tests are **pure unit tests** (mock the module service / workflow, or — for `deriveConnectionHealth` — pure input/output with no mocking needed); no local Postgres or Medusa instance, consistent with every existing `src/**/__tests__/*.test.ts` in this repo.

---

## File Structure

**Create:**
- `src/workflows/steps/retry-ongoing-syncs.ts` — step `retryOngoingSyncsStep` + exported handler `retryOngoingSyncsHandler` (direct-testable, same pattern as `pushOrderRecordSyncHandler`).
- `src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts` — unit tests for the handler.
- `src/workflows/retry-ongoing-syncs.ts` — `retryOngoingSyncsWorkflow` (one-step composition).
- `src/api/admin/ongoing/syncs/summary.ts` — `computeSyncStateSummary` aggregate helper + `OngoingSyncState` / `OngoingSyncStateSummary` / `OngoingSyncsCountService` types. Produces the per-`sync_state` counters spec §11 requires (deferred here by #44 — see Architecture note above).
- `src/api/admin/ongoing/syncs/__tests__/summary.test.ts` — unit tests for `computeSyncStateSummary`.
- `src/api/admin/ongoing/syncs/route.ts` — `GET` handler.
- `src/api/admin/ongoing/syncs/__tests__/route.test.ts` — unit tests (pagination defaults, custom limit/offset, fixed `sync_state` filter, response shape including `summary`).
- `src/api/admin/ongoing/syncs/retry/route.ts` — `POST` handler (executes the workflow).
- `src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts` — unit tests (happy path + 3 invalid-shape cases).
- `src/admin/lib/sdk.ts` — **only if absent** (see Task 4).
- `src/admin/routes/ongoing/connection-health.ts` — pure `deriveConnectionHealth` helper + `OngoingIntegrationRow` / `OngoingIntegrationsListResponse` types (no JSX, plain `.ts`).
- `src/admin/routes/ongoing/__tests__/connection-health.test.ts` — unit tests for `deriveConnectionHealth` (disabled, never-polled, within-window, stale-by-age, interval-parsing fallback).
- `src/admin/routes/ongoing/page.tsx` — the dashboard page (`ConnectionHealthPanel` + `OngoingSyncsTable`), `export const config = defineRouteConfig(...)`.

**Modify:**
- `src/workflows/index.ts` — add `export { retryOngoingSyncsWorkflow } from "./retry-ongoing-syncs"` (barrel pattern already used for `pushOrderToOngoing`, `cancelOngoingOrderWorkflow`, etc.).

**Depends on (must already exist — do not redefine):**
- `src/modules/ongoing/index.ts` — exports `ONGOING_MODULE = "ongoing"` (exists, line 5).
- `src/modules/ongoing/models/order-sync.ts` — `OngoingOrderSync` model (exists).
- `src/modules/ongoing/models/integration.ts` — `OngoingIntegration` model (exists).
- `src/modules/ongoing/service.ts` — `OngoingModuleService` with auto-CRUD (exists).
- `@medusajs/js-sdk` resolvable via node_modules (verified present, do not add to `package.json`).
- `GET /admin/ongoing/integrations` — **not created here**, owned by #40 (see "Consumes from #40" above). If #40 has not merged by the time Task 5 runs, the panel will show its empty state (`isLoading` → then an empty `integrations` array on a 404/error is swallowed by `useQuery`'s default error handling and rendered as "No Ongoing integrations configured yet.") rather than crashing the page — acceptable degraded behavior, not a hard blocker for merging this issue's own routes/tests.

---

## Task 1: `retryOngoingSyncsStep` + `retryOngoingSyncsWorkflow`

Add the workflow that performs the actual retry mutation: for each requested `sync_id`, look up the row; if it exists and is `sync_state === "error"` **and** `error_class === "retryable"`, reset `last_synced_at` to `null` (making it immediately due for `retryFailedSyncsJob`, issue #39 — `isRetryDue` there treats `null` as epoch/always-due). Terminal and non-existent rows are skipped, not retried.

**Files:**
- Create: `src/workflows/steps/retry-ongoing-syncs.ts`
- Create: `src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts`
- Create: `src/workflows/retry-ongoing-syncs.ts`
- Modify: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE` from `../../modules/ongoing` (exists).
- Produces: `RetryOngoingSyncsInput = { sync_ids: string[] }`, `RetryOngoingSyncsOutput = { retried: string[]; skipped: string[] }`, `retryOngoingSyncsStep`, `retryOngoingSyncsWorkflow` — consumed by Task 3's POST route.

**Pre-condition — verify no name collision in the workflows barrel:**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && grep -n "retryOngoingSyncs" src/workflows/index.ts
```

Expected: no output (not yet exported) — confirms the barrel edit in this task is additive only.

- [ ] **Step 1: Write the failing tests**

Create `src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts`:

```ts
import { retryOngoingSyncsHandler } from "../retry-ongoing-syncs"

type Row = { id: string; sync_state: string; error_class: "retryable" | "terminal" | null }

function makeContainer(rows: Row[]) {
  const listOngoingOrderSyncs = jest.fn().mockResolvedValue(rows)
  const updateOngoingOrderSyncs = jest.fn().mockResolvedValue({})
  const service = { listOngoingOrderSyncs, updateOngoingOrderSyncs }
  const container = { resolve: jest.fn().mockReturnValue(service) }
  return { container, service }
}

// The createStep wrapper does not expose its invoke fn; test the exported handler
// directly, same pattern as pushOrderRecordSyncHandler
// (src/workflows/steps/__tests__/push-order-record-sync.test.ts).
const invoke = (input: { sync_ids: string[] }, ctx: any) =>
  retryOngoingSyncsHandler(input, ctx)

describe("retryOngoingSyncsHandler", () => {
  it("retries an error/retryable row: resets last_synced_at to null", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "retryable" },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: ["oos_1"] })
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      last_synced_at: null,
    })
    expect(output).toEqual({ retried: ["oos_1"], skipped: [] })
  })

  it("skips a terminal row (does not reset last_synced_at)", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "terminal" },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["oos_1"] })
  })

  it("skips a row that is not in the error state (e.g. sent)", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "sent", error_class: null },
    ])

    const output = await invoke({ sync_ids: ["oos_1"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["oos_1"] })
  })

  it("skips a sync_id that does not exist", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ sync_ids: ["missing"] }, { container })

    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
    expect(output).toEqual({ retried: [], skipped: ["missing"] })
  })

  it("handles a mix of eligible, terminal, and missing ids in one call", async () => {
    const { container, service } = makeContainer([
      { id: "oos_1", sync_state: "error", error_class: "retryable" },
      { id: "oos_2", sync_state: "error", error_class: "terminal" },
    ])

    const output = await invoke(
      { sync_ids: ["oos_1", "oos_2", "oos_3"] },
      { container }
    )

    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    expect(service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "oos_1",
      last_synced_at: null,
    })
    expect(output).toEqual({ retried: ["oos_1"], skipped: ["oos_2", "oos_3"] })
  })

  it("returns empty retried/skipped for an empty sync_ids array (no service calls)", async () => {
    const { container, service } = makeContainer([])

    const output = await invoke({ sync_ids: [] }, { container })

    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ id: [] })
    expect(output).toEqual({ retried: [], skipped: [] })
  })
})
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts
```

Expected: FAIL — `Cannot find module '../retry-ongoing-syncs'`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/retry-ongoing-syncs.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"

export type RetryOngoingSyncsInput = { sync_ids: string[] }
export type RetryOngoingSyncsOutput = { retried: string[]; skipped: string[] }

type SyncRow = {
  id: string
  sync_state: string
  error_class: "retryable" | "terminal" | null
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: { id: string[] }) => Promise<SyncRow[]>
  updateOngoingOrderSyncs: (data: { id: string; last_synced_at: null }) => Promise<unknown>
}

// Exported handler so the step can be unit-tested directly (createStep's wrapper
// does not expose its invoke fn) -- same pattern as pushOrderRecordSyncHandler
// (src/workflows/steps/push-order-record-sync.ts). Business rule: only rows that
// exist AND are sync_state="error" AND error_class="retryable" are reset; this is
// the ONLY place that resets last_synced_at (do not duplicate elsewhere).
export async function retryOngoingSyncsHandler(
  input: RetryOngoingSyncsInput,
  { container }: { container: any }
): Promise<RetryOngoingSyncsOutput> {
  const service: OngoingServiceLike = container.resolve(ONGOING_MODULE)

  const rows = await service.listOngoingOrderSyncs({ id: input.sync_ids })
  const byId = new Map(rows.map((row) => [row.id, row]))

  const retried: string[] = []
  const skipped: string[] = []

  for (const id of input.sync_ids) {
    const row = byId.get(id)
    if (!row || row.sync_state !== "error" || row.error_class !== "retryable") {
      skipped.push(id)
      continue
    }
    await service.updateOngoingOrderSyncs({ id, last_synced_at: null })
    retried.push(id)
  }

  return { retried, skipped }
}

export const retryOngoingSyncsStep = createStep(
  "retry-ongoing-syncs",
  async (input: RetryOngoingSyncsInput, context) => {
    const output = await retryOngoingSyncsHandler(input, context as any)
    return new StepResponse(output)
  }
)
```

Create `src/workflows/retry-ongoing-syncs.ts`:

```ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  retryOngoingSyncsStep,
  type RetryOngoingSyncsInput,
} from "./steps/retry-ongoing-syncs"

export const retryOngoingSyncsWorkflow = createWorkflow(
  "retry-ongoing-syncs",
  function (input: RetryOngoingSyncsInput) {
    const result = retryOngoingSyncsStep(input)
    return new WorkflowResponse(result)
  }
)

export default retryOngoingSyncsWorkflow
```

Modify `src/workflows/index.ts` — append:

```ts
export { retryOngoingSyncsWorkflow } from "./retry-ongoing-syncs"
export type {
  RetryOngoingSyncsInput,
  RetryOngoingSyncsOutput,
} from "./steps/retry-ongoing-syncs"
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Lint and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint && yarn build
```

Expected: zero lint errors; build succeeds (server + admin bundle).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/workflows/steps/retry-ongoing-syncs.ts src/workflows/steps/__tests__/retry-ongoing-syncs.test.ts src/workflows/retry-ongoing-syncs.ts src/workflows/index.ts && git commit -m "feat(ongoing-workflows): retryOngoingSyncsWorkflow — reset last_synced_at for eligible error/retryable rows (#43)"
```

---

## Task 2: `GET /admin/ongoing/syncs` (list + sync-state summary counters)

List `OngoingOrderSync` rows in `pending | sent | error` state (the states a dashboard operator cares about — `shipped`/`cancelled` are excluded), paginated. The same route also returns a `summary` object counting rows across **all 5** `sync_state` values — this is the "success/failure counters" spec §11 requires and that issue #44 (observability) explicitly defers to this issue. The counter logic is factored into its own module (`summary.ts`) and built test-first, since it is branching aggregation logic, not scaffolding.

**Files:**
- Create: `src/api/admin/ongoing/syncs/summary.ts`
- Create: `src/api/admin/ongoing/syncs/__tests__/summary.test.ts`
- Create: `src/api/admin/ongoing/syncs/route.ts`
- Create: `src/api/admin/ongoing/syncs/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE` from `../../../../modules/ongoing` (exists).
- Produces (`summary.ts`): `computeSyncStateSummary(ongoing: OngoingSyncsCountService): Promise<OngoingSyncStateSummary>`, `ALL_SYNC_STATES`, types `OngoingSyncState`, `OngoingSyncStateSummary`, `OngoingSyncsCountService` — consumed by this task's `GET` handler.
- Produces (`route.ts`): `GET` handler responding `{ syncs: OngoingSyncRow[]; count: number; limit: number; offset: number; summary: OngoingSyncStateSummary }` — consumed by Task 5's `OngoingSyncsTable` and its new summary strip.

### Part A — `computeSyncStateSummary`

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/syncs/__tests__/summary.test.ts`:

```ts
import { computeSyncStateSummary, ALL_SYNC_STATES } from "../summary"

function makeService(countsByState: Partial<Record<string, number>>) {
  const listAndCountOngoingOrderSyncs = jest.fn(
    async (filter: { sync_state: string }) => [[], countsByState[filter.sync_state] ?? 0]
  )
  return { listAndCountOngoingOrderSyncs }
}

describe("computeSyncStateSummary", () => {
  it("queries all 5 sync_states and returns their counts keyed by state", async () => {
    const service = makeService({
      pending: 3,
      sent: 1,
      shipped: 10,
      cancelled: 2,
      error: 4,
    })

    const summary = await computeSyncStateSummary(service)

    expect(summary).toEqual({ pending: 3, sent: 1, shipped: 10, cancelled: 2, error: 4 })
    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledTimes(5)
    for (const state of ALL_SYNC_STATES) {
      expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
        { sync_state: state },
        { skip: 0, take: 0 }
      )
    }
  })

  it("defaults a state's count to 0 when the service returns none for it", async () => {
    const service = makeService({ error: 7 })

    const summary = await computeSyncStateSummary(service)

    expect(summary).toEqual({ pending: 0, sent: 0, shipped: 0, cancelled: 0, error: 7 })
  })
})
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/__tests__/summary.test.ts
```

Expected: FAIL — `Cannot find module '../summary'`.

- [ ] **Step 3: Implement `summary.ts`**

Create `src/api/admin/ongoing/syncs/summary.ts`:

```ts
export type OngoingSyncState = "pending" | "sent" | "shipped" | "cancelled" | "error"

export type OngoingSyncStateSummary = Record<OngoingSyncState, number>

export const ALL_SYNC_STATES: readonly OngoingSyncState[] = [
  "pending",
  "sent",
  "shipped",
  "cancelled",
  "error",
]

// Structurally compatible with route.ts's OngoingServiceLike (below): its filter
// type (readonly string[] | string) is a supertype of OngoingSyncState here, and
// its row type is a subtype of `unknown[]`, so the resolved module service can be
// passed to computeSyncStateSummary without a separate cast.
export type OngoingSyncsCountService = {
  listAndCountOngoingOrderSyncs: (
    filter: { sync_state: OngoingSyncState },
    config: { skip: number; take: number }
  ) => Promise<[unknown[], number]>
}

// Spec §11 requires "success/failure counters" feeding the dashboard (#44 defers
// producing these to this issue). One count-only query per sync_state (take: 0 --
// rows are discarded, only the total is used) run in parallel; 5 states is a
// fixed, small fan-out, not an unbounded N+1.
export async function computeSyncStateSummary(
  ongoing: OngoingSyncsCountService
): Promise<OngoingSyncStateSummary> {
  const counts = await Promise.all(
    ALL_SYNC_STATES.map((sync_state) =>
      ongoing.listAndCountOngoingOrderSyncs({ sync_state }, { skip: 0, take: 0 })
    )
  )

  return ALL_SYNC_STATES.reduce((summary, state, index) => {
    summary[state] = counts[index][1]
    return summary
  }, {} as OngoingSyncStateSummary)
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/__tests__/summary.test.ts
```

Expected: both tests pass.

### Part B — `GET` route (list + summary)

- [ ] **Step 5: Write the failing tests**

Create `src/api/admin/ongoing/syncs/__tests__/route.test.ts`:

```ts
import { GET } from "../route"

const makeService = (
  opts: {
    rows?: unknown[]
    count?: number
    summaryCounts?: Partial<Record<string, number>>
  } = {}
) => {
  const summaryCounts = opts.summaryCounts ?? {}
  const listAndCountOngoingOrderSyncs = jest.fn((filter: { sync_state: unknown }) => {
    if (Array.isArray(filter.sync_state)) {
      return Promise.resolve([opts.rows ?? [], opts.count ?? 0])
    }
    return Promise.resolve([[], summaryCounts[filter.sync_state as string] ?? 0])
  })
  return { listAndCountOngoingOrderSyncs }
}

const makeReq = (opts: {
  query?: Record<string, unknown>
  service: ReturnType<typeof makeService>
}) =>
  ({
    query: opts.query ?? {},
    scope: { resolve: jest.fn(() => opts.service) },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /admin/ongoing/syncs", () => {
  it("defaults to limit=20, offset=0 when query params are absent", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 0, take: 20, order: { last_synced_at: "DESC" } }
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("parses limit/offset query strings into ints", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { limit: "5", offset: "10" }, service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 10, take: 5, order: { last_synced_at: "DESC" } }
    )
  })

  it("falls back to defaults for non-numeric or negative query values", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ query: { limit: "abc", offset: "-5" }, service }), res)

    expect(service.listAndCountOngoingOrderSyncs).toHaveBeenCalledWith(
      { sync_state: ["error", "sent", "pending"] },
      { skip: 0, take: 20, order: { last_synced_at: "DESC" } }
    )
  })

  it("always filters to error/sent/pending sync_state (never shipped/cancelled)", async () => {
    const service = makeService()
    const res = makeRes()

    await GET(makeReq({ service }), res)

    const [filter] = service.listAndCountOngoingOrderSyncs.mock.calls[0]
    expect(filter).toEqual({ sync_state: ["error", "sent", "pending"] })
  })

  it("responds with { syncs, count, limit, offset, summary } — summary covers all 5 states", async () => {
    const rows = [
      {
        id: "oos_1",
        ongoing_order_number: "1001-a",
        medusa_order_id: "order_1",
        sync_state: "error",
        error_class: "retryable",
        retry_count: 1,
        last_error: "boom",
        last_synced_at: null,
      },
    ]
    const service = makeService({
      rows,
      count: 1,
      summaryCounts: { pending: 2, sent: 1, shipped: 5, cancelled: 3, error: 1 },
    })
    const res = makeRes()

    await GET(makeReq({ query: { limit: "5", offset: "0" }, service }), res)

    expect(res.json).toHaveBeenCalledWith({
      syncs: rows,
      count: 1,
      limit: 5,
      offset: 0,
      summary: { pending: 2, sent: 1, shipped: 5, cancelled: 3, error: 1 },
    })
  })
})
```

- [ ] **Step 6: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/__tests__/route.test.ts
```

Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 7: Implement the route**

Create `src/api/admin/ongoing/syncs/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import { computeSyncStateSummary, type OngoingSyncStateSummary } from "./summary"

const DEFAULT_LIMIT = 20
const DEFAULT_OFFSET = 0
const DASHBOARD_SYNC_STATES = ["error", "sent", "pending"] as const

type OngoingSyncRow = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  sync_state: string
  error_class: string | null
  retry_count: number
  last_error: string | null
  last_synced_at: Date | string | null
}

type OngoingServiceLike = {
  listAndCountOngoingOrderSyncs: (
    filter: { sync_state: readonly string[] | string },
    config: { skip: number; take: number; order?: Record<string, "ASC" | "DESC"> }
  ) => Promise<[OngoingSyncRow[], number]>
}

// No Zod middleware here on purpose (see Global Constraints) -- parse directly
// with defaults, mirroring the resolved research's exact contract.
function parseIntParam(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = typeof raw === "string" ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const take = parseIntParam(req.query.limit, DEFAULT_LIMIT)
  const skip = parseIntParam(req.query.offset, DEFAULT_OFFSET)

  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  const [[syncs, count], summary]: [[OngoingSyncRow[], number], OngoingSyncStateSummary] =
    await Promise.all([
      ongoing.listAndCountOngoingOrderSyncs(
        { sync_state: DASHBOARD_SYNC_STATES },
        { skip, take, order: { last_synced_at: "DESC" } }
      ),
      computeSyncStateSummary(ongoing),
    ])

  res.status(200).json({ syncs, count, limit: take, offset: skip, summary })
}
```

- [ ] **Step 8: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/__tests__/route.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 9: Lint and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint && yarn build
```

Expected: zero lint errors; build succeeds.

- [ ] **Step 10: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/api/admin/ongoing/syncs/summary.ts src/api/admin/ongoing/syncs/__tests__/summary.test.ts src/api/admin/ongoing/syncs/route.ts src/api/admin/ongoing/syncs/__tests__/route.test.ts && git commit -m "feat(ongoing-admin-api): GET /admin/ongoing/syncs — paginated error/sent/pending list + all-state summary counters (#43)"
```

---

## Task 3: `POST /admin/ongoing/syncs/retry`

Execute `retryOngoingSyncsWorkflow` (Task 1) for the requested `sync_ids` and return `{ retried, skipped }`.

**Files:**
- Create: `src/api/admin/ongoing/syncs/retry/route.ts`
- Create: `src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts`

**Interfaces:**
- Consumes from Task 1: `retryOngoingSyncsWorkflow` from `../../../../../workflows` (barrel).
- Consumes: `MedusaError` from `@medusajs/framework/utils` (exists, already used across `src/workflows/steps/*`).
- Produces: `POST` handler responding `{ retried: string[]; skipped: string[] }` — consumed by Task 5's bulk-retry command.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts`:

```ts
// Mock the workflows barrel BEFORE importing the route (hoisted by @swc/jest,
// same pattern as src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts).
const runMock = jest.fn()
jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  retryOngoingSyncsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { POST } from "../route"
import { retryOngoingSyncsWorkflow as retryOngoingSyncsWorkflowImport } from "../../../../../../workflows"

const retryOngoingSyncsWorkflow =
  retryOngoingSyncsWorkflowImport as jest.MockedFunction<
    typeof retryOngoingSyncsWorkflowImport
  >

const makeReq = (body: unknown) => ({ body, scope: {} }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  runMock.mockReset()
  retryOngoingSyncsWorkflow.mockClear()
})

describe("POST /admin/ongoing/syncs/retry", () => {
  it("runs retryOngoingSyncsWorkflow with sync_ids from the body and returns its result", async () => {
    runMock.mockResolvedValue({ result: { retried: ["oos_1"], skipped: ["oos_2"] } })
    const res = makeRes()

    await POST(makeReq({ sync_ids: ["oos_1", "oos_2"] }), res)

    expect(runMock).toHaveBeenCalledWith({ input: { sync_ids: ["oos_1", "oos_2"] } })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ retried: ["oos_1"], skipped: ["oos_2"] })
  })

  it("throws MedusaError invalid_data when sync_ids is missing", async () => {
    const res = makeRes()

    await expect(POST(makeReq({}), res)).rejects.toMatchObject({ type: "invalid_data" })
    expect(runMock).not.toHaveBeenCalled()
  })

  it("throws MedusaError invalid_data when sync_ids is an empty array", async () => {
    const res = makeRes()

    await expect(POST(makeReq({ sync_ids: [] }), res)).rejects.toMatchObject({
      type: "invalid_data",
    })
    expect(runMock).not.toHaveBeenCalled()
  })

  it("throws MedusaError invalid_data when sync_ids contains a non-string element", async () => {
    const res = makeRes()

    await expect(
      POST(makeReq({ sync_ids: ["ok", 123] }), res)
    ).rejects.toMatchObject({ type: "invalid_data" })
    expect(runMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts
```

Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Implement the route**

Create `src/api/admin/ongoing/syncs/retry/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { retryOngoingSyncsWorkflow } from "../../../../../workflows"

type RetryOngoingSyncsBody = { sync_ids?: unknown }

function assertValidSyncIds(body: RetryOngoingSyncsBody): asserts body is { sync_ids: string[] } {
  const { sync_ids } = body
  if (
    !Array.isArray(sync_ids) ||
    sync_ids.length === 0 ||
    sync_ids.some((id) => typeof id !== "string")
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "sync_ids must be a non-empty array of strings"
    )
  }
}

export async function POST(
  req: MedusaRequest<RetryOngoingSyncsBody>,
  res: MedusaResponse
): Promise<void> {
  const body = req.body as RetryOngoingSyncsBody
  assertValidSyncIds(body)

  const { result } = await retryOngoingSyncsWorkflow(req.scope).run({
    input: { sync_ids: body.sync_ids },
  })

  res.status(200).json(result)
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
```

Expected: all existing tests plus the new tests from Tasks 1–3 pass. Zero failures.

- [ ] **Step 6: Lint and build**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint && yarn build
```

Expected: zero lint errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/api/admin/ongoing/syncs/retry/route.ts src/api/admin/ongoing/syncs/retry/__tests__/route.test.ts && git commit -m "feat(ongoing-admin-api): POST /admin/ongoing/syncs/retry — bulk-retry via retryOngoingSyncsWorkflow (#43)"
```

---

## Task 4: Admin SDK client bootstrap (`src/admin/lib/sdk.ts`)

No test — this is infra/scaffolding (exempt from TDD per `docs/superpowers/process.md`'s workflow spine). Verified by `npx tsc -p src/admin/tsconfig.json --noEmit` (the real admin type-gate, see Global Constraints) plus `yarn build` (bundling check) since `page.tsx` imports it.

**Files:**
- Create (conditionally): `src/admin/lib/sdk.ts`

**Interfaces:**
- Produces: `export const sdk` — the `@medusajs/js-sdk` `Medusa` client instance, consumed by Task 5's `page.tsx`.

- [ ] **Step 1: Check whether `src/admin/lib/sdk.ts` already exists**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && find src/admin/lib -type f 2>/dev/null
```

- **If `sdk.ts` already exists** (created by a merged #40): do nothing in this task — Task 5 imports the existing file unchanged. Skip to Task 5.
- **If absent** (the expected case if #40 has not merged yet): proceed to Step 2.

- [ ] **Step 2: Create `src/admin/lib/sdk.ts`**

```ts
import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})
```

This is byte-identical to #40's canonical `sdk.ts` (`baseUrl: import.meta.env.VITE_BACKEND_URL || "/"`, `debug: import.meta.env.DEV`, `auth: { type: "session" }`) — including the `debug` line — so a later #40 merge adding the identical file is a no-op / trivial conflict resolution, not a divergence.

- [ ] **Step 3: Type-check (real admin type-gate)**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && npx tsc -p src/admin/tsconfig.json --noEmit
```

Expected: no TypeScript errors. `yarn build` (Step 4) does **not** type-check `src/admin` (see Global Constraints) — this `tsc` invocation is the actual gate.

- [ ] **Step 4: Build (bundling/packaging check)**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn build
```

Expected: build succeeds (this file alone has no consumers yet until Task 5; a standalone build here just confirms the admin bundle still packages correctly — acceptable to also defer this check to Task 5's build if preferred).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/admin/lib/sdk.ts && git commit -m "chore(ongoing-admin): add admin SDK client bootstrap (#43)"
```

(Skip this commit if Step 1 found the file already existed.)

---

## Task 5: Dashboard page (`src/admin/routes/ongoing/page.tsx`)

Two files: a pure, JSX-free helper module (`connection-health.ts`, built **TDD-first** — it is real branching business logic, not exempt UI) and the page itself (`page.tsx`, `.tsx` UI — no Jest test, verified by the real `tsc` admin type-gate, see Global Constraints).

**Files:**
- Create: `src/admin/routes/ongoing/__tests__/connection-health.test.ts`
- Create: `src/admin/routes/ongoing/connection-health.ts`
- Create: `src/admin/routes/ongoing/page.tsx`

**Interfaces:**
- Consumes from Task 2: `GET /admin/ongoing/syncs` → `{ syncs, count, limit, offset, summary }`, where `summary: Record<"pending"|"sent"|"shipped"|"cancelled"|"error", number>` — rendered as a summary strip (spec §11 counters) above the syncs table.
- Consumes from Task 3: `POST /admin/ongoing/syncs/retry` → `{ retried, skipped }`.
- Consumes from Task 4: `sdk` from `../../lib/sdk`.
- Consumes from #40 (confirmed contract, see Global Constraints): `GET /admin/ongoing/integrations` → `{ integrations: OngoingIntegrationRow[] }`.
- Produces: `export default OngoingDashboardPage`, `export const config = defineRouteConfig({ label: "Ongoing WMS", icon: Server })` — mounts the page at `/app/ongoing`.

- [ ] **Step 1: Write the failing tests for `deriveConnectionHealth`**

Create `src/admin/routes/ongoing/__tests__/connection-health.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/admin/routes/ongoing/__tests__/connection-health.test.ts
```

Expected: FAIL — `Cannot find module '../connection-health'`.

- [ ] **Step 3: Implement `src/admin/routes/ongoing/connection-health.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test src/admin/routes/ongoing/__tests__/connection-health.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Create `src/admin/routes/ongoing/page.tsx`**

```tsx
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Server, Spinner } from "@medusajs/icons"
import {
  Badge,
  Container,
  DataTable,
  DataTableRowSelectionState,
  DataTablePaginationState,
  Heading,
  Text,
  Tooltip,
  createDataTableColumnHelper,
  createDataTableCommandHelper,
  toast,
  useDataTable,
} from "@medusajs/ui"
import { useMemo, useState } from "react"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../../lib/sdk"
import {
  deriveConnectionHealth,
  type OngoingIntegrationHealth,
  type OngoingIntegrationsListResponse,
} from "./connection-health"

type OngoingSyncState = "pending" | "sent" | "error"
type OngoingErrorClass = "retryable" | "terminal"

type OngoingSyncRow = {
  id: string
  ongoing_order_number: string
  medusa_order_id: string
  sync_state: OngoingSyncState
  error_class: OngoingErrorClass | null
  retry_count: number
  last_error: string | null
  last_synced_at: string | null
}

// Mirrors OngoingSyncStateSummary from src/api/admin/ongoing/syncs/summary.ts.
// Duplicated locally (not imported) the same way OngoingSyncRow above duplicates
// the route's row shape -- src/admin uses bundler/Vite resolution and a separate
// tsconfig from src/api's Node16 server build, so this file intentionally does
// not reach into src/api/**.
type OngoingSyncStateSummary = Record<
  "pending" | "sent" | "shipped" | "cancelled" | "error",
  number
>

type ListSyncsResponse = {
  syncs: OngoingSyncRow[]
  count: number
  limit: number
  offset: number
  summary: OngoingSyncStateSummary
}

type RetrySyncsResponse = {
  retried: string[]
  skipped: string[]
}

const SYNC_STATE_BADGE_COLOR: Record<OngoingSyncState, "red" | "orange" | "grey"> = {
  error: "red",
  sent: "orange",
  pending: "grey",
}

const ERROR_CLASS_BADGE_COLOR: Record<OngoingErrorClass, "orange" | "red"> = {
  retryable: "orange",
  terminal: "red",
}

// Order operators care about most first: error, then pending/in-flight, then
// terminal/settled states.
const SUMMARY_STATE_ORDER: (keyof OngoingSyncStateSummary)[] = [
  "error",
  "pending",
  "sent",
  "shipped",
  "cancelled",
]

const SUMMARY_BADGE_COLOR: Record<
  keyof OngoingSyncStateSummary,
  "red" | "grey" | "orange" | "green" | "purple"
> = {
  error: "red",
  pending: "grey",
  sent: "orange",
  shipped: "green",
  cancelled: "purple",
}

const HEALTH_BADGE_COLOR: Record<OngoingIntegrationHealth, "green" | "orange" | "grey"> = {
  healthy: "green",
  stale: "orange",
  disabled: "grey",
}

const LAST_ERROR_TRUNCATE_AT = 40

function isRetryEligible(row: OngoingSyncRow): boolean {
  return row.sync_state === "error" && row.error_class === "retryable"
}

const columnHelper = createDataTableColumnHelper<OngoingSyncRow>()

const columns = [
  columnHelper.select(),
  columnHelper.accessor("ongoing_order_number", { header: "Ongoing order #" }),
  columnHelper.accessor("medusa_order_id", { header: "Medusa order" }),
  columnHelper.accessor("sync_state", {
    header: "Sync state",
    cell: ({ getValue }) => (
      <Badge color={SYNC_STATE_BADGE_COLOR[getValue()]}>{getValue()}</Badge>
    ),
  }),
  columnHelper.accessor("error_class", {
    header: "Error class",
    cell: ({ getValue }) => {
      const value = getValue()
      if (!value) {
        return (
          <Text size="small" className="text-ui-fg-subtle">
            —
          </Text>
        )
      }
      return <Badge color={ERROR_CLASS_BADGE_COLOR[value]}>{value}</Badge>
    },
  }),
  columnHelper.accessor("retry_count", { header: "Retries" }),
  columnHelper.accessor("last_error", {
    header: "Last error",
    cell: ({ getValue }) => {
      const value = getValue()
      if (!value) {
        return (
          <Text size="small" className="text-ui-fg-subtle">
            —
          </Text>
        )
      }
      const truncated =
        value.length > LAST_ERROR_TRUNCATE_AT
          ? `${value.slice(0, LAST_ERROR_TRUNCATE_AT)}…`
          : value
      return (
        <Tooltip content={value}>
          <Text size="small">{truncated}</Text>
        </Tooltip>
      )
    },
  }),
  columnHelper.accessor("last_synced_at", {
    header: "Last synced",
    cell: ({ getValue }) => {
      const value = getValue()
      return (
        <Text size="small" className="text-ui-fg-subtle">
          {value ? new Date(value).toLocaleString() : "never"}
        </Text>
      )
    },
  }),
]

const commandHelper = createDataTableCommandHelper()

// Spec §11 "success/failure counters" (deferred to this issue by #44). Pure
// presentational component -- summary is fetched by the same query as the
// syncs table (OngoingSyncsTable), no separate request.
function SyncStateSummaryStrip({
  summary,
  isLoading,
}: {
  summary: OngoingSyncStateSummary | undefined
  isLoading: boolean
}) {
  return (
    <Container className="flex items-center gap-x-6 px-6 py-4">
      {isLoading || !summary ? (
        <Spinner className="animate-spin" />
      ) : (
        SUMMARY_STATE_ORDER.map((state) => (
          <div key={state} className="flex items-center gap-x-2">
            <Badge color={SUMMARY_BADGE_COLOR[state]}>{state}</Badge>
            <Text size="small" weight="plus">
              {summary[state]}
            </Text>
          </div>
        ))
      )}
    </Container>
  )
}

function ConnectionHealthPanel() {
  const { data, isLoading } = useQuery({
    queryFn: () =>
      sdk.client.fetch<OngoingIntegrationsListResponse>("/admin/ongoing/integrations"),
    queryKey: ["ongoing-integrations-health"],
  })

  const integrations = data?.integrations ?? []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Connection health</Heading>
      </div>
      <div className="px-6 py-4">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <Spinner className="animate-spin" />
          </div>
        ) : integrations.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            No Ongoing integrations configured yet.
          </Text>
        ) : (
          <div className="flex flex-col gap-y-2">
            {integrations.map((integration) => {
              const health = deriveConnectionHealth(integration)
              return (
                <div key={integration.id} className="flex items-center justify-between">
                  <Text size="small" weight="plus">
                    {integration.credential_key}
                  </Text>
                  <Badge color={HEALTH_BADGE_COLOR[health]}>{health}</Badge>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Container>
  )
}

function OngoingSyncsTable() {
  const queryClient = useQueryClient()
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>({})
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })

  const limit = pagination.pageSize
  const offset = pagination.pageIndex * limit

  const { data, isLoading } = useQuery({
    queryFn: () =>
      sdk.client.fetch<ListSyncsResponse>("/admin/ongoing/syncs", {
        query: { limit, offset },
      }),
    queryKey: ["ongoing-syncs", limit, offset],
    placeholderData: keepPreviousData,
  })

  const commands = useMemo(
    () => [
      commandHelper.command({
        label: "Retry",
        shortcut: "r",
        action: async (selection: DataTableRowSelectionState) => {
          const syncIds = Object.keys(selection).filter((id) => selection[id])
          if (syncIds.length === 0) {
            return
          }

          try {
            const result = await sdk.client.fetch<RetrySyncsResponse>(
              "/admin/ongoing/syncs/retry",
              { method: "POST", body: { sync_ids: syncIds } }
            )
            queryClient.invalidateQueries({ queryKey: ["ongoing-syncs"] })
            setRowSelection({})
            toast.success("Retry queued", {
              description: `${result.retried.length} sync(s) queued for retry, ${result.skipped.length} skipped.`,
            })
          } catch (error) {
            toast.error("Retry failed", {
              description: error instanceof Error ? error.message : "Unknown error",
            })
          }
        },
      }),
    ],
    [queryClient]
  )

  const table = useDataTable({
    data: data?.syncs ?? [],
    columns,
    commands,
    getRowId: (row) => row.id,
    rowCount: data?.count ?? 0,
    isLoading,
    rowSelection: {
      state: rowSelection,
      onRowSelectionChange: setRowSelection,
      // Selection is restricted to error/retryable rows -- terminal rows are
      // shown (with a distinct badge) but not selectable for bulk retry. The
      // workflow step (Task 1) double-guards this server-side regardless.
      enableRowSelection: (row) => isRetryEligible(row.original),
    },
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
  })

  return (
    <>
      <SyncStateSummaryStrip summary={data?.summary} isLoading={isLoading} />
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <Heading level="h2">Failed &amp; pending syncs</Heading>
        </div>
        <DataTable instance={table}>
          <DataTable.Table />
          <DataTable.Pagination />
          <DataTable.CommandBar selectedLabel={(count) => `${count} selected`} />
        </DataTable>
      </Container>
    </>
  )
}

const OngoingDashboardPage = () => {
  return (
    <div className="flex flex-col gap-y-3">
      <ConnectionHealthPanel />
      <OngoingSyncsTable />
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Ongoing WMS",
  icon: Server,
})

export default OngoingDashboardPage
```

- [ ] **Step 6: Type-check (real admin type-gate)**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && npx tsc -p src/admin/tsconfig.json --noEmit
```

Expected: no TypeScript errors in `src/admin/routes/ongoing/*` or `src/admin/lib/sdk.ts`. **This — not `yarn build` — is the gate that actually catches TS errors** (see Global Constraints: `yarn build` bundles `src/admin` via Vite/esbuild, transpile-only, no type-checking). Pay particular attention to:
- `Spinner` resolving from `@medusajs/icons` (not `@medusajs/ui` — a bare `Spinner` import from `@medusajs/ui` fails to resolve).
- `placeholderData: keepPreviousData` compiling against `@tanstack/react-query` 5.64.2 (the v4-era `keepPreviousData: true` key does not exist on this version's `UseQueryOptions` and would fail here, but only under `tsc`, not under `yarn build`).
- `DataTable.CommandBar`, `createDataTableCommandHelper`, `DataTableRowSelectionState.enableRowSelection` all resolving from `@medusajs/ui`.
- `ListSyncsResponse.summary` (the locally-declared `OngoingSyncStateSummary` type) matching the shape the sdk fetch returns from `GET /admin/ongoing/syncs`, and `SyncStateSummaryStrip`'s `summary` prop accepting `data?.summary` (`OngoingSyncStateSummary | undefined`).

- [ ] **Step 7: Build (bundling/packaging check)**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn build
```

Expected: build succeeds (confirms the admin bundle packages end-to-end; this step is in addition to, not instead of, Step 6's `tsc` gate).

- [ ] **Step 8: Run the full test suite one more time (regression check)**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn test
```

Expected: all tests from Tasks 1–3, this task's new `connection-health.test.ts`, and the pre-existing suite all pass.

- [ ] **Step 9: Lint**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && yarn lint
```

Expected: zero lint errors.

- [ ] **Step 10: Commit**

```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin && git add src/admin/routes/ongoing/connection-health.ts src/admin/routes/ongoing/__tests__/connection-health.test.ts src/admin/routes/ongoing/page.tsx && git commit -m "feat(ongoing-admin-ui): dashboard page — failed/pending syncs table, bulk retry, connection health (#43)"
```

---

## Self-Review Checklist

**Spec coverage (§10 "Dashboard page" line):**
- Failed/pending syncs across all orders: `GET /admin/ongoing/syncs` filters `sync_state ∈ {error, sent, pending}`, paginated. ✓
- Bulk retry: `DataTable.CommandBar` "Retry" command over selected rows → `POST /admin/ongoing/syncs/retry` → `retryOngoingSyncsWorkflow`. ✓
- Selection restricted to error/retryable rows (baked decision — "affects error/retryable rows only... no Retry All sweep, no terminal revival"); server-side eligibility double-guard in the step. ✓
- Per-integration connection health: static derivation (`healthy|stale|disabled`) from `enabled`, `status_poll_interval`, `last_status_poll_at` — no live test-connection call from the dashboard (baked decision). ✓
- Success/failure counters (Spec §11, explicitly deferred to this issue by #44's plan): `computeSyncStateSummary` (`src/api/admin/ongoing/syncs/summary.ts`, Task 2 Part A) counts rows for all 5 `sync_state` values (`pending|sent|shipped|cancelled|error`), returned as `summary` on `GET /admin/ongoing/syncs`, rendered as a `SyncStateSummaryStrip` above the syncs table (Task 5). ✓

**Architecture / skill compliance:**
- Mutation (`POST .../retry`) goes through a workflow (`retryOngoingSyncsWorkflow` → `retryOngoingSyncsStep`), not a direct module-service call from the route — `arch-workflow-required`. ✓
- Only GET/POST used; no PUT/PATCH. ✓
- Imports at top of file, no dynamic `await import()`. ✓
- Module isolation: routes/steps only resolve `ONGOING_MODULE`; no cross-module service calls. ✓
- `#40` not recreated: `GET /admin/ongoing/integrations` is consumed, not implemented, here. ✓
- No shared-file touch on `src/api/middlewares.ts` or `package.json` (`@medusajs/js-sdk` not added) — both explicitly reserved for #40 by the ownership map. ✓

**Type/API verification performed (not guessed):**
- `listAndCountOngoingOrderSyncs` naming and `$in`-shorthand array filter confirmed against existing `service.ts` usage. ✓
- `@medusajs/ui` `DataTable`/`useDataTable`/command-helper/`Badge` colors verified against `node_modules/@medusajs/ui/dist/esm/**/*.d.ts`. ✓
- `Spinner` corrected to `@medusajs/icons` (not `@medusajs/ui`) after checking actual type defs. ✓
- `@tanstack/react-query` confirmed v5.64.2 → `placeholderData: keepPreviousData` used instead of the v4 `keepPreviousData: true` key. ✓
- `validateAndTransformQuery(Schema, {})`-style patterns were probed against this exact `tsconfig.json` pin and confirmed to compile — ultimately not used here since Task 2/3 stayed with the resolved research's inline-parsing approach for the shared-file reason above. ✓
- `MedusaError.Types.INVALID_DATA === "invalid_data"` and thrown instances carry `.type`, verified against `node_modules/@medusajs/utils/dist/common/errors.js`. ✓
- **`yarn build` does not type-check `src/admin`** (`medusa plugin:build` bundles the admin UI via Vite/esbuild, transpile-only) — corrected after review; Tasks 4–5 now gate on `npx tsc -p src/admin/tsconfig.json --noEmit` for real TypeScript verification, with `yarn build` kept as a separate bundling/packaging check. ✓
- **`computeSyncStateSummary` is TDD'd, not exempted.** It is the aggregation logic behind spec §11's counters, factored into a route-adjacent `.ts` module (`src/api/admin/ongoing/syncs/summary.ts`) specifically so it can be unit-tested with a mocked service — `src/api/admin/ongoing/syncs/__tests__/summary.test.ts` (Task 2 Part A) covers the all-5-states fan-out and the zero-count-when-absent default. `GET /admin/ongoing/syncs`'s own test (`route.test.ts`) then asserts the merged `summary` field end-to-end. ✓
- `Toast` **component** export corrected to `index.d.ts:42` (verified directly; the earlier citation of line 38 pointed at `export { Table }`, not `Toast`) — the substantive distinction (the `toast` function at `index.d.ts:49` is a separate export from the `Toast` component) was already correct, only the line number was wrong. ✓
- **`deriveConnectionHealth` is TDD'd, not exempted.** It is branching business logic isolated into a JSX-free `.ts` module specifically so it can be unit-tested; `src/admin/routes/ongoing/__tests__/connection-health.test.ts` (Task 5, Steps 1–4) covers disabled, never-polled/stale, within-window/healthy, stale-by-age, the `<=` boundary, and the `parseIntervalMs` default/fallback paths (null and non-numeric `status_poll_interval`) — following the same failing-test-first pattern as `retryOngoingSyncsHandler` (Task 1). The "React/JSX exempt from TDD" carve-out applies only to `page.tsx` itself. ✓

**#40 cross-plan alignment (confirmed, not assumed):**
- `GET /admin/ongoing/integrations` response envelope is **confirmed** against #40's plan (`res.json({ integrations })`) — matches this plan's `OngoingIntegrationsListResponse` (`{ integrations: OngoingIntegrationRow[] }`) exactly; no adjustment expected once #40 merges.
- `src/admin/lib/sdk.ts` (Task 4) is byte-identical to #40's canonical file, **including** the `debug: import.meta.env.DEV` line (previously omitted — corrected after review).

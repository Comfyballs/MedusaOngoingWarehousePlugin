# Persist edit-blocked state on `OngoingOrderSync` (model field + migration + subscriber write) (#91)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Checkboxes (`- [ ]`) track progress. Tasks 1, 4, and 5 are business logic and follow `superpowers:test-driven-development` (failing test first). Task 2 (model field addition) and Task 3 (migration generation) are pure config/scaffolding and are exempt per `docs/superpowers/process.md` ("Config, scripts, infra, and pure scaffolding are exempt") — they are instead verified by a live-database round trip (Task 3) and `yarn build` (Task 7). Task 6 is explicitly optional/beyond the issue's literal text — see its header.

**Goal:** Today `ongoing.sync.edit_blocked` is emitted by `src/subscribers/order-updated.ts` and `src/subscribers/order-edit-confirmed.ts` but never written anywhere — `OngoingOrderSync` has no column for it, so #42's order-detail widget (which renders only persisted fields, by its own explicit "Out of scope" note) cannot show an "edit blocked" banner. This plan adds `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` to the `OngoingOrderSync` model, generates the migration, and writes those fields from the two subscribers' existing blocked-emit sites, through a workflow (per Medusa's "mutations only via workflows" rule) — mirroring the existing `mark-order-sync-cancelled.ts` / `mark-order-sync-shipped.ts` step pattern.

**Out of scope (explicitly, do not implement here):**
- **Rendering the fields in the admin order widget.** That is #42's widget file, `src/admin/widgets/ongoing-order-sync.tsx`, and its backing route `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`. This plan only makes the fields exist and get written; it does not touch `src/admin/**` or the sync/repush routes.
- **Hand-off note (resolves the #42 ⇄ #91 circular deferral):** #42's plan (`docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md:8`) says "#91 will add the persistence + surfacing once scoped"; this issue's own text says "surfacing in the order widget is #42's job." Neither plan implements the banner. **Action for whoever lands this plan:** if #42 has already merged by the time this lands, open a small follow-up issue (or reopen #42's scope) to add `edit_blocked_at`/`edit_blocked_category`/`edit_blocked_reason` to the GET route's row type and render a banner in the widget — a small, mechanical change once these columns exist, but it is a **new** issue, not silently folded into this one.
- Any change to `src/workflows/steps/gate-order-edit.ts`, `src/workflows/sync-order-edit-to-ongoing.ts`, or `src/workflows/steps/upsert-ongoing-order-edit.ts` — those files are untouched; this plan reads their existing behavior (the `reason` vocabulary) but does not modify them.

---

## Research already read (cited, load-bearing)

- **`src/modules/ongoing/models/order-sync.ts:1-22`** — current `OngoingOrderSync` fields end with `shipped_at: model.dateTime().nullable()`. No edit-blocked columns exist today.
- **`src/modules/ongoing/service.ts:19-22`** — `OngoingModuleService extends MedusaService({ OngoingIntegration, OngoingOrderSync })`, which auto-generates `updateOngoingOrderSyncs(data)` (single-object input → single-entity output, per the `recordSync` comment at `service.ts:71-73`).
- **`src/workflows/steps/mark-order-sync-shipped.ts:1-29`** and its test **`src/workflows/steps/__tests__/mark-order-sync-shipped.test.ts`** — the exact precedent this plan's new step copies: an exported `markOrderSyncShippedHandler(input, { container })` (so it's directly unit-testable without the `createStep` wrapper — see the comment at `src/workflows/steps/push-order-record-sync.ts:18-19`, "the createStep wrapper does not expose its invoke fn"), resolving `ONGOING_MODULE` and calling `ongoing.updateOngoingOrderSyncs({ id, ...fields })`, wrapped by `createStep("mark-order-sync-shipped", markOrderSyncShippedHandler)`.
- **`src/workflows/steps/mark-order-sync-cancelled.ts:1-27`** — the sibling precedent (simpler, no extra input fields), and **`src/subscribers/order-canceled.ts:1-79`** — confirms the established subscriber → workflow → step chain: the subscriber calls `cancelOngoingOrderWorkflow(container).run({ input })` (not the step or service directly), and `cancelOngoingOrderWorkflow` (`src/workflows/cancel-ongoing-order.ts:1-37`) wraps `markOrderSyncCancelledStep` inside a `when(...).then(...)` branch. This is the "mutations only via workflows" rule in action, and the reason this plan wraps its new step in a one-step workflow rather than letting subscribers call `createStep`-wrapped functions directly (steps require a workflow execution context to run).
- **`src/workflows/steps/gate-order-edit.ts:37-87`** — `decideOrderEditGate({ input, sync, integration })`'s reason vocabulary and **precedence**: `!sync → "no_sync_row"`, then `!rules → "no_edit_rules"` (checked BEFORE the status check), then `latest_status_code == null → "status_unknown"`, then `!allowedCodes.includes(code) → "status_blocked"`, else `"allowed"`. This plan's two subscribers reproduce this exact precedence (minus `"no_sync_row"`, which cannot occur — the row is already resolved) so the persisted `edit_blocked_reason` vocabulary matches #27's gate exactly. **Verified against the existing subscriber test fixtures** (see Task 4/5 below): a fixture with `editSyncRules: { int_1: {} }` (empty-but-present `edit_sync_rules` object) resolves to `"status_blocked"`, NOT `"no_edit_rules"`, because `!rules` is false for a truthy empty object — `"no_edit_rules"` only fires when `edit_sync_rules` itself is `null`/absent at the integration level. This is not a hypothetical; it is required to match the pre-existing test fixture at `src/subscribers/__tests__/order-updated.test.ts:169-188`.
- **`src/workflows/sync-order-edit-to-ongoing.ts:5-33`** — `SyncOrderEditResult = { synced: boolean; blocked: boolean; reason: string }`; `reason: data.decision.reason` is `decideOrderEditGate`'s own machine-readable reason string, carried straight through. `order-edit-confirmed.ts`'s post-workflow blocked branch can use `result.reason` directly (authoritative — no need to re-derive).
- **`src/subscribers/order-updated.ts:1-181`** (full file read) — single blocked-emit site at lines 123-137 (pre-check, before calling the workflow at all — when blocked, the workflow is **never invoked** for that row); success/non-success branch at lines 153-161 (`if (result?.synced) { ... } else { ... }`, no event emitted either way).
- **`src/subscribers/order-edit-confirmed.ts:1-151`** (full file read) — TWO blocked-emit sites: pre-check at lines 100-106 (`emitBlocked(row)`, own computed `allowed`), and post-workflow at lines 120-126 (`if (result?.blocked) { ...; emitBlocked(row) }`, using `result.reason`). Success path logs at line 128-130 with no event and no field write today.
- **`src/subscribers/__tests__/order-updated.test.ts`** (full file read, 247 lines) and **`src/subscribers/__tests__/order-edit-confirmed.test.ts`** (full file read, 208 lines) — both mock `syncOrderEditToOngoing` at the module level (`jest.mock("../../workflows/sync-order-edit-to-ongoing", ...)`) and set up a `runMock` returned from `.mockReturnValue({ run: runMock })`, reset in `beforeEach`. This plan's new `markOrderSyncEditBlockedWorkflow` mock must be wired the same way (own `jest.mock` + own `markBlockedRunMock`, reset in the same `beforeEach`) — **critical**: without a `.mockReturnValue({ run: ... })` default, calling `markOrderSyncEditBlockedWorkflow(container).run(...)` on an un-configured `jest.fn()` returns `undefined`, and `.run` on `undefined` throws, which the per-row `try/catch` in both subscribers would silently swallow — breaking the *unrelated* pre-existing assertions in the "allowed" test cases (they'd fall into the catch block and never reach `logger.info("...re-synced...")`).
- **`src/workflows/index.ts:1-25`** — the barrel; new workflow exports are appended here (pattern: `export { cancelOngoingOrderWorkflow } from "./cancel-ongoing-order"`).
- **`src/modules/ongoing/migrations/Migration20260623211927.ts`** (full file read) — the only existing migration; shows this repo's exact MikroORM-generated SQL shape for enum columns (`"error_class" text check ("error_class" in ('retryable', 'terminal')) null`) and nullable timestamp/text columns (`"shipped_at" timestamptz null`, `"last_error" text null`) — the pattern this plan's 3 new columns will follow.
- **`~/.claude memory: plugin-db-generate-recipe`** (verified against this session, re-derived below) — `npx medusa plugin:db:generate` needs a **live Postgres** reachable via `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD` (Medusa's own names, not `PG*`); `dbName` is hardcoded to `medusa-<moduleName>` → `medusa-ongoing` for this module; do NOT set `DATABASE_URL` (conflicts with the hardcoded `dbName`, causes a misleading SASL crash); output lands in `src/modules/ongoing/migrations/` as a new `MigrationYYYYMMDDHHMMSS.ts` plus an updated `.snapshot-medusa-ongoing.json`; both must be committed.
- **`docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md:8,18,22`** — confirms #42's widget renders **only persisted `OngoingOrderSync` fields** and explicitly does not assume any particular edit-blocked field name (it just doesn't render one at all). This plan is therefore free to name the columns `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` per the issue text without any cross-plan naming conflict — **checked, not assumed**.

---

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6** (`Node16` module resolution, decorators enabled — root `tsconfig.json`); yarn **4.6.0**; Node **>= 20**.
- **Mutations only via workflows** (per `CLAUDE.md` code-review section and the `medusa-dev:building-with-medusa` skill's `arch-workflow-required` rule): the subscribers never call `container.resolve(ONGOING_MODULE).updateOngoingOrderSyncs(...)` directly. They call a workflow, which wraps a step, which does the write — exactly the `order-canceled.ts` → `cancelOngoingOrderWorkflow` → `markOrderSyncCancelledStep` chain.
- **Workflow composition rules** (`createWorkflow`'s function body): plain `function`, not `async`/arrow; no `await`; no conditionals inside the composer (this plan's new workflow is a single unconditional step call, so none of these restrictions are exercised, but the file must still follow the shape).
- Model changes go through `model.define` in `src/modules/ongoing/models/order-sync.ts`; the migration is **generated**, never hand-written, via `npx medusa plugin:db:generate` against a live Postgres.
- `MedusaError` is not needed in this plan (no validation-failure path is added) — the new step's write is unconditional given valid input.
- Async service/step methods; no `PUT`/`PATCH` (not applicable — no new routes here).
- `jest.config.js`: `testEnvironment: "node"`, `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`, `@swc/jest` transform, `clearMocks: true`.

---

## File Structure

**Create:**
- `src/workflows/steps/mark-order-sync-edit-blocked.ts` — the write step (mirrors `mark-order-sync-shipped.ts`).
- `src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts` — unit tests for the step's exported handler.
- `src/workflows/mark-order-sync-edit-blocked.ts` — one-step workflow wrapper, callable from a subscriber.
- `src/modules/ongoing/migrations/Migration<generated-timestamp>.ts` — generated in Task 3, not hand-written.

**Modify:**
- `src/modules/ongoing/models/order-sync.ts` — add 3 fields.
- `src/modules/ongoing/migrations/.snapshot-medusa-ongoing.json` — regenerated by Task 3.
- `src/workflows/index.ts` — export the new workflow.
- `src/subscribers/order-updated.ts` — call the new workflow at its one blocked-emit site (Task 4); optionally clear at its success site (Task 6).
- `src/subscribers/order-edit-confirmed.ts` — call the new workflow at its two blocked-emit sites (Task 5); optionally clear at its success site (Task 6).
- `src/subscribers/__tests__/order-updated.test.ts` — extend with new assertions (Task 4).
- `src/subscribers/__tests__/order-edit-confirmed.test.ts` — extend with new assertions + 2 new test cases (Task 5).

**Depends on (already exists, unmodified):**
- `src/modules/ongoing/index.ts` — `ONGOING_MODULE = "ongoing"`.
- `src/workflows/steps/gate-order-edit.ts` — `OrderEditCategory = "address_contact" | "line_items"` (reused, not redefined).

---

## Task 1: `markOrderSyncEditBlockedStep` (TDD)

Writes (or clears) `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` on a single `OngoingOrderSync` row. Pure write, no read-before-write (the subscribers already know the row id).

**Files:**
- Create: `src/workflows/steps/mark-order-sync-edit-blocked.ts`
- Test: `src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts`

**Interface:**
- Consumes: `ONGOING_MODULE` service `updateOngoingOrderSyncs(data: { id: string; [key: string]: unknown }): Promise<unknown>` (auto-CRUD, per `service.ts:19-22`).
- Produces: `export const markOrderSyncEditBlockedHandler = async (input: MarkEditBlockedInput, { container }: { container: any }): Promise<StepResponse<{ order_sync_id: string }>>` and `export const markOrderSyncEditBlockedStep = createStep("mark-order-sync-edit-blocked", markOrderSyncEditBlockedHandler)`.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts`:

```ts
import { markOrderSyncEditBlockedHandler } from "../mark-order-sync-edit-blocked"

describe("markOrderSyncEditBlockedStep", () => {
  it("sets edit_blocked_at/category/reason when blocked=true", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    const res = await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
      { container: { resolve: (_: string) => service } }
    )

    expect(updateOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.id).toBe("oos_1")
    expect(arg.edit_blocked_at).toBeInstanceOf(Date)
    expect(arg.edit_blocked_category).toBe("address_contact")
    expect(arg.edit_blocked_reason).toBe("status_blocked")
    expect(res.output).toEqual({ order_sync_id: "oos_1" })
  })

  it("clears edit_blocked_at/category/reason when blocked=false", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: false },
      { container: { resolve: (_: string) => service } }
    )

    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.edit_blocked_at).toBeNull()
    expect(arg.edit_blocked_category).toBeNull()
    expect(arg.edit_blocked_reason).toBeNull()
  })

  it("clears category/reason even if blocked=true is called without them (defensive)", async () => {
    const updateOngoingOrderSyncs = jest.fn().mockResolvedValue([{ id: "oos_1" }])
    const service = { updateOngoingOrderSyncs }

    await markOrderSyncEditBlockedHandler(
      { order_sync_id: "oos_1", blocked: true },
      { container: { resolve: (_: string) => service } }
    )

    const arg = updateOngoingOrderSyncs.mock.calls[0][0]
    expect(arg.edit_blocked_at).toBeInstanceOf(Date)
    expect(arg.edit_blocked_category).toBeNull()
    expect(arg.edit_blocked_reason).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts`
Expected: FAIL — `Cannot find module '../mark-order-sync-edit-blocked'` (the step file does not exist yet).

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/mark-order-sync-edit-blocked.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type { OrderEditCategory } from "./gate-order-edit"

export type MarkEditBlockedInput = {
  order_sync_id: string
  blocked: boolean
  category?: OrderEditCategory
  reason?: string
}

export const markOrderSyncEditBlockedHandler = async (
  input: MarkEditBlockedInput,
  { container }: { container: any }
): Promise<StepResponse<{ order_sync_id: string }>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as any

  await ongoing.updateOngoingOrderSyncs({
    id: input.order_sync_id,
    edit_blocked_at: input.blocked ? new Date() : null,
    edit_blocked_category: input.blocked ? (input.category ?? null) : null,
    edit_blocked_reason: input.blocked ? (input.reason ?? null) : null,
  })

  return new StepResponse({ order_sync_id: input.order_sync_id })
}

export const markOrderSyncEditBlockedStep = createStep(
  "mark-order-sync-edit-blocked",
  markOrderSyncEditBlockedHandler
)
```

Create `src/workflows/mark-order-sync-edit-blocked.ts`:

```ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  markOrderSyncEditBlockedStep,
  type MarkEditBlockedInput,
} from "./steps/mark-order-sync-edit-blocked"

export const markOrderSyncEditBlockedWorkflow = createWorkflow(
  "mark-order-sync-edit-blocked",
  function (input: MarkEditBlockedInput) {
    const result = markOrderSyncEditBlockedStep(input)
    return new WorkflowResponse(result)
  }
)

export default markOrderSyncEditBlockedWorkflow
export type { MarkEditBlockedInput } from "./steps/mark-order-sync-edit-blocked"
```

Update `src/workflows/index.ts` — append after the existing `upsertOngoingOrderEditStep` exports (after line 17):

```ts
export { markOrderSyncEditBlockedWorkflow } from "./mark-order-sync-edit-blocked"
export type { MarkEditBlockedInput } from "./steps/mark-order-sync-edit-blocked"
```

Notes the implementer must honour:
- **Step name `"mark-order-sync-edit-blocked"` reused for both the step and the workflow** — this is safe: `src/workflows/cancel-ongoing-order.ts:17` (`createWorkflow("cancel-ongoing-order", ...)`) and `src/workflows/steps/cancel-ongoing-order.ts:33-34` (`createStep("cancel-ongoing-order", ...)`) already share the identical string as an existing precedent in this repo (steps and workflows are separate Medusa registries).
- `OrderEditCategory` is **imported from `./gate-order-edit`**, not redefined — keeps the category union a single source of truth across the gate and this new step.
- No `transform()` needed in the workflow — the step takes `input` directly with no shape change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts`
Expected: PASS — all 3 cases.

---

## Task 2: Add fields to the `OngoingOrderSync` model (scaffolding, exempt from TDD)

**File:** `src/modules/ongoing/models/order-sync.ts`

Current tail (lines 19-22):

```ts
  shipped_at: model.dateTime().nullable(),
})

export default OngoingOrderSync
```

New tail:

```ts
  shipped_at: model.dateTime().nullable(),
  edit_blocked_at: model.dateTime().nullable(),
  edit_blocked_category: model.enum(["address_contact", "line_items"]).nullable(),
  edit_blocked_reason: model.text().nullable(),
})

export default OngoingOrderSync
```

- [ ] **Step 1: Edit the model**

Apply the change above. `edit_blocked_category`'s two literal values (`"address_contact"`, `"line_items"`) match `OrderEditCategory` in `src/workflows/steps/gate-order-edit.ts:4`.

- [ ] **Step 2: Verify with the TypeScript compiler (no dedicated unit test — pure data-shape change)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors (the model file has no logic to unit test; Task 1's step and Task 4/5's subscriber changes are what exercise these fields, and TDD there is what verifies field *names* actually match what production code writes).

---

## Task 3: Generate the migration and verify it against a live Postgres

**No dedicated unit test** (schema migration, exempt from TDD per the module-level exemption in the header) — verified instead by generating the migration, reading its generated SQL, and applying it end-to-end against a real throwaway Postgres (this is the step that actually proves the columns exist with the names/types the step in Task 1 writes to — a mocked unit test on `updateOngoingOrderSyncs` cannot catch a column-name/migration mismatch).

- [ ] **Step 1: Start a throwaway Postgres and generate the migration**

```bash
docker run -d --name ongoing-mig-pg -e POSTGRES_USER=medusa -e POSTGRES_PASSWORD=medusa -e POSTGRES_DB=medusa -p 5433:5432 postgres:16-alpine
docker exec ongoing-mig-pg createdb -U medusa "medusa-ongoing"
env -u PGHOST -u DATABASE_URL DB_HOST=127.0.0.1 DB_PORT=5433 DB_USERNAME=medusa DB_PASSWORD=medusa npx medusa plugin:db:generate
```

Expected: a new file `src/modules/ongoing/migrations/Migration<timestamp>.ts` is created (its `up()` should contain exactly 3 `alter table "ongoing_order_sync" add column ...` clauses — for `edit_blocked_at`, `edit_blocked_category`, `edit_blocked_reason` — and nothing else, since the pre-existing `.snapshot-medusa-ongoing.json` already captures every other column). `.snapshot-medusa-ongoing.json` is updated in place.

- [ ] **Step 2: Read the generated migration and confirm the column shapes**

Read the new migration file. Confirm (matching this repo's existing enum/nullable-column SQL shape from `Migration20260623211927.ts`, e.g. `"error_class" text check ("error_class" in ('retryable', 'terminal')) null` and `"shipped_at" timestamptz null`):
- `edit_blocked_at` → `timestamptz null` (no default, no not-null).
- `edit_blocked_category` → `text check ("edit_blocked_category" in ('address_contact', 'line_items')) null`.
- `edit_blocked_reason` → `text null`.

If the generated SQL differs from this shape (e.g. MikroORM batches multiple `ADD COLUMN` clauses into a single `alter table` statement instead of three), that is fine — the **column names, types, and check constraint** are what must match; the statement grouping is MikroORM's own generator output and is not something to hand-edit.

- [ ] **Step 3: Apply both migrations to the throwaway Postgres and verify the schema**

Apply migration 1 (the existing, already-committed `Migration20260623211927.ts` — this repo has no consuming Medusa app to run `db:migrate` against, so apply the SQL directly to prove the two migrations compose correctly in sequence):

```bash
docker exec -i ongoing-mig-pg psql -U medusa -d medusa-ongoing <<'SQL'
create table if not exists "ongoing_integration" ("id" text not null, "credential_key" text not null, "enabled" boolean not null default true, "stock_location_id" text not null, "stock_sync_enabled" boolean not null default true, "stock_sync_interval" text null, "status_poll_interval" text null, "stock_reconcile_mode" text check ("stock_reconcile_mode" in ('sellable_plus_reserved', 'precise', 'onhand')) not null default 'sellable_plus_reserved', "edit_sync_rules" jsonb null, "shipped_status_codes" jsonb null, "cancellable_status_codes" jsonb null, "last_stock_sync_at" timestamptz null, "last_status_poll_at" timestamptz null, "sync_lock_until" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ongoing_integration_pkey" primary key ("id"));
create table if not exists "ongoing_order_sync" ("id" text not null, "integration_id" text not null, "medusa_order_id" text not null, "medusa_fulfillment_id" text null, "ongoing_order_number" text not null, "ongoing_order_id" integer null, "latest_status_code" integer null, "latest_status_text" text null, "sync_state" text check ("sync_state" in ('pending', 'sent', 'shipped', 'cancelled', 'error')) not null default 'pending', "error_class" text check ("error_class" in ('retryable', 'terminal')) null, "last_synced_at" timestamptz null, "last_error" text null, "retry_count" integer not null default 0, "shipped_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ongoing_order_sync_pkey" primary key ("id"));
SQL
```

Then apply migration 2: copy every `this.addSql(...)` string out of the newly generated `Migration<timestamp>.ts`'s `up()` method (from Task 3 Step 1) and run each one via the same `docker exec -i ongoing-mig-pg psql -U medusa -d medusa-ongoing` pattern.

Verify the schema:

```bash
docker exec ongoing-mig-pg psql -U medusa -d medusa-ongoing -c '\d ongoing_order_sync'
```

Expected: `edit_blocked_at` (`timestamp with time zone`, nullable), `edit_blocked_category` (`text`, nullable, with a `CHECK` constraint visible), `edit_blocked_reason` (`text`, nullable) all present.

- [ ] **Step 4: Round-trip an insert/update/select to prove writes and the check constraint work**

```bash
docker exec ongoing-mig-pg psql -U medusa -d medusa-ongoing -c "
insert into ongoing_order_sync (id, integration_id, medusa_order_id, ongoing_order_number)
values ('oos_verify_1', 'int_verify_1', 'order_verify_1', 'ORD-VERIFY-1');
update ongoing_order_sync
set edit_blocked_at = now(), edit_blocked_category = 'address_contact', edit_blocked_reason = 'status_blocked'
where id = 'oos_verify_1';
select id, edit_blocked_at, edit_blocked_category, edit_blocked_reason from ongoing_order_sync where id = 'oos_verify_1';
"
```

Expected: the `select` returns the row with `edit_blocked_at` populated, `edit_blocked_category = 'address_contact'`, `edit_blocked_reason = 'status_blocked'`. Then confirm the check constraint rejects an invalid category:

```bash
docker exec ongoing-mig-pg psql -U medusa -d medusa-ongoing -c "
update ongoing_order_sync set edit_blocked_category = 'not_a_real_category' where id = 'oos_verify_1';
"
```

Expected: this statement **fails** with a `check constraint ... violated` error (psql prints `ERROR:  new row for relation "ongoing_order_sync" violates check constraint ...`) — proving the enum constraint from Task 3 Step 2 is real, not just present in the model's TypeScript type.

- [ ] **Step 5: Tear down and commit**

```bash
docker rm -f ongoing-mig-pg
git add src/modules/ongoing/migrations/
```

(Do not commit yet — commit happens once in Task 7 alongside every other file this plan touches.)

---

## Task 4: Wire `order-updated.ts` to write the blocked state (TDD)

**Files:**
- Modify: `src/subscribers/order-updated.ts`
- Modify: `src/subscribers/__tests__/order-updated.test.ts`

**Interface:**
- Consumes: `markOrderSyncEditBlockedWorkflow` from `../workflows/mark-order-sync-edit-blocked` — `markOrderSyncEditBlockedWorkflow(container).run({ input: MarkEditBlockedInput }): Promise<{ result: { order_sync_id: string } }>`.

- [ ] **Step 1: Write the failing tests**

Edit `src/subscribers/__tests__/order-updated.test.ts`. Add the import and mock (after line 2, alongside the existing `syncOrderEditToOngoing` mock):

```ts
import orderUpdatedHandler from "../order-updated"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../../workflows/mark-order-sync-edit-blocked"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))
jest.mock("../../workflows/mark-order-sync-edit-blocked", () => ({
  markOrderSyncEditBlockedWorkflow: jest.fn(),
}))

const runMock = jest
  .fn()
  .mockResolvedValue({ result: { synced: true, blocked: false, reason: "allowed" } })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

const markBlockedRunMock = jest.fn().mockResolvedValue({ order_sync_id: "oos_1" })
;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
```

Update the `beforeEach` (currently lines 74-77) to also reset the new mock:

```ts
beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
  ;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
})
```

Extend the existing `"emits a warning event and does not re-sync when status is blocked"` test (currently lines 125-144) with the new assertion:

```ts
  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emit } = makeContainer({
      detailTypes: ["billing_address"],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 999, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // 999 not allowed
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 999,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })
```

Extend the existing `"blocks and emits a warning when latest_status_code is unknown (null)"` test (currently lines 146-167) with:

```ts
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_unknown" },
    })
```

Extend the existing `"blocks and emits a warning when the integration has no address_contact rules"` test (currently lines 169-188 — **note**: despite the test's title, `editSyncRules: { int_1: {} }` means the integration's `edit_sync_rules` object is present-but-empty, which is truthy, so per the precedence in `decideOrderEditGate` this resolves to `"status_blocked"`, not `"no_edit_rules"` — `"no_edit_rules"` only fires when `edit_sync_rules` is `null`/absent at the integration level) with:

```ts
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: FAIL on the 3 new `expect(markBlockedRunMock)...` assertions (`markOrderSyncEditBlockedWorkflow` never called — production code doesn't call it yet).

- [ ] **Step 3: Implement the subscriber change**

Edit `src/subscribers/order-updated.ts`. Add the import (after line 4):

```ts
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../workflows/mark-order-sync-edit-blocked"
```

Replace the `if (!allowed) { ... continue }` block (currently lines 123-137):

```ts
        if (!allowed) {
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await eventBus.emit({
            name: "ongoing.sync.edit_blocked",
            data: {
              medusa_order_id: orderId,
              ongoing_order_sync_id: row.id,
              category: "address_contact",
              latest_status_code: code,
            },
          })
          continue
        }
```

with:

```ts
        if (!allowed) {
          // Mirrors gate-order-edit.ts's decideOrderEditGate reason precedence
          // (no_edit_rules checked before status_unknown before status_blocked)
          // so the persisted reason vocabulary matches #27's gate exactly (#91).
          const reason = !rules
            ? "no_edit_rules"
            : code === null || code === undefined
              ? "status_unknown"
              : "status_blocked"

          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await eventBus.emit({
            name: "ongoing.sync.edit_blocked",
            data: {
              medusa_order_id: orderId,
              ongoing_order_sync_id: row.id,
              category: "address_contact",
              latest_status_code: code,
            },
          })
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: {
              order_sync_id: row.id,
              blocked: true,
              category: "address_contact",
              reason,
            },
          })
          continue
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: PASS — all cases including the 3 new assertions.

---

## Task 5: Wire `order-edit-confirmed.ts` to write the blocked state (TDD)

**Files:**
- Modify: `src/subscribers/order-edit-confirmed.ts`
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts`

This subscriber has **two** blocked branches (pre-check and post-workflow), unlike `order-updated.ts`'s one.

- [ ] **Step 1: Write the failing tests**

Edit `src/subscribers/__tests__/order-edit-confirmed.test.ts`. Add the import and mock (after line 2):

```ts
import orderEditConfirmedHandler from "../order-edit-confirmed"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../../workflows/mark-order-sync-edit-blocked"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))
jest.mock("../../workflows/mark-order-sync-edit-blocked", () => ({
  markOrderSyncEditBlockedWorkflow: jest.fn(),
}))

const runMock = jest.fn().mockResolvedValue({ result: {} })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

const markBlockedRunMock = jest.fn().mockResolvedValue({ order_sync_id: "oos_1" })
;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
```

Update the `beforeEach` (currently lines 56-59):

```ts
beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
  ;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
})
```

Extend the existing `"emits a warning event and does not re-sync when status is blocked"` test (currently lines 108-128) with:

```ts
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_blocked" },
    })
```

Extend the existing `"emits edit_blocked when the workflow itself returns blocked (no false success)"` test (currently lines 184-206) with:

```ts
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_blocked" },
    })
```

Add two new test cases (after the `"emits edit_blocked when the workflow itself returns blocked"` case, before the closing `})` of the `describe` block) to exercise the other two reason branches — `order-edit-confirmed.ts`'s existing fixtures never cover `null` status or an absent `edit_sync_rules`, so these are new coverage, not duplicates of `order-updated.test.ts`'s equivalents:

```ts
  it("marks edit_blocked with reason 'no_edit_rules' when the integration has no edit_sync_rules at all", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: null } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "no_edit_rules" },
    })
  })

  it("marks edit_blocked with reason 'status_unknown' when latest_status_code is null", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: null },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_unknown" },
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: FAIL — the 2 extended assertions fail (`markBlockedRunMock` never called) and the 2 new test cases fail for the same reason.

- [ ] **Step 3: Implement the subscriber change**

Edit `src/subscribers/order-edit-confirmed.ts`. Add the import (after line 4):

```ts
import { syncOrderEditToOngoing } from "../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../workflows/mark-order-sync-edit-blocked"
```

Replace the pre-check `if (!allowed) { ... continue }` block (currently lines 100-106):

```ts
        if (!allowed) {
          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await emitBlocked(row)
          continue
        }
```

with:

```ts
        if (!allowed) {
          // Mirrors gate-order-edit.ts's decideOrderEditGate reason precedence
          // (matches order-updated.ts's derivation exactly — #91).
          const reason = !rules
            ? "no_edit_rules"
            : code === null || code === undefined
              ? "status_unknown"
              : "status_blocked"

          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items edit blocked for sync ${row.id} (status ${code ?? "unknown"} not in [${allowedCodes.join(", ")}])`
          )
          await emitBlocked(row)
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: { order_sync_id: row.id, blocked: true, category: "line_items", reason },
          })
          continue
        }
```

Replace the post-workflow `if (result?.blocked) { ... continue }` block (currently lines 120-126):

```ts
        if (result?.blocked) {
          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items re-sync blocked by workflow for sync ${row.id} (reason: ${result.reason})`
          )
          await emitBlocked(row)
          continue
        }
```

with:

```ts
        if (result?.blocked) {
          logger.warn(
            `[ongoing] order-edit.confirmed for ${orderId}: line_items re-sync blocked by workflow for sync ${row.id} (reason: ${result.reason})`
          )
          await emitBlocked(row)
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: {
              order_sync_id: row.id,
              blocked: true,
              category: "line_items",
              reason: result.reason ?? "status_blocked",
            },
          })
          continue
        }
```

Note: `result.reason` here is `decideOrderEditGate`'s own machine reason string (per `sync-order-edit-to-ongoing.ts:22-28`), so it is used directly rather than re-derived — it is authoritative (the gate re-checked against the latest snapshot).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: PASS — all cases including the 2 extended assertions and 2 new test cases.

---

## Task 6 (optional — beyond the issue's literal text; drop at the gated commit if not wanted): clear the blocked state on a successful re-sync

The issue text says only "write those fields from the subscriber path" — it does not ask for clearing. Without this task, once a row is marked blocked it stays blocked forever in the data, even after a later edit successfully re-syncs (e.g. status moves into the allowed range and the same category is edited again). This task closes that gap by clearing the 3 fields at each subscriber's own "re-synced successfully" log site — **not** inside the shared `upsertOngoingOrderEditStep` (`src/workflows/steps/upsert-ongoing-order-edit.ts`), which has no existing unit test and pulls in several other collaborators (`reQueryFulfillmentOrder`, `resolveArticleNumber`, `mapOrderToPostOrderModel`) that this plan does not want to newly test just to add a field clear. Keeping the clear at the subscriber level reuses the exact same `markOrderSyncEditBlockedWorkflow` mock already wired in Tasks 4/5.

**Files:**
- Modify: `src/subscribers/order-updated.ts`
- Modify: `src/subscribers/order-edit-confirmed.ts`
- Modify: `src/subscribers/__tests__/order-updated.test.ts`
- Modify: `src/subscribers/__tests__/order-edit-confirmed.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing `"re-syncs each sync row with category address_contact when status is allowed"` test in `src/subscribers/__tests__/order-updated.test.ts` (currently lines 80-109) with:

```ts
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_2", blocked: false },
    })
```

Extend the existing `"re-syncs each sync row with category line_items when status is allowed"` test in `src/subscribers/__tests__/order-edit-confirmed.test.ts` (currently lines 62-90) with:

```ts
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_2", blocked: false },
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: FAIL on the 4 new assertions (production code doesn't clear yet).

- [ ] **Step 3: Implement the clear**

In `src/subscribers/order-updated.ts`, replace the `if (result?.synced) { ... } else { ... }` block (post-Task-4, still at the same location relative to the edited file):

```ts
        if (result?.synced) {
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
        } else {
```

with:

```ts
        if (result?.synced) {
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: { order_sync_id: row.id, blocked: false },
          })
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
        } else {
```

In `src/subscribers/order-edit-confirmed.ts`, replace the final success log (post-Task-5, still the last statement in the `try` block before its `catch`):

```ts
        logger.info(
          `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
        )
```

with:

```ts
        await markOrderSyncEditBlockedWorkflow(container).run({
          input: { order_sync_id: row.id, blocked: false },
        })
        logger.info(
          `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: PASS — all cases including the 4 new assertions.

---

## Task 7: Final verification and commit

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: all suites pass, including the new `mark-order-sync-edit-blocked.test.ts` and the extended `order-updated.test.ts` / `order-edit-confirmed.test.ts`.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: `medusa lint` reports no errors on the new/modified files.

- [ ] **Step 3: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `yarn build`
Expected: `medusa plugin:build` succeeds — `.medusa/server` includes the new step/workflow and the updated model + migration.

- [ ] **Step 4: Confirm the live-DB verification from Task 3 was actually run**

This is the check a green `yarn test`/`yarn build` cannot substitute for (both mock or ignore the DB layer — see the header note on Task 3). Confirm Task 3 Steps 3-4 were executed against a real throwaway Postgres in this session and the check-constraint rejection was observed, not skipped.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/mark-order-sync-edit-blocked.ts \
        src/workflows/steps/__tests__/mark-order-sync-edit-blocked.test.ts \
        src/workflows/mark-order-sync-edit-blocked.ts \
        src/workflows/index.ts \
        src/modules/ongoing/models/order-sync.ts \
        src/modules/ongoing/migrations/ \
        src/subscribers/order-updated.ts \
        src/subscribers/order-edit-confirmed.ts \
        src/subscribers/__tests__/order-updated.test.ts \
        src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "feat(ongoing-order-sync): persist edit-blocked state (model field + migration + subscriber write) (#91)"
```

---

## Self-Review (completed during planning)

- **Issue scope honoured literally:** 3 fields (`edit_blocked_at`, `edit_blocked_category`, `edit_blocked_reason`) added to `OngoingOrderSync`, migration generated via `npx medusa plugin:db:generate`, both subscribers write from their existing `ongoing.sync.edit_blocked` emit sites. No widget/UI code touched (`src/admin/**` untouched).
- **#42 field-name conflict checked, not assumed:** #42's plan (`docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md:8,18,22`, read in full) explicitly defers surfacing and renders **no** edit-blocked field at all today — there is no existing name to collide with. The circular "surfacing is the other plan's job" between #42 and #91 is called out explicitly in the Out-of-Scope section with a concrete hand-off action (open a follow-up issue) rather than left implicit.
- **Mutations-only-via-workflows rule honoured:** neither subscriber calls `updateOngoingOrderSyncs` directly; both call `markOrderSyncEditBlockedWorkflow(container).run({ input })`, mirroring the exact `order-canceled.ts` → `cancelOngoingOrderWorkflow` → `markOrderSyncCancelledStep` precedent (`src/subscribers/order-canceled.ts`, `src/workflows/cancel-ongoing-order.ts:1-37`).
- **Reason vocabulary verified against a real edge case in the existing test suite, not invented:** the `editSyncRules: { int_1: {} }` fixture at `src/subscribers/__tests__/order-updated.test.ts:169-188` resolves to `"status_blocked"` (not `"no_edit_rules"`) under this plan's precedence, matching `decideOrderEditGate`'s actual behavior (`gate-order-edit.ts:72-76`) — this was checked against the gate's real precedence, not assumed from the test's misleading title.
- **The "green build/tests prove persistence" trap is explicitly called out and closed:** Task 3 Steps 3-4 apply the real generated SQL to a real throwaway Postgres and prove both the column write and the check-constraint rejection, because the unit test (Task 1) mocks `updateOngoingOrderSyncs` and `yarn build` never type-checks that mock's `any`-typed argument against the model.
- **Task 6 is explicitly optional and separated**, not silently folded into the required scope — the issue text does not ask for clearing, and the plan states the exact reason (a write-only flag is a half-feature) and the exact reason it was NOT implemented inside `upsertOngoingOrderEditStep` (untested, heavier surface area).
- **No forbidden tokens** — every code block is complete (no `TODO`/`TBD`/`FIXME`); Task 3's "SQL grouping may differ" note is a call-out about MikroORM's own generator output shape, not an unresolved plan gap.
- **Real test commands throughout**, matching this repo's exact `yarn test <path>` substring-match convention (verified against `docs/superpowers/plans/2026-06-28-order-updated-subscriber-54.md` and `2026-06-28-order-edit-subscriber-31.md`'s own invocations of the same two test files).

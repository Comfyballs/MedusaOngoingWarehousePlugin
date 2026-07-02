# Clear edit-blocked state on successful re-sync (#103) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is business logic (an event-driven DB-mutation call gated on state) and follows superpowers:test-driven-development — a failing test precedes each implementation step.

**Goal:** When a sync row that is currently edit-blocked re-syncs successfully, null its `edit_blocked_*` fields (via the existing `markOrderSyncEditBlockedWorkflow` with `blocked: false`) so the #93 order-widget "Edit blocked" banner clears instead of sticking permanently.

**Architecture:** Reuse #91's existing `markOrderSyncEditBlockedWorkflow` / `markOrderSyncEditBlockedStep` unchanged — the step already nulls all three columns when called with `blocked: false`. Add a guarded clear call on the success branch of each of the two edit-re-sync subscribers (`order-updated.ts`, `order-edit-confirmed.ts`). The call is guarded on `row.edit_blocked_at` so a successful re-sync of a never-blocked row issues no DB write. No new workflow, step, model field, migration, or event.

**Tech Stack:** Medusa 2.16.0, TypeScript 5.6 (`Node16` module resolution, decorators enabled — root `tsconfig.json`), yarn 4.6.0, Node >= 20, Jest (`@swc/jest`, `testEnvironment: "node"`, `clearMocks: true`).

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6**; yarn **4.6.0**; Node **>= 20**.
- **Mutations only via workflows** (`medusa-dev:building-with-medusa` `arch-workflow-required`): the clear goes through `markOrderSyncEditBlockedWorkflow(container).run(...)`, never a direct `updateOngoingOrderSyncs` call from the subscriber.
- **Subscribers never throw** (spec §8; `docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:245`): the new call goes **inside the existing per-row `try` block**, so any throw is caught by the existing per-row `catch` and never aborts the subscriber — identical placement to the existing blocked-path `markOrderSyncEditBlockedWorkflow` calls.
- **No new imports:** `markOrderSyncEditBlockedWorkflow` is already imported in both subscribers (`order-updated.ts:5`, `order-edit-confirmed.ts:5`).
- **Clear call shape:** `{ order_sync_id: row.id, blocked: false }` only — `markOrderSyncEditBlockedStep` ignores `category`/`reason` on the `blocked: false` path (`src/workflows/steps/mark-order-sync-edit-blocked.ts:19-23`).
- **Test command:** `yarn test <path-substring>` (Jest substring match); full suite `yarn test`.
- **Coordination note (no code impact):** #94 (unimplemented at plan time) modifies `order-updated.ts`'s post-workflow `else` branch (`if (result?.synced) {…} else {…}` → adds an `else if (result?.blocked)`). This plan modifies only the **body of the `if (result?.synced)` branch**. The two changes are on adjacent but non-overlapping lines; whichever merges second rebases trivially. This plan is written against the current committed state (both #93 and #94 unimplemented).

---

## File Structure

**Modify (Task 1 — order.updated):**
- `src/subscribers/order-updated.ts` — widen `OngoingOrderSyncRow` type + `listOngoingOrderSyncs` `select` with `edit_blocked_at`; add guarded clear in the `if (result?.synced)` branch.
- `src/subscribers/__tests__/order-updated.test.ts` — widen the `makeContainer` `syncRows` fixture type; add two test cases.

**Modify (Task 2 — order-edit.confirmed):**
- `src/subscribers/order-edit-confirmed.ts` — widen local `OngoingOrderSyncRow` type with `edit_blocked_at`; add guarded clear in the trailing success `logger.info` branch.
- `src/subscribers/__tests__/order-edit-confirmed.test.ts` — widen the `makeContainer` `syncRows` fixture type; add two test cases.

**Depends on (already exists, unmodified):**
- `src/workflows/mark-order-sync-edit-blocked.ts` — `markOrderSyncEditBlockedWorkflow`.
- `src/workflows/steps/mark-order-sync-edit-blocked.ts` — nulls the three fields on `blocked: false`.
- `src/modules/ongoing/models/order-sync.ts` — the `edit_blocked_*` columns (#91).

---

## Task 1: Clear edit-blocked state on success in `order-updated.ts` (TDD)

**Files:**
- Modify: `src/subscribers/order-updated.ts`
- Test: `src/subscribers/__tests__/order-updated.test.ts`

**Interfaces:**
- Consumes: `markOrderSyncEditBlockedWorkflow` (already imported, `order-updated.ts:5`) — called as `markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id: string, blocked: boolean } })`.
- Produces: no new exported symbols. `orderUpdatedHandler` (default export) keeps its signature `async ({ event, container }: SubscriberArgs<{ id: string }>): Promise<void>`. Internal behavior change only: on a successful re-sync (`result?.synced`) of a row whose `edit_blocked_at` is truthy, it additionally calls the clear workflow with `{ order_sync_id: row.id, blocked: false }`.

- [ ] **Step 1: Widen the test fixture type**

In `src/subscribers/__tests__/order-updated.test.ts`, extend the `makeContainer` `syncRows` element type (currently lines 27-32) to allow the field the guard reads. Change:

```ts
  syncRows: Array<{
    id: string
    integration_id: string
    latest_status_code: number | null
    medusa_fulfillment_id: string | null
  }>
```

to:

```ts
  syncRows: Array<{
    id: string
    integration_id: string
    latest_status_code: number | null
    medusa_fulfillment_id: string | null
    edit_blocked_at?: string | Date | null
  }>
```

(Optional field — every existing test omits it, so it is `undefined` there and the new guard stays falsy, leaving all existing assertions unaffected.)

- [ ] **Step 2: Write the failing tests**

In `src/subscribers/__tests__/order-updated.test.ts`, add two test cases inside the existing `describe("order.updated subscriber — address/contact re-sync", …)` block (after the existing `it("re-syncs each sync row…")` test that ends at line 117):

```ts
  it("clears edit-blocked state after a successful re-sync of a previously-blocked row", async () => {
    const { container } = makeContainer({
      detailTypes: ["shipping_address"],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    // runMock's default resolves { synced: true, blocked: false } (test file line 14)
    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).toHaveBeenCalledTimes(1)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
  })

  it("does not clear edit-blocked state when the row was not blocked", async () => {
    const { container } = makeContainer({
      detailTypes: ["shipping_address"],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: null,
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: the first new test FAILS — `markBlockedRunMock` is not called on the success path today (the `if (result?.synced)` branch only logs). The second new test passes vacuously. Other pre-existing tests still pass.

- [ ] **Step 4: Widen the row type and `select` in the subscriber**

In `src/subscribers/order-updated.ts`, add `edit_blocked_at` to the local `OngoingOrderSyncRow` type (currently lines 18-23):

```ts
type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  latest_status_code: number | null
  medusa_fulfillment_id: string | null
  edit_blocked_at: string | Date | null
}
```

Then add `"edit_blocked_at"` to the `listOngoingOrderSyncs` `select` array (currently lines 81-86):

```ts
        select: [
          "id",
          "integration_id",
          "latest_status_code",
          "medusa_fulfillment_id",
          "edit_blocked_at",
        ],
```

- [ ] **Step 5: Add the guarded clear in the success branch**

In `src/subscribers/order-updated.ts`, replace the success branch (currently lines 172-175):

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
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
          // Clear a stale edit-blocked flag now that the edit re-synced. Guarded
          // on edit_blocked_at so never-blocked rows take no DB write. The step
          // nulls all three edit_blocked_* fields on blocked:false (#91). (#103)
          if (row.edit_blocked_at) {
            await markOrderSyncEditBlockedWorkflow(container).run({
              input: { order_sync_id: row.id, blocked: false },
            })
          }
        } else {
```

(The `else { logger.warn(...) }` branch below is unchanged. No import changes.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: PASS — both new tests plus all pre-existing tests in the file.

- [ ] **Step 7: Commit**

```bash
git add src/subscribers/order-updated.ts src/subscribers/__tests__/order-updated.test.ts
git commit -m "fix(ongoing): clear edit-blocked state on successful re-sync in order-updated (#103)"
```

---

## Task 2: Clear edit-blocked state on success in `order-edit-confirmed.ts` (TDD)

**Files:**
- Modify: `src/subscribers/order-edit-confirmed.ts`
- Test: `src/subscribers/__tests__/order-edit-confirmed.test.ts`

**Interfaces:**
- Consumes: `markOrderSyncEditBlockedWorkflow` (already imported, `order-edit-confirmed.ts:5`) — called as `markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id: string, blocked: boolean } })`.
- Produces: no new exported symbols. `orderEditConfirmedHandler` (default export) keeps its signature. Internal behavior change only: on the success path (reached after the `if (result?.blocked) { … continue }` guard) of a row whose `edit_blocked_at` is truthy, it additionally calls the clear workflow with `{ order_sync_id: row.id, blocked: false }`.

- [ ] **Step 1: Widen the test fixture type**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, extend the `makeContainer` `syncRows` element type (currently lines 22-27) with the field the guard reads. Change:

```ts
  syncRows: Array<{
    id: string
    medusa_fulfillment_id: string | null
    integration_id: string
    latest_status_code: number | null
  }>
```

to:

```ts
  syncRows: Array<{
    id: string
    medusa_fulfillment_id: string | null
    integration_id: string
    latest_status_code: number | null
    edit_blocked_at?: string | Date | null
  }>
```

- [ ] **Step 2: Write the failing tests**

In `src/subscribers/__tests__/order-edit-confirmed.test.ts`, add two test cases inside the existing `describe("order-edit.confirmed subscriber — line_items re-sync", …)` block (after the existing `it("re-syncs each sync row…")` test that ends at line 98):

```ts
  it("clears edit-blocked state after a successful re-sync of a previously-blocked row", async () => {
    const { container } = makeContainer({
      syncRows: [
        {
          id: "oos_1",
          medusa_fulfillment_id: "ful_1",
          integration_id: "int_1",
          latest_status_code: 100,
          edit_blocked_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    // runMock's default resolves { result: {} } (test file line 12): blocked is
    // falsy, so the handler takes the success path.
    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(markBlockedRunMock).toHaveBeenCalledTimes(1)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
  })

  it("does not clear edit-blocked state when the row was not blocked", async () => {
    const { container } = makeContainer({
      syncRows: [
        {
          id: "oos_1",
          medusa_fulfillment_id: "ful_1",
          integration_id: "int_1",
          latest_status_code: 100,
          edit_blocked_at: null,
        },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(markBlockedRunMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: the first new test FAILS — `markBlockedRunMock` is not called on the success path today (the trailing `logger.info` only logs). The second new test passes vacuously. Other pre-existing tests still pass.

- [ ] **Step 4: Widen the row type in the subscriber**

In `src/subscribers/order-edit-confirmed.ts`, add `edit_blocked_at` to the local `OngoingOrderSyncRow` type (currently lines 22-27):

```ts
type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  integration_id: string
  latest_status_code: number | null
  edit_blocked_at: string | Date | null
}
```

(This subscriber's `listOngoingOrderSyncs` call passes no `select`, so all scalar fields — including `edit_blocked_at` — already return at runtime; only the TypeScript type needs the field. Do not add a `select`.)

- [ ] **Step 5: Add the guarded clear in the success branch**

In `src/subscribers/order-edit-confirmed.ts`, replace the trailing success log (currently lines 149-151):

```ts
        logger.info(
          `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
        )
```

with:

```ts
        logger.info(
          `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
        )
        // Clear a stale edit-blocked flag now that the edit re-synced. Guarded
        // on edit_blocked_at so never-blocked rows take no DB write. The step
        // nulls all three edit_blocked_* fields on blocked:false (#91). (#103)
        if (row.edit_blocked_at) {
          await markOrderSyncEditBlockedWorkflow(container).run({
            input: { order_sync_id: row.id, blocked: false },
          })
        }
```

(This sits inside the existing per-row `try` block, before its `catch (error)` at line 152. No import changes.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test src/subscribers/__tests__/order-edit-confirmed.test.ts`
Expected: PASS — both new tests plus all pre-existing tests in the file.

- [ ] **Step 7: Commit**

```bash
git add src/subscribers/order-edit-confirmed.ts src/subscribers/__tests__/order-edit-confirmed.test.ts
git commit -m "fix(ongoing): clear edit-blocked state on successful re-sync in order-edit-confirmed (#103)"
```

---

## Task 3: Full verification before review

No new code — run the full gates and confirm green.

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: PASS — all suites green, in particular both `order-updated.test.ts` and `order-edit-confirmed.test.ts` with their new cases, and no regression elsewhere.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: PASS — `medusa lint` (eslint flat config, `@medusajs/eslint-plugin recommended`) reports no errors on the modified files.

- [ ] **Step 3: Build**

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles both subscribers to `.medusa/server` with no type errors (the `row.edit_blocked_at` access is typed by the widened `OngoingOrderSyncRow` in each file).

- [ ] **Step 4: Confirm the diff scope**

Verify the working tree touches only the four files above (two subscribers + two test files), with no changes to the model, migration, workflow/step, `ONGOING_EVENTS`, or the widget. Per `CLAUDE.md` ("Code review before merging"), the reviewer must independently load `medusa-dev:building-with-medusa` before merge.

---

## Self-Review (completed during planning)

- **Spec coverage:** every spec section maps to a task. Goal + conditional-clear approach → Tasks 1-2. Touch point "order-updated.ts (success branch + select + type)" → Task 1. Touch point "order-edit-confirmed.ts (success branch + type, no select)" → Task 2. Testing (clears-when-blocked + no-op-when-not-blocked, per subscriber) → Task 1 Step 2 and Task 2 Step 2. Out-of-scope items (blocked branches, model/migration/event/widget, central step no-op, adding a select to order-edit-confirmed) are respected — no task touches them.
- **Placeholder scan:** no `TODO`/`TBD`/`FIXME`/`<...>`/`XXX`; every code step shows complete code; every command has expected output.
- **Type consistency:** the clear call shape `{ order_sync_id: row.id, blocked: false }` is identical across both subscribers and both test assertions; the widened `OngoingOrderSyncRow` adds the same `edit_blocked_at` field in both subscribers and both fixtures; `markBlockedRunMock` is the existing mock in both test files (reset in each file's `beforeEach`).
- **Guard correctness:** the guard reads `row.edit_blocked_at`; Task 1 adds it to the explicit `select` (required — order-updated fetches with a `select`), Task 2 relies on the no-`select` list call already returning it (only the type is widened). Both verified against the current files.
- **Never-throw:** both clear calls sit inside the existing per-row `try` blocks (order-updated.ts:117-188; order-edit-confirmed.ts inner try ending at the `catch` on line 152), preserving spec §8.

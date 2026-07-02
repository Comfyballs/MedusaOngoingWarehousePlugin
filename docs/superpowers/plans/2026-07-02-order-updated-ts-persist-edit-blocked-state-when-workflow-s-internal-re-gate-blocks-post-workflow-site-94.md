# order-updated.ts: persist edit-blocked state when workflow's internal re-gate blocks (post-workflow site) (#94)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan. Checkboxes (`- [ ]`) track progress. This plan has one task and follows `superpowers:test-driven-development` (failing test first) — the change is business logic (an event-emit + a workflow-mutation call), not scaffolding.

**Goal:** `src/subscribers/order-updated.ts`'s post-workflow branch (its second, and only other, `syncOrderEditToOngoing` call site — the first being the pre-check) currently does nothing when the workflow's own internal re-gate (`gateOrderEditStep`, run inside `syncOrderEditToOngoing`) blocks the re-sync: it only logs a warning. `src/subscribers/order-edit-confirmed.ts`'s equivalent post-workflow branch already emits `ongoing.sync.edit_blocked` and calls `markOrderSyncEditBlockedWorkflow` when `result?.blocked` is true. This plan mirrors that exact branch into `order-updated.ts`, closing the gap left by #91 (which only wired *pre-existing* emit sites, and `order-updated.ts` never had a post-workflow emit site to wire).

**Out of scope (explicitly, do not implement here):**
- `src/subscribers/order-edit-confirmed.ts` — both its blocked-emit sites (pre-check and post-workflow) are already wired by #91. This plan does not touch that file.
- Clearing `edit_blocked_at`/`edit_blocked_category`/`edit_blocked_reason` on a later successful re-sync ("clear-on-success"). That was #91's explicitly optional Task 6 and was not implemented for either subscriber; this plan does not implement it either. The `if (result?.synced)` branch in `order-updated.ts` stays a plain `logger.info(...)`, unchanged.
- `src/workflows/sync-order-edit-to-ongoing.ts`, `src/workflows/steps/gate-order-edit.ts`, `src/workflows/steps/upsert-ongoing-order-edit.ts`, `src/workflows/mark-order-sync-edit-blocked.ts`, `src/workflows/steps/mark-order-sync-edit-blocked.ts` — all read for their existing contracts, none modified.
- `order-updated.ts`'s pre-check blocked branch (lines 125–156) — already wired by #91, unchanged.

---

## Research already read (cited, load-bearing)

- **`src/subscribers/order-updated.ts`** (full file read, 200 lines, this worktree's current state — #91 already merged here as commit `f55145e`). The pre-check blocked branch (lines 125–156) already calls `eventBus.emit({ name: ONGOING_EVENTS.EDIT_BLOCKED, ... })` and `markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id, blocked: true, category: "address_contact", reason } })`. The **post-workflow branch** (lines 158–180, inside the same per-row `try` block that starts at line 117 and is caught by the `rowError` catch at line 181) is:
  ```ts
  const { result } = await syncOrderEditToOngoing(container).run({
    input: {
      medusa_order_id: orderId,
      order_sync_id: row.id,
      medusa_fulfillment_id: row.medusa_fulfillment_id ?? null,
      category: "address_contact",
    },
  })

  // The workflow re-gates internally (gateOrderEditStep). Report what it
  // actually did rather than assuming success, so the log never lies if the
  // workflow's own gate blocked (e.g. status changed between query and gate).
  if (result?.synced) {
    logger.info(
      `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
    )
  } else {
    logger.warn(
      `[ongoing] order.updated for ${orderId}: address_contact re-sync not applied for sync ${row.id} (workflow: ${result?.reason ?? "unknown"})`
    )
  }
  ```
  This branch never emits `ONGOING_EVENTS.EDIT_BLOCKED` and never calls `markOrderSyncEditBlockedWorkflow` — this is the gap #94 closes. `code` (`= row.latest_status_code`, declared at line 120) and `eventBus` (resolved at line 111) are both already in scope at this point in the row loop.
  Imports already present at the top of the file (lines 1–6): `markOrderSyncEditBlockedWorkflow` from `../workflows/mark-order-sync-edit-blocked` and `ONGOING_EVENTS` from `../lib/ongoing/events` — **no new imports are needed.**

- **`src/subscribers/order-edit-confirmed.ts`** (full file read, 172 lines, this worktree's current state). Its post-workflow branch (lines 121–147, the file's second and last blocked-emit site) is the exact mirror target:
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

  logger.info(
    `[ongoing] order-edit.confirmed for ${orderId}: re-synced line_items edit for sync ${row.id}`
  )
  ```
  **Condition decision:** the sibling checks `result?.blocked` (not `!result?.synced`). This plan uses the same condition, `result?.blocked`, for `order-updated.ts` — mirroring the sibling exactly, as instructed. This is also semantically sound on inspection of the workflow itself (see next bullet): `blocked` and `!synced` are equivalent in every non-throwing path, so there is no behavioral difference, but `result?.blocked` is the literal pattern to copy.
  Structural difference kept intentionally: `order-edit-confirmed.ts`'s branch has no `else` beyond the top-level `if (result?.blocked) { ...; continue }` followed by an unconditional success log — it assumes "not blocked" implies "synced". `order-updated.ts` currently has an explicit `if (result?.synced) {...} else {...}` structure with a defensive "unknown" warning for any other combination. This plan preserves that extra defensive branch (see Task 1) rather than deleting it, changing the shape to `if (synced) {...} else if (blocked) {...} else {...}` — strictly additive, no existing behavior removed.

- **`src/workflows/sync-order-edit-to-ongoing.ts:5-33`** — `SyncOrderEditResult = { synced: boolean; blocked: boolean; reason: string }`. The `transform` step (lines 22–29) derives `blocked: !allowed` and `synced: allowed && !!data.upsert`, so `blocked` is always the exact negation of `allowed`, and `synced` is true iff `allowed` and `upsertOngoingOrderEditStep` (`src/workflows/steps/upsert-ongoing-order-edit.ts`) returned a truthy `StepResponse`. `reason: data.decision.reason` is `gateOrderEditStep`'s own machine-readable reason string (e.g. `"status_blocked"`, `"status_unknown"`, `"no_edit_rules"`, `"no_sync_row"`), carried straight through — safe to use directly as `result.reason ?? "status_blocked"`, matching the sibling's fallback exactly.

- **`src/workflows/mark-order-sync-edit-blocked.ts:1-16`** — `export const markOrderSyncEditBlockedWorkflow = createWorkflow("mark-order-sync-edit-blocked", function (input: MarkEditBlockedInput) { const result = markOrderSyncEditBlockedStep(input); return new WorkflowResponse(result) })`. Called as `markOrderSyncEditBlockedWorkflow(container).run({ input })`, matching the call shape already used at `order-updated.ts`'s pre-check site.

- **`src/workflows/steps/mark-order-sync-edit-blocked.ts:5-10`** — input contract: `export type MarkEditBlockedInput = { order_sync_id: string; blocked: boolean; category?: OrderEditCategory; reason?: string }`. `OrderEditCategory` (imported from `./gate-order-edit`) is `"address_contact" | "line_items"`; `order-updated.ts` always passes `category: "address_contact"`.

- **`src/lib/ongoing/events.ts:1-10,66-71`** — `ONGOING_EVENTS.EDIT_BLOCKED = "ongoing.sync.edit_blocked"`; `EditBlockedPayload = { medusa_order_id: string; ongoing_order_sync_id: string; category: string; latest_status_code: number | null }`, matching the shape already emitted at `order-updated.ts`'s pre-check site (lines 138–146).

- **`src/subscribers/__tests__/order-updated.test.ts`** (full file read, 264 lines). Already `jest.mock`s both `syncOrderEditToOngoing` (line 5) and `markOrderSyncEditBlockedWorkflow` (line 8), with `runMock` and `markBlockedRunMock` wired via `.mockReturnValue({ run: ... })` and reset in `beforeEach` (lines 81–85) — **no new mock scaffolding is needed**, only a new test case using the existing fixtures. The existing "re-syncs... when status is allowed" test (lines 88–117) sets `runMock`'s default resolved value to `{ result: { synced: true, blocked: false, reason: "allowed" } }` (line 14) and does not touch `markBlockedRunMock`/`emit` — this plan's new test must use `runMock.mockResolvedValueOnce(...)` (as the per-row-failure test at line 232 already does) to override just one call without disturbing other tests' shared default.

- **`src/subscribers/__tests__/order-edit-confirmed.test.ts:196-221`** — the mirror test to model the new one on: `"emits edit_blocked when the workflow itself returns blocked (no false success)"`, which sets `runMock.mockResolvedValueOnce({ result: { synced: false, blocked: true, reason: "status_blocked" } })` on a row whose own subscriber-level gate is allowed, then asserts `emit` was called with the blocked payload and `markBlockedRunMock` was called with `{ order_sync_id, blocked: true, category, reason: "status_blocked" }`.

- **`docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:229-246`** (§8, "Order updates — full edit re-sync, gated") — "Blocked → skip + emit a warning event; surface in the admin order widget" and "Subscribers never throw (log + record error), are idempotent". Confirms the design intent this plan implements at the previously-missing post-workflow site.

- **`medusa-dev:building-with-medusa` skill** (loaded this session, `/Users/thomasaudunhus/.codex/plugins/cache/medusa/medusa-dev/1.0.9/skills/building-with-medusa/SKILL.md`) — `arch-workflow-required` ("Use workflows for ALL mutations, never call module services from routes/subscribers directly"): satisfied because the new code calls `markOrderSyncEditBlockedWorkflow(container).run(...)`, never `container.resolve(ONGOING_MODULE).updateOngoingOrderSyncs(...)` directly. Workflow Composition Rules (no async/arrow/await/conditionals inside `createWorkflow`'s composer function) are not exercised by this plan — no workflow file is created or modified, only a subscriber (a plain async function, which is not subject to those constraints) calling an existing workflow.

---

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6** (`Node16` module resolution, decorators enabled — root `tsconfig.json`); yarn **4.6.0**; Node **>= 20**.
- **Mutations only via workflows** (`medusa-dev:building-with-medusa`'s `arch-workflow-required`): the new code calls `markOrderSyncEditBlockedWorkflow(container).run({ input })`, never the module service directly.
- **Subscribers never throw** (spec §8, `docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:245`): the new `eventBus.emit(...)` and `markOrderSyncEditBlockedWorkflow(container).run(...)` calls are placed **inside the existing per-row `try` block** (`order-updated.ts`, currently lines 117–181), so any throw from either call is caught by the existing `catch (rowError)` block (lines 181–188) and logged, never propagated — identical placement/behavior to the pre-check site's existing calls at lines 138–154, which are inside the same `try`.
- Event name comes from the typed `ONGOING_EVENTS.EDIT_BLOCKED` constant (`src/lib/ongoing/events.ts:9`), not a raw string literal — matching the file's existing pre-check site usage (line 139) and `order-edit-confirmed.ts`'s usage.
- No new imports: `markOrderSyncEditBlockedWorkflow` and `ONGOING_EVENTS` are already imported at the top of `order-updated.ts` (lines 5–6).
- `jest.config.js`: `testEnvironment: "node"`, `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`, `@swc/jest` transform, `clearMocks: true`. Test command: `yarn test src/subscribers/__tests__/order-updated.test.ts`.

---

## File Structure

**Modify:**
- `src/subscribers/order-updated.ts` — extend the post-workflow branch (currently lines 172–180) to emit `ONGOING_EVENTS.EDIT_BLOCKED` and call `markOrderSyncEditBlockedWorkflow` when `result?.blocked` is true.
- `src/subscribers/__tests__/order-updated.test.ts` — add one new test case asserting the above.

**Depends on (already exists, unmodified):**
- `src/workflows/mark-order-sync-edit-blocked.ts` — `markOrderSyncEditBlockedWorkflow`.
- `src/workflows/steps/mark-order-sync-edit-blocked.ts` — `MarkEditBlockedInput` type.
- `src/lib/ongoing/events.ts` — `ONGOING_EVENTS.EDIT_BLOCKED`.
- `src/workflows/sync-order-edit-to-ongoing.ts` — `SyncOrderEditResult` shape (`{ synced, blocked, reason }`), already returned by `syncOrderEditToOngoing(container).run({ input })` and destructured as `result`.

---

## Task 1: Persist edit-blocked state at `order-updated.ts`'s post-workflow site (TDD)

**Files:**
- Modify: `src/subscribers/order-updated.ts`
- Modify (test): `src/subscribers/__tests__/order-updated.test.ts`

**Interface:**
- No new exported symbols. `orderUpdatedHandler` (default export, `src/subscribers/order-updated.ts:32`) keeps its existing signature: `async function orderUpdatedHandler({ event, container }: SubscriberArgs<{ id: string }>): Promise<void>`.
- Internal behavior change only: when `syncOrderEditToOngoing(container).run({ input })` resolves with `result.blocked === true`, the handler now additionally calls `eventBus.emit({ name: ONGOING_EVENTS.EDIT_BLOCKED, data: { medusa_order_id: orderId, ongoing_order_sync_id: row.id, category: "address_contact", latest_status_code: code } })` and `markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id: row.id, blocked: true, category: "address_contact", reason: result.reason ?? "status_blocked" } })`, in that order, before moving to the next sync row.

- [ ] **Step 1: Write the failing test**

In `src/subscribers/__tests__/order-updated.test.ts`, add a new test case inside the existing `describe("order.updated subscriber — address/contact re-sync", ...)` block (after the existing `it("re-syncs each sync row...")` test at line 117, so it sits alongside the other blocked-path tests):

```ts
  it("emits edit_blocked and marks the row when the workflow's own re-gate blocks (post-workflow site)", async () => {
    const { container, emit } = makeContainer({
      detailTypes: ["shipping_address"],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // subscriber's own pre-check gate allows
    })

    // Status passes the subscriber's own pre-check gate, but the workflow's
    // internal re-gate (gateOrderEditStep, inside syncOrderEditToOngoing) blocks
    // — e.g. status changed between the subscriber's query and the workflow's own.
    runMock.mockResolvedValueOnce({ result: { synced: false, blocked: true, reason: "status_blocked" } })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 100,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: FAIL on the new test — `emit` is not called with the `ongoing.sync.edit_blocked` payload (the `else` branch of the current `if (result?.synced) {...} else {...}` only calls `logger.warn`), and `markBlockedRunMock` is not called. The other, pre-existing tests in the file continue to pass.

- [ ] **Step 3: Implement the fix**

In `src/subscribers/order-updated.ts`, replace the post-workflow branch (currently lines 169–180):

```ts
        // The workflow re-gates internally (gateOrderEditStep). Report what it
        // actually did rather than assuming success, so the log never lies if the
        // workflow's own gate blocked (e.g. status changed between query and gate).
        if (result?.synced) {
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
        } else {
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact re-sync not applied for sync ${row.id} (workflow: ${result?.reason ?? "unknown"})`
          )
        }
```

with:

```ts
        // The workflow re-gates internally (gateOrderEditStep). Report what it
        // actually did rather than assuming success, so the log never lies if the
        // workflow's own gate blocked (e.g. status changed between query and gate).
        if (result?.synced) {
          logger.info(
            `[ongoing] order.updated for ${orderId}: re-synced address_contact edit for sync ${row.id}`
          )
        } else if (result?.blocked) {
          // Mirrors order-edit-confirmed.ts's post-workflow blocked branch: the
          // workflow's own gate is authoritative, so a row it blocks must be
          // persisted as blocked even though the subscriber's own pre-check
          // gate (above) allowed it — this is exactly the race #94 closes.
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact re-sync blocked by workflow for sync ${row.id} (reason: ${result.reason})`
          )
          await eventBus.emit({
            name: ONGOING_EVENTS.EDIT_BLOCKED,
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
              reason: result.reason ?? "status_blocked",
            },
          })
        } else {
          // Defensive fallback: result is present but neither synced nor
          // blocked (should not happen given SyncOrderEditResult's derivation
          // in sync-order-edit-to-ongoing.ts, but keep the prior behavior
          // rather than silently dropping an unrecognized shape).
          logger.warn(
            `[ongoing] order.updated for ${orderId}: address_contact re-sync not applied for sync ${row.id} (workflow: ${result?.reason ?? "unknown"})`
          )
        }
```

No changes to imports (both `markOrderSyncEditBlockedWorkflow` and `ONGOING_EVENTS` are already imported at lines 5–6), no changes to the pre-check branch (lines 117–156), no changes to the `catch (rowError)` block (lines 181–188).

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/subscribers/__tests__/order-updated.test.ts`
Expected: PASS — all existing tests in the file continue to pass (the `if (result?.synced)` branch is untouched, and the pre-existing "no-op"/"blocked pre-check"/"per-row failure" tests never set `blocked: true` alongside `synced: false` in a way that exercises the new `else if`, except the new test itself), and the new test passes.

- [ ] **Step 5: Run the full test suite**

Run: `yarn test`
Expected: PASS — no regressions in `src/subscribers/__tests__/order-edit-confirmed.test.ts` or any other test file (this plan does not touch `order-edit-confirmed.ts` or any workflow/step file).

- [ ] **Step 6: Lint and build**

Run: `yarn lint`
Expected: PASS — no new lint errors (`medusa lint`, eslint flat config, `@medusajs/eslint-plugin recommended`).

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles `src/subscribers/order-updated.ts` to `.medusa/server` with no type errors (the `result.reason` access inside the `else if (result?.blocked)` branch is safe because the branch's guard already narrows `result` to be non-nullish, matching the pattern already used in `order-edit-confirmed.ts`'s `if (result?.blocked) { ...; result.reason }`).

---

## Verification checklist (for the executor, before requesting review)

- [ ] `yarn test src/subscribers/__tests__/order-updated.test.ts` — the 8 pre-existing tests still pass, plus the new test (9 total).
- [ ] `yarn test` — full suite green, in particular `src/subscribers/__tests__/order-edit-confirmed.test.ts` unaffected.
- [ ] `yarn lint` — clean.
- [ ] `yarn build` — clean.
- [ ] Diff of `src/subscribers/order-updated.ts` touches only the post-workflow branch (previously lines 169–180); no import changes; no changes to the pre-check branch or the outer `catch` blocks.
- [ ] `src/subscribers/order-edit-confirmed.ts` is untouched (out of scope for #94).
- [ ] Per code-review requirement in `CLAUDE.md` ("Code review before merging"): review is performed by an agent/session that has loaded `medusa-dev:building-with-medusa` before merge (this plan's Task 1 was itself written under that skill; the reviewer must load it independently, not rely on this plan's citation).

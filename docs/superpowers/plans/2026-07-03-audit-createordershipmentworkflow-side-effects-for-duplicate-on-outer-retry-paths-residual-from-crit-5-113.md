# Audit createOrderShipmentWorkflow side effects for duplicate-on-outer-retry paths (#113) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is an audit-plus-documentation task (not new business logic) — process.md's config/scaffolding TDD exemption applies: verify each finding by running the listed command and reading the listed source line range, not by writing a red test first. The one new test added in Task 1 pins existing, already-passing behavior (a regression lock, not a red→green cycle).

**Goal:** Resolve the residual from the CRIT-5 refutation (2026-07-02): determine whether `createOrderShipmentWorkflow` (invoked from `src/workflows/steps/apply-order-shipment.ts:51`) has any side effect — `SHIPMENT_CREATED` emit, customer notification, webhook, analytics — that can duplicate when the outer `syncOngoingShipmentWorkflow` retries after `applyOrderShipmentStep` already succeeded but a later step failed. Record the audited conclusion at the call site and close the issue via the merging PR; only add an idempotency guard if the audit finds a live duplicate-on-retry path.

**Architecture:** No new module, workflow, step, or event. This is a source-reading audit (this plugin's `src/workflows/`, `src/subscribers/`, and the vendored `@medusajs/core-flows`/`@medusajs/notification`/`@medusajs/medusa` packages under `node_modules/`) whose conclusion is recorded as an extended code comment at `src/workflows/steps/apply-order-shipment.ts:20-29` plus one new regression test in `src/workflows/steps/__tests__/apply-order-shipment.test.ts`. A **Decision Gate** between Task 1 and Task 2 makes the audit's pass/fail outcome explicit for whoever executes this plan; Task 2 (close-out) runs only on a pass, Task 3 (fix) is scaffolded but audit-dependent and should not be executed unless Task 1's findings differ from what is documented below.

**Tech Stack:** Medusa 2.16.0 (`@medusajs/core-flows`, `@medusajs/notification`, `@medusajs/medusa` — all pinned, vendored in `node_modules/@medusajs/`), TypeScript 5.6 (`Node16` module resolution), yarn 4.6.0, Node >= 20, Jest (`@swc/jest`, `testEnvironment: "node"`, `clearMocks: true`, matched via `jest.config.js`).

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6**; yarn **4.6.0**; Node **>= 20**.
- This plan makes **no runtime behavior change** — only comments and one new test. If Task 1's audit surfaces a real gap (contradicting the findings recorded below), stop before Task 2, do not improvise a fix inline, and treat Task 3 as a fresh planning input (see Decision Gate).
- Per `CLAUDE.md` ("Code review before merging"), the PR that lands this must be reviewed by an agent/session that has loaded `medusa-dev:building-with-medusa` before merge.
- Per `docs/superpowers/process.md` ("No tracking drift"), the merging PR body must include `Closes #113`; merging is what closes the issue, not a separate `gh issue close`.
- Test command: `yarn test <path-substring>` (Jest substring match); full suite `yarn test`.

---

## File Structure

**Modify (Task 1 — audit findings recorded in code):**
- `src/workflows/steps/apply-order-shipment.ts` — extend the existing safety comment (lines 20-29) with the #113 audit conclusion and its source citations.
- `src/workflows/steps/__tests__/apply-order-shipment.test.ts` — add one regression test that pins the two-invocation (simulated outer-retry) behavior.

**Read only (Task 1 — audit sources, no edits):**
- `src/workflows/sync-ongoing-shipment.ts` — outer workflow composition (`applyOrderShipmentStep` then `markOrderSyncShippedStep`).
- `src/workflows/steps/load-sync-for-shipment.ts:37-43` — the outer `sync.shipped_at` guard and why it does *not* close the retry window (the row's `shipped_at` is only set by `markOrderSyncShippedStep`, which is exactly the step that failed).
- `src/jobs/status-poll.ts:107-130` — the concrete outer-retry trigger: re-invokes `syncOngoingShipmentWorkflow` on the next `* * * * *` tick whenever `OngoingOrderSync.shipped_at` is still `null`.
- `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts:17-37` — the other outer-retry trigger (webhook delivery), same guard.
- `src/subscribers/order-canceled.ts`, `src/subscribers/order-edit-confirmed.ts`, `src/subscribers/order-updated.ts` — the complete list of this plugin's subscribers (grep confirms none reference `shipment.created`/`SHIPMENT_CREATED`).
- `node_modules/@medusajs/core-flows/dist/order/workflows/create-shipment.js:119-164` — `createOrderShipmentWorkflow` composition (the emit's data dependency).
- `node_modules/@medusajs/core-flows/dist/fulfillment/workflows/create-shipment.js:34-43` — `createShipmentWorkflow` (`validateShipmentStep` then `updateFulfillmentWorkflow.runAsStep`).
- `node_modules/@medusajs/core-flows/dist/fulfillment/steps/validate-shipment.js:12-27` — `validateShipmentStep`, the exact `"Shipment has already been created"` throw.
- `node_modules/@medusajs/core-flows/dist/order/steps/register-shipment.js:10-20` — `registerOrderShipmentStep` and its `revertLastVersion` compensation.
- `node_modules/@medusajs/notification/dist/services/notification-module-service.js:33-55` — `NotificationModuleService.createNotifications_`, the `idempotency_key`-gated dedupe.
- `node_modules/@medusajs/medusa/dist/subscribers/configurable-notifications.js:8-19` — Medusa 2.16.0's only built-in notification subscriber, hardcoded to `order.created` only.

---

## Task 1: Audit `createOrderShipmentWorkflow` side effects and record the conclusion (mandatory)

**Files:**
- Modify: `src/workflows/steps/apply-order-shipment.ts`
- Test: `src/workflows/steps/__tests__/apply-order-shipment.test.ts`

**Interfaces:**
- Consumes: nothing new. `applyOrderShipmentHandler` and `applyOrderShipmentStep` (both already exported from `apply-order-shipment.ts`) keep their existing signatures — `applyOrderShipmentHandler(input: ApplyShipmentInput, { container }: { container: any }): Promise<StepResponse<ApplyShipmentResult>>`.
- Produces: no new exported symbols. The change is comment-only in the source file and one additional `it(...)` block in the test file.

- [ ] **Step 1: Run the four audit checks and confirm the outputs below**

Run each command from the plugin root and confirm the output matches what's shown (all four are already true as of this plan's writing — re-run them to catch drift before trusting the conclusion in Step 2):

```bash
# Check A — no subscriber in this plugin listens to the core SHIPMENT_CREATED event
grep -rn "SHIPMENT_CREATED\|shipment.created" src/subscribers/*.ts
```
Expected: no matches (only `src/workflows/steps/apply-order-shipment.ts:21` mentions `SHIPMENT_CREATED`, in a comment — this grep is scoped to `src/subscribers/*.ts` so it will find nothing).

```bash
# Check B — Medusa 2.16.0 core ships no built-in shipment.created notification handler
grep -n "event:" node_modules/@medusajs/medusa/dist/subscribers/configurable-notifications.js
```
Expected: `event: "order.created",` only — no `shipment.created` entry.

```bash
# Check C — validate-shipment's exact throw matches the string this plugin swallows
grep -n "Shipment has already been created" node_modules/@medusajs/core-flows/dist/fulfillment/steps/validate-shipment.js src/workflows/steps/apply-order-shipment.ts
```
Expected: one match in each file, identical string.

```bash
# Check D — the notification module's dedupe is opt-in via idempotency_key, not automatic
grep -n "idempotency_key" node_modules/@medusajs/notification/dist/services/notification-module-service.js
```
Expected: multiple matches inside `createNotifications_`, all gated behind `entry.idempotency_key` / `entry.data.idempotency_key` — confirming dedupe only applies to callers that explicitly set the field.

If any of the four checks disagrees with its expected output, **stop here** — do not proceed to Step 2's comment (it would record a false conclusion). Instead capture what changed and treat Task 3 (Decision Gate → Fix) as the next step, scoping its exact touched files from the new finding.

- [ ] **Step 2: Record the audit conclusion in `apply-order-shipment.ts`**

In `src/workflows/steps/apply-order-shipment.ts`, the current comment block is (lines 20-29):

```ts
// The handler invokes the core `createOrderShipmentWorkflow` (which sets shipped_at,
// updates order state, releases reservations and emits SHIPMENT_CREATED) from INSIDE
// this step via `.run()` — the canonical "run a core-flow inside a step" pattern.
//
// Idempotency: Medusa's validate-shipment step throws a NOT_ALLOWED MedusaError with
// the exact message "Shipment has already been created" when the fulfillment is already
// shipped. That is swallowed as success WITHOUT writing an error row. Any other failure
// is classified (MedusaError -> terminal; OngoingApiError -> its kind; else retryable),
// recorded on the sync row, then re-thrown (record-then-rethrow, not compensation, since
// a throwing step returns no StepResponse).
```

Replace it with (adds a new paragraph after the existing one, unchanged text kept verbatim):

```ts
// The handler invokes the core `createOrderShipmentWorkflow` (which sets shipped_at,
// updates order state, releases reservations and emits SHIPMENT_CREATED) from INSIDE
// this step via `.run()` — the canonical "run a core-flow inside a step" pattern.
//
// Idempotency: Medusa's validate-shipment step throws a NOT_ALLOWED MedusaError with
// the exact message "Shipment has already been created" when the fulfillment is already
// shipped. That is swallowed as success WITHOUT writing an error row. Any other failure
// is classified (MedusaError -> terminal; OngoingApiError -> its kind; else retryable),
// recorded on the sync row, then re-thrown (record-then-rethrow, not compensation, since
// a throwing step returns no StepResponse).
//
// Audit (#113): does an outer-workflow retry (syncOngoingShipmentWorkflow re-run after
// this step already succeeded once, but markOrderSyncShippedStep then failed — see
// src/jobs/status-poll.ts:120-129 and the webhook path in
// src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts, both of which re-invoke
// syncOngoingShipmentWorkflow whenever OngoingOrderSync.shipped_at is still null, i.e.
// before markOrderSyncShippedStep has committed) re-fire any SHIPMENT_CREATED-driven
// side effect (notification/webhook/analytics)? Audited and confirmed safe:
//
//  1. Emit gating: createOrderShipmentWorkflow's emitEventStep
//     (@medusajs/core-flows/dist/order/workflows/create-shipment.js:150-156) reads
//     `shipment.id`, the output of a parallel branch that includes
//     createShipmentWorkflow.runAsStep. That inner workflow's first step,
//     validateShipmentStep (@medusajs/core-flows/dist/fulfillment/steps/
//     validate-shipment.js:12-19), throws the exact "Shipment has already been created"
//     MedusaError caught above whenever `fulfillment.shipped_at` is already set — which
//     it is on any retry, because the first successful run already set it via
//     updateFulfillmentWorkflow. A failed step blocks every step that depends on its
//     output, so emitEventStep never runs on retry. The sibling parallel step
//     registerOrderShipmentStep (@medusajs/core-flows/dist/order/steps/
//     register-shipment.js:10-20) carries a `revertLastVersion` compensation that the
//     workflow engine runs automatically when its sibling fails, so even its transient
//     write is reverted before `.run()` returns.
//  2. No live consumer today: this plugin's subscribers (src/subscribers/
//     order-canceled.ts, order-edit-confirmed.ts, order-updated.ts) don't reference
//     shipment.created, and Medusa 2.16.0's only built-in notification subscriber
//     (@medusajs/medusa/dist/subscribers/configurable-notifications.js) is hardcoded to
//     "order.created" only.
//  3. Guardrail for a future subscriber: NotificationModuleService.createNotifications
//     (@medusajs/notification/dist/services/notification-module-service.js:39-55) only
//     dedupes entries carrying an explicit `idempotency_key` — not automatic per-event.
//     (1) already prevents a duplicate emit on retry, so this isn't a live gap, but any
//     future shipment.created subscriber should still set an idempotency_key rather than
//     rely on the module deduping for it.
```

- [ ] **Step 3: Add the regression test**

In `src/workflows/steps/__tests__/apply-order-shipment.test.ts`, add a new test inside the existing `describe("applyOrderShipmentStep", ...)` block, after the `"swallows the already-created MedusaError as idempotent success without writing an error row"` test (currently ends at line 57):

```ts
  it("is safe under an outer-workflow retry: a second call for the same fulfillment hits the already-shipped swallow, not a duplicate side effect (#113)", async () => {
    const service = makeService()

    run.mockResolvedValueOnce({ result: undefined })
    const first = await invoke(baseInput, service)
    expect(first.output).toEqual({ applied: true, reason: "shipped" })

    run.mockRejectedValueOnce(
      new MedusaError(MedusaError.Types.NOT_ALLOWED, "Shipment has already been created")
    )
    const second = await invoke(baseInput, service)
    expect(second.output).toEqual({ applied: false, reason: "already_shipped" })

    expect(run).toHaveBeenCalledTimes(2)
    expect(service.updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })
```

(No new imports — `MedusaError`, `run`, `invoke`, `makeService`, `baseInput` are all already imported/defined earlier in the file.)

- [ ] **Step 4: Run the test file to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/apply-order-shipment.test.ts`
Expected: PASS — all 6 tests in the file (the 5 existing plus the new one), no failures. This is a regression lock on already-correct behavior, not a red→green cycle — the assertion holds against the current, unmodified `apply-order-shipment.ts` handler logic.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/apply-order-shipment.ts src/workflows/steps/__tests__/apply-order-shipment.test.ts
git commit -m "docs(ongoing): record #113 audit — createOrderShipmentWorkflow has no duplicate-on-outer-retry side effect"
```

---

## Decision Gate

Evaluate strictly from Task 1 Step 1's four check outputs:

- **All four checks matched their expected output** → the audit conclusion recorded in Task 1 Step 2 holds. **Proceed to Task 2 (close-out).** Do not execute Task 3.
- **Any check disagreed** (e.g., a new subscriber now listens to `shipment.created`, or `validateShipmentStep`'s guard string/logic changed upstream, or `createNotifications_`'s dedupe became automatic) → **do not commit Task 1 Step 2's comment as written** — it would assert a false conclusion. Stop, capture exactly which check failed and what the new source shows, and scope Task 3 from that finding (see Task 3 below — its exact touched files are audit-dependent and cannot be pinned until a real gap is found).

Per the research behind this plan (all four checks read and confirmed present in this codebase and in the vendored Medusa 2.16.0 packages at the time of writing — see the File Structure "Read only" list above for exact line ranges), the expected outcome is the first branch: **no duplicate-on-outer-retry side effect exists.**

---

## Task 2: Close-out (only if the Decision Gate held)

No new code beyond Task 1. Run the full verification gates and land the PR.

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: PASS — all suites green, including the new test from Task 1 Step 3, no regressions elsewhere.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: PASS — `medusa lint` reports no errors on `src/workflows/steps/apply-order-shipment.ts` or its test file.

- [ ] **Step 3: Build**

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles with no type errors (comment-only change plus a same-shape test addition; no type surface changed).

- [ ] **Step 4: Confirm the diff scope**

Verify the working tree touches only the two files from Task 1 (`src/workflows/steps/apply-order-shipment.ts`, `src/workflows/steps/__tests__/apply-order-shipment.test.ts`) — no model, migration, workflow composition, event, or subscriber file changed. Per `CLAUDE.md` ("Code review before merging"), the PR reviewer must independently load `medusa-dev:building-with-medusa` before merge.

- [ ] **Step 5: Open the PR**

Push the branch and open a PR whose body includes `Closes #113` and the three-point audit summary from the Task 1 Step 2 comment (emit gating / no live consumer today / notification-module dedupe guardrail), so the audit trail is visible on the issue when the PR merges and auto-closes it (per `docs/superpowers/process.md` "No tracking drift" — merging is what closes the issue, not a separate `gh issue close`).

---

## Task 3: Idempotency guard (conditional — audit-dependent, do not execute unless the Decision Gate's second branch was taken)

This task only applies if Task 1 Step 1 found a real gap contradicting the conclusion recorded in this plan (e.g., a new `shipment.created` subscriber was added upstream or in this plugin without its own guard, or `validateShipmentStep`'s "already shipped" check no longer gates the emit in a newer Medusa version). Its exact touched files, function signatures, and test cases are **audit-dependent (TBD)** — they cannot be pinned in advance because they depend on *what* the contradicting finding actually is (a new subscriber file vs. a changed core-flows dependency graph vs. something else). Do not improvise generic guard code against this placeholder; re-derive the task from the specific finding, following the same evidence-and-citation standard as Task 1.

Candidate idempotency-guard mechanics to choose from once the finding is known (recommendation: option (a), because it requires no new column/migration and reuses the field this plugin already treats as the single source of truth for "have we handled this shipment"):

- **(a) Pre-check `OngoingOrderSync.shipped_at` in the new consumer itself** — before firing the side effect (e.g. inside a new subscriber's handler), re-resolve `ONGOING_MODULE` and check whether `shipped_at` is already non-null on the row referenced by the event payload; skip if so. Mirrors the existing pattern in `src/workflows/steps/load-sync-for-shipment.ts:37-43`.
- **(b) `has_notified_at` column on `OngoingOrderSync`** — add a nullable `dateTime()` field via `src/modules/ongoing/models/order-sync.ts`, generate a migration (`npx medusa plugin:db:generate`), set it in the same step that performs the side effect, and gate on it being null before firing. Higher cost (schema + migration) — only worth it if (a) can't observe the right row from the event payload.
- **(c) `idempotency_key` on the notification call** — if the gap is specifically inside `NotificationModuleService.createNotifications`, pass `idempotency_key: `${fulfillment_id}:shipment_created``` (or similar stable key) so the module's own dedupe (Task 1's Check D) applies. Narrower fix, only closes the notification-specific instance of the gap, not webhook/analytics variants.

---

## Self-Review (completed during planning)

- **Spec coverage:** the issue's two required checks (SHIPMENT_CREATED emit gating; notification-module dedupe semantics) are Task 1 Step 1 Checks A-D and the corresponding paragraphs 1 and 3 of the Step 2 comment. The issue's third ask ("any subscriber that listens to SHIPMENT_CREATED... idempotent?") is Check A / comment paragraph 2. The issue's fourth ask ("Analytics module, external webhook module") is covered by the File Structure grep confirming no such module/registration exists in this repo — noted in paragraph 2 of the comment (no live consumer at all, of any kind). The issue's two required outcomes (fix if found / document-and-close if not) map to the Decision Gate's two branches and Tasks 2/3 respectively.
- **Placeholder scan:** no bare `TODO`/`TBD` in Tasks 1-2. Task 3 intentionally carries the plan's only "TBD" — explicitly marked "audit-dependent" per the assignment's own allowance, scoped to a conditional branch that the Decision Gate says should not execute under the evidence gathered while writing this plan.
- **Type consistency:** `applyOrderShipmentHandler`/`applyOrderShipmentStep`, `ApplyShipmentInput`, `ApplyShipmentResult` are unchanged from the current file (read in full before drafting this plan) — Task 1 touches only comments and test code, no signature changes.
- **Task granularity:** two mandatory tasks (audit+document, close-out) plus one conditional task, matching the requested audit → gate → fix skeleton while keeping the trivial, same-file documentation edits in a single task rather than one-per-finding.

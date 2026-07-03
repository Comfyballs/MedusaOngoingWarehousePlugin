# cancelFulfillment throws on non-cancellable Ongoing status (#109) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `OngoingFulfillmentProviderService.cancelFulfillment` (`src/providers/ongoing-fulfillment/service.ts`) throw a `MedusaError` instead of silently resolving when `cancelOngoingOrderWorkflow` decides `reason: "status_not_cancellable"`, so Medusa's core `FulfillmentModuleService.cancelFulfillment` does not set `fulfillment.canceled_at` while the order is still shipping at Ongoing.

**Architecture:** Medusa's core `FulfillmentModuleService.cancelFulfillment` (verified at `@medusajs/fulfillment` 2.16.0, `fulfillment-module-service.js:711-728` — see "Verified facts" below) only branches on throw vs. no-throw from the provider: any non-throwing return unconditionally sets `canceled_at`. The provider's `cancelFulfillment` currently maps every `CancelDecision.reason` from `cancelOngoingOrderWorkflow` (#28) onto a non-throwing `{ canceled, reason }` object — including `status_not_cancellable`, which is the one reason that means "a real Ongoing order exists and Ongoing itself refuses to cancel it because its status has moved on." This plan adds a single conditional throw for exactly that reason, leaves every other reason's no-throw behavior untouched (they are genuine no-ops — nothing exists at Ongoing to keep shipping), and leaves the `order.canceled` subscriber and `cancelOngoingOrderStep`/`decideOngoingCancelStep` untouched (different call sites, out of scope — see "Boundary with #111" below).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/utils` — `MedusaError`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests with mocked dependencies (no DB / no running Medusa — confirmed by `jest.config.js` and the existing `cancel-fulfillment.test.ts`, which mocks the `../../../workflows` barrel).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- `MedusaError` types come from `@medusajs/framework/utils` — the real enum (verified against the installed `@medusajs/utils` 2.16.0 `errors.d.ts`) is `DB_ERROR | DUPLICATE_ERROR | INVALID_ARGUMENT | INVALID_DATA | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | NOT_ALLOWED | UNEXPECTED_STATE | CONFLICT | UNKNOWN_MODULES | PAYMENT_AUTHORIZATION_ERROR | PAYMENT_REQUIRES_MORE_ERROR`. There is **no `INVALID_STATE` type** — the issue's suggested name does not exist in this Medusa version; do not use it (see Decision 1).
- Prices/quantities stored as-is — never ×100 or ÷100 (not touched by this plan, noted per project convention).
- Plugin build output is `.medusa/server`; verify with `yarn build`.
- TDD: the `cancelFulfillment` change is a bugfix to existing business logic — a failing Jest unit test comes before the implementation, per `docs/superpowers/process.md` ("Implementing any feature or bugfix in business logic: test-driven-development"). The diagnostic SQL added in this plan is infra/scaffolding (no application code path, no test harness in this repo) and is exempt per the same process doc; it is verified by inspection instead.

---

## Verified facts (do not re-derive)

- **Core throw/no-throw semantics** (`@medusajs/fulfillment` 2.16.0, `fulfillment-module-service.js:711-728`, read directly from the installed package in this session):
  ```js
  async cancelFulfillment(id, sharedContext = {}) {
      const canceledAt = new Date();
      let fulfillment = await this.fulfillmentService_.retrieve(id, {}, sharedContext);
      FulfillmentModuleService.canCancelFulfillmentOrThrow(fulfillment);
      if (!fulfillment.canceled_at) {
          try {
              await this.fulfillmentProviderService_.cancelFulfillment(fulfillment.provider_id, fulfillment.data ?? {});
          }
          catch (error) {
              throw error;
          }
          fulfillment = await this.fulfillmentService_.update({ id, canceled_at: canceledAt }, sharedContext);
      }
      ...
  }
  ```
  Any return from the provider that does not throw reaches `this.fulfillmentService_.update({ canceled_at: canceledAt })` unconditionally — the returned `{ canceled: false, reason: ... }` payload is never inspected. A thrown error propagates straight out (`catch (error) { throw error }`) and `canceled_at` is never set.
- **Call chain that reaches the provider** (`@medusajs/core-flows` 2.16.0, read directly from the installed package): the admin "cancel fulfillment" action runs `cancelOrderFulfillmentWorkflow`, whose **last step** (`fulfillment_1.cancelFulfillmentWorkflow.runAsStep`, comment: `"last step because there is no compensation for this step"`) calls `service.cancelFulfillment(id)` on the core fulfillment module service, which is the method quoted above. Because it is the last step, a throw here triggers the *workflow's* automatic compensation for the steps that already ran in `cancelOrderFulfillmentWorkflow` (inventory adjustment, reservation create/update, and the order module's own `cancelFulfillment` step, whose compensation is `service.revertLastVersion(orderId)`) — i.e. throwing correctly aborts and rolls back the whole "cancel this fulfillment" admin action, the same way Medusa already handles "fulfillment already shipped" (`cancel-order-fulfillment.js:47-52` throws `MedusaError(NOT_ALLOWED, "The fulfillment has already been shipped...")` for that case). This plan does not modify any of these core-flows files; it is documented here only to confirm the throw is safe and idiomatic.
- **`cancelOrderWorkflow` (whole-order cancel) requires every fulfillment already canceled** (`@medusajs/core-flows` 2.16.0, `order/workflows/cancel-order.js:36-49`, `cancelValidateOrder`): it throws `MedusaError(NOT_ALLOWED, "All fulfillments must be canceled before canceling an order")` if any fulfillment lacks `canceled_at`. Consequence: the `order.canceled` event (which our `order-canceled.ts` subscriber listens for) can only fire after every fulfillment on that order already has `canceled_at` set — i.e. after every per-fulfillment `cancelFulfillment` call already resolved (not threw) for that order. This plan's new throw therefore also correctly blocks the merchant from reaching whole-order cancellation until the non-cancellable Ongoing order is dealt with — see Decision 3.
- **Current provider code** (`src/providers/ongoing-fulfillment/service.ts:232-289`, read in this session — line numbers may drift by the time you implement, re-read the file first):
  ```ts
  async cancelFulfillment(
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const stashed = (data ?? {}) as OngoingFulfillmentData

    const ongoingOrderNumber =
      typeof stashed.ongoing_order_number === "string"
        ? stashed.ongoing_order_number
        : undefined
    const medusaFulfillmentId =
      typeof stashed.medusa_fulfillment_id === "string"
        ? stashed.medusa_fulfillment_id
        : undefined
    const medusaOrderId =
      typeof stashed.medusa_order_id === "string"
        ? stashed.medusa_order_id
        : undefined

    const container = this.container_

    // Idempotent no-op: nothing in `data` lets us locate an OngoingOrderSync row.
    if (!ongoingOrderNumber && !medusaFulfillmentId && !medusaOrderId) {
      if (typeof stashed.location_id === "string") {
        try {
          const ongoing = container.resolve("ongoing") as {
            getIntegrationByLocation: (id: string) => Promise<unknown>
          }
          await ongoing.getIntegrationByLocation(stashed.location_id)
        } catch {
          // swallow — this is purely a diagnostic lookup
        }
      }
      return { ...data, canceled: false, reason: "no_identifier" }
    }

    const input: Record<string, string> = {}
    if (ongoingOrderNumber) {
      input.ongoing_order_number = ongoingOrderNumber
    }
    if (medusaFulfillmentId) {
      input.medusa_fulfillment_id = medusaFulfillmentId
    }
    if (medusaOrderId) {
      input.medusa_order_id = medusaOrderId
    }

    const { result } = await cancelOngoingOrderWorkflow(container).run({ input })

    return {
      ...data,
      canceled: Boolean(result?.shouldCancel),
      reason: result?.reason ?? "unknown",
    }
  }
  ```
- **`CancelDecision.reason` (`src/workflows/steps/decide-ongoing-cancel.ts:9-15`)** — the full set of possible values, and what each one means:
  - `"ok"` / `"status_unknown_attempt"` → `shouldCancel: true` (Ongoing cancel attempted/succeeded).
  - `"no_sync_row"` → no `OngoingOrderSync` row matches the filter at all; nothing was ever tracked as pushed to Ongoing for this fulfillment/order — genuine no-op.
  - `"already_cancelled"` → sync row's `sync_state === "cancelled"` already; Ongoing has already stopped — genuine no-op (true idempotency).
  - `"no_ongoing_order_id"` → sync row exists but `ongoing_order_id` is still `null`/`undefined`; the push to Ongoing never completed, so no order exists there to keep shipping — genuine no-op.
  - `"status_not_cancellable"` → sync row exists, `ongoing_order_id` is set (a real Ongoing order exists), and `integration.cancellable_status_codes` does not include the order's `latest_status_code` — **this is the one reason where a known, real Ongoing order is known to be past the point where Ongoing will accept a cancel.** This is the only reason this plan changes.
- **`createFulfillment` stash shape** (`src/providers/ongoing-fulfillment/service.ts:166-182`): `ongoing_order_number` and `ongoing_order_id` are always set together from the same `pushOrderToOngoing` result object, in the same `return`. There is no code path where `data` carries `ongoing_order_id` without `ongoing_order_number` (see Decision 2 for why this matters).
- **Project convention for this exact error type**: `src/workflows/steps/apply-order-shipment.ts:24-28,54-59` already uses `MedusaError.Types.NOT_ALLOWED` to detect and swallow Medusa's own "already shipped" idempotency error, and classifies `err instanceof MedusaError` as `"terminal"` (non-retryable) elsewhere in the same file (`:62-64`). Medusa's own core code uses `NOT_ALLOWED` for the structurally identical case of "the current state forbids this action" in `cancel-order-fulfillment.js:47-51` (`"The fulfillment is already canceled"`, `"...has already been shipped..."`) and in `cancel-order.js:40,44` (`"Cannot cancel a completed order..."`, `"All ... must be canceled before canceling an order"`).

---

## Decisions (resolved in this plan; do not re-litigate)

### Decision 1 — `MedusaError` type: `NOT_ALLOWED`

The issue asks to choose between `NOT_ALLOWED` and `INVALID_STATE`. **`INVALID_STATE` does not exist** in Medusa 2.16.0's `MedusaError.Types` (verified above). Use **`MedusaError.Types.NOT_ALLOWED`**:
- It is the exact type this codebase already uses for a structurally identical case (`apply-order-shipment.ts`'s "already shipped" idempotency guard).
- It is the exact type Medusa's own core workflows use for "current object state forbids this action" (`cancel-order-fulfillment.js`, `cancel-order.js`, both quoted above) — `status_not_cancellable` is exactly that: the Ongoing order's *current status* forbids cancelling it.
- It is distinguishable from `OngoingApiError` (network/HTTP failures, used for retry classification) and from this file's own `MedusaError.Types.INVALID_DATA`/`NOT_FOUND` uses (`service.ts:133-160`, which mean "the input/config was wrong", not "the action is currently disallowed") — so a caller or test can assert on `error.type === MedusaError.Types.NOT_ALLOWED` without ambiguity.

### Decision 2 — `no_identifier` sub-case (line ~253-265 in the current file): stays a silent no-op

The issue calls this out but does not decide it. Keep it **non-throwing**, unchanged. Justification:
- `no_identifier` fires only when `data` has **none** of `ongoing_order_number`, `medusa_fulfillment_id`, `medusa_order_id`. Per the verified stash shape above, `createFulfillment` sets `ongoing_order_number` and `ongoing_order_id` together, atomically, in one `return` — there is no code path that stashes a real Ongoing order id without also stashing the order number. So `no_identifier` can only mean the original push never got far enough to stash anything (or `data` was corrupted/manually edited) — in either case there is **no known Ongoing order** to assert is "still shipping." The risk this issue is about (Medusa says cancelled, Ongoing keeps shipping) requires a *known* Ongoing order; `no_identifier` cannot establish one.
- Throwing here would also be strictly worse for the merchant: unlike `status_not_cancellable` (which at least has an order number to look up in Ongoing), `no_identifier` gives no actionable information to retry or investigate — Medusa already only invokes `cancelFulfillment` once (idempotent via `!fulfillment.canceled_at`), so a throw would leave the fulfillment permanently un-cancellable in the admin UI with no path forward.

The other two no-throw reasons not explicitly named in the issue — `no_sync_row` and `no_ongoing_order_id` — stay non-throwing for the same reason as `no_identifier`: neither implies a real, currently-shipping Ongoing order exists (`no_sync_row`: nothing was ever tracked; `no_ongoing_order_id`: tracked, but the push to Ongoing never completed). Only `status_not_cancellable` implies a real order exists and Ongoing itself refuses the cancel.

### Decision 3 — Impact on the `order.canceled` subscriber: none; no code change needed

`src/subscribers/order-canceled.ts:65-93` calls `cancelOngoingOrderWorkflow(container).run(...)` **directly**, once per `OngoingOrderSync` row — it does **not** go through `OngoingFulfillmentProviderService.cancelFulfillment`. It already wraps every row's call in its own `try { ... } catch (error) { logger.error(...); /* continue */ }` and never throws out of the subscriber. This plan's new throw lives in a different call site entirely (`service.ts`'s `cancelFulfillment`, reached only via Medusa core's `FulfillmentModuleService.cancelFulfillment`), so:
- The subscriber's control flow is unaffected — no code change needed in `order-canceled.ts`.
- `ONGOING_EVENTS.ORDER_CANCELLED` (emitted at `order-canceled.ts:75-85`) stays gated on `result?.shouldCancel === true`, which is still correct and unaffected: if the subscriber's own workflow run independently decides `status_not_cancellable` for a given row (e.g. Ongoing's status advanced between the fulfillment-level cancel and this subscriber running), it still logs and moves to the next row without emitting — exactly as today.
- Per the verified fact above (`cancelValidateOrder` requires all fulfillments already `canceled_at` before `order.canceled` can even fire), by the time this subscriber runs, every fulfillment-level cancel for that order already succeeded through the (now-fixed) provider path — so in practice the subscriber's own workflow calls become close to guaranteed no-ops/idempotent confirmations, not the primary enforcement point. That was already true before this fix; this fix does not change it.

### Boundary with #111 (do not implement here)

Issue #111 narrows a *different* swallow, at a *different* layer: `src/workflows/steps/cancel-ongoing-order.ts:29-36` classifies any `OngoingApiError` with `kind === "terminal"` (any 4xx from the Ongoing DELETE call) as an already-cancelled idempotent success, when it should only do that for the specific "already cancelled" error shape. That code is inside `cancelOngoingOrderStep`, which only runs when `decideOngoingCancelStep` already decided `shouldCancel: true` — i.e. it is downstream of, and independent from, the `status_not_cancellable` decision this plan addresses. **Do not touch `src/workflows/steps/cancel-ongoing-order.ts` in this plan.**

### Decision 4 — Data repair: diagnostic only, no auto-repair

Any Medusa fulfillment cancelled **before** this fix shipped, where the decision was `status_not_cancellable`, will have `fulfillment.canceled_at` set while its `OngoingOrderSync.sync_state` is still `"sent"` or `"shipped"` (never got set to `"cancelled"`, since `markOrderSyncCancelledStep` only runs when `shouldCancel: true`). This plan ships a **read-only diagnostic SQL query** (Task 1, Step 8) to surface these rows; it does **not** attempt to auto-repair them, because the correct repair (cancel in Ongoing manually, or un-cancel the Medusa fulfillment if Ongoing already shipped it) requires a human to check the live state in Ongoing first — Ongoing is the system of record for shipping state, and blindly flipping either system's record could make the mismatch worse.

---

## File Structure

**Modify:**
- `src/providers/ongoing-fulfillment/service.ts` — add the `status_not_cancellable` throw and update the two doc comments (class-method JSDoc and the inline comment above the `cancelOngoingOrderWorkflow` call) to describe the new behavior.
- `src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts` — add the failing test for the new throw, plus a table-driven test pinning that `already_cancelled` / `no_sync_row` / `no_ongoing_order_id` stay non-throwing (Decision 2/3 boundary), plus a `MedusaError` import.

**Create:**
- `scripts/diagnose-cancel-mismatch.sql` — read-only diagnostic query for Decision 4, run manually by an operator against the consuming Medusa app's Postgres database (this plugin repo has no DB of its own).

---

## Task 1: `cancelFulfillment` throws `MedusaError(NOT_ALLOWED)` on `status_not_cancellable`, plus the reconcile diagnostic

**Files:**
- Modify: `src/providers/ongoing-fulfillment/service.ts`
- Modify: `src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`
- Create: `scripts/diagnose-cancel-mismatch.sql`

**Interfaces:**
- Consumes:
  - `MedusaError` from `@medusajs/framework/utils` (already imported at `service.ts:1`) — `MedusaError.Types.NOT_ALLOWED` (verified enum value, Decision 1).
  - `CancelDecision.reason` from `src/workflows/steps/decide-ongoing-cancel.ts:9-15` — the literal string `"status_not_cancellable"` is the one this task branches on; no changes to that file.
- Produces: no new exports. `cancelFulfillment`'s return shape (`{ ...data, canceled: boolean, reason: string }`) is unchanged for every reason except `status_not_cancellable`, which now throws instead of returning.

- [ ] **Step 1: Write the failing tests**

Read the current test file first (`src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`) to confirm the mock scaffolding (`run`, `workflowFactory`, `makeService`) still matches what's below — if `makeService`/`run`/`workflowFactory` have changed since this plan was written, adapt the added tests to the current scaffolding rather than duplicating it.

Add this import to the top of the file, alongside the existing `OngoingApiError` import:

```ts
import { MedusaError } from "@medusajs/framework/utils"
```

Add these tests inside the existing `describe("OngoingFulfillmentProviderService.cancelFulfillment", ...)` block, after the existing `"does not throw on a benign already-cancelled workflow result"` test:

```ts
  it("throws a NOT_ALLOWED MedusaError when the workflow decides status_not_cancellable (#109)", async () => {
    run.mockResolvedValue({
      result: {
        shouldCancel: false,
        reason: "status_not_cancellable",
        orderSyncId: "osync_1",
      },
    })
    const { service } = makeService()

    const error = await service
      .cancelFulfillment({ ongoing_order_number: "1001-abc" })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MedusaError)
    expect((error as MedusaError).type).toBe(MedusaError.Types.NOT_ALLOWED)
  })

  it.each(["already_cancelled", "no_sync_row", "no_ongoing_order_id"] as const)(
    "resolves without throwing for the benign no-op reason %s (#109 boundary)",
    async (reason) => {
      run.mockResolvedValue({ result: { shouldCancel: false, reason } })
      const { service } = makeService()

      const result = await service.cancelFulfillment({
        ongoing_order_number: "1001-abc",
      })

      expect(result.canceled).toBe(false)
      expect(result.reason).toBe(reason)
    }
  )
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`
Expected: the `"throws a NOT_ALLOWED MedusaError..."` test FAILS — `error` resolves to a plain object (`{ canceled: false, reason: "status_not_cancellable", ... }`), not a `MedusaError` instance, so `expect(error).toBeInstanceOf(MedusaError)` fails. The `it.each` benign-reason tests PASS already (current code already resolves for those reasons) — that is expected; they exist to pin the boundary so a future change can't accidentally widen the throw.

- [ ] **Step 3: Re-read the current file and implement the throw**

Open `src/providers/ongoing-fulfillment/service.ts`. Re-read it first — line numbers in this plan (`~218-289`) may have drifted since this plan was written; locate the method by name (`async cancelFulfillment(`) instead of by line number.

Replace the JSDoc block directly above `async cancelFulfillment(`:

```ts
  /**
   * Medusa's fulfillment module-service calls
   * `provider.cancelFulfillment(provider_id, fulfillment.data ?? {})`, so this
   * method receives ONLY the stashed `data` — no fulfillment row, items, or
   * location argument. It reads the order identifiers out of `data` and runs the
   * idempotent `cancelOngoingOrderWorkflow` (#28); all cancellation gating and
   * already-cancelled handling lives in that workflow. This method is a thin,
   * defensive adapter: it never throws on a benign already-cancelled or
   * missing-identifier path, but it lets genuine retryable failures propagate so
   * Medusa can surface a retry. Converges safely with the `order.canceled`
   * subscriber (#32) because the workflow is idempotent.
   */
```

with:

```ts
  /**
   * Medusa's fulfillment module-service calls
   * `provider.cancelFulfillment(provider_id, fulfillment.data ?? {})`, so this
   * method receives ONLY the stashed `data` — no fulfillment row, items, or
   * location argument. It reads the order identifiers out of `data` and runs the
   * idempotent `cancelOngoingOrderWorkflow` (#28); all cancellation gating and
   * already-cancelled handling lives in that workflow. This method resolves
   * (never throws) on a genuine no-op decision reason — `already_cancelled`,
   * `no_sync_row`, `no_ongoing_order_id`, or a missing identifier — because none
   * of those describe a real Ongoing order that is still shipping. It THROWS a
   * `MedusaError(NOT_ALLOWED)` for `status_not_cancellable` (#109): that reason
   * means the `OngoingOrderSync` row AND the Ongoing order both exist and
   * Ongoing's own status says it can no longer be cancelled there, so this
   * method must NOT resolve — Medusa's core `FulfillmentModuleService
   * .cancelFulfillment` (verified against `@medusajs/fulfillment` 2.16.0,
   * `fulfillment-module-service.js:711-728`) only inspects throw/no-throw and
   * unconditionally sets `fulfillment.canceled_at` on any non-throwing return.
   * It also lets genuine retryable failures propagate so Medusa can surface a
   * retry. Converges safely with the `order.canceled` subscriber (#32) because
   * that subscriber calls `cancelOngoingOrderWorkflow` directly (not through
   * this method) and already never throws out of its own per-row try/catch —
   * this method's new throw does not change that call site (#109).
   */
```

Replace the tail of the method (from the comment above the workflow `run` call through the final `return`):

```ts
    // The workflow is idempotent and status-gated (#28). A `retryable` error
    // propagates here so Medusa surfaces a retry; benign already-cancelled
    // outcomes resolve via the decision result (no throw).
    const { result } = await cancelOngoingOrderWorkflow(container).run({ input })

    return {
      ...data,
      canceled: Boolean(result?.shouldCancel),
      reason: result?.reason ?? "unknown",
    }
  }
```

with:

```ts
    // The workflow is idempotent and status-gated (#28). A `retryable` error
    // propagates here so Medusa surfaces a retry; benign no-op outcomes
    // (already_cancelled / no_sync_row / no_ongoing_order_id) resolve via the
    // decision result (no throw) because none of them describe a real Ongoing
    // order that is still shipping.
    const { result } = await cancelOngoingOrderWorkflow(container).run({ input })

    // status_not_cancellable is the one reason where a real Ongoing order is
    // known to exist and Ongoing itself refuses the cancel because its status
    // has moved past the integration's cancellable window. Resolving here
    // would let Medusa's core module-service mark the fulfillment cancelled
    // while Ongoing keeps shipping it (#109) — throw instead so canceled_at is
    // never set.
    if (result?.reason === "status_not_cancellable") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `[ongoing] cannot cancel fulfillment: Ongoing order ` +
          `${ongoingOrderNumber ?? medusaFulfillmentId ?? medusaOrderId} has moved ` +
          `past its integration's cancellable status window; Ongoing will ` +
          `continue shipping it.`
      )
    }

    return {
      ...data,
      canceled: Boolean(result?.shouldCancel),
      reason: result?.reason ?? "unknown",
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`
Expected: PASS (7 tests: the 4 pre-existing tests + the new throw test + the 3-case `it.each` boundary test).

- [ ] **Step 5: Run the full unit suite to confirm no regression**

Run: `yarn test`
Expected: PASS — all suites green, including `src/subscribers/__tests__/order-canceled.test.ts` and `src/workflows/steps/__tests__/decide-ongoing-cancel.test.ts` (neither should be affected by this change, per Decision 3, but confirm here rather than assume).

- [ ] **Step 6: Build the plugin to validate compilation**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`.

- [ ] **Step 7: Lint**

Run: `yarn lint`
Expected: no new errors from the two modified files.

- [ ] **Step 8: Create the diagnostic SQL script**

Create `scripts/diagnose-cancel-mismatch.sql`:

```sql
-- Diagnostic (issue #109): find fulfillments where Medusa's core
-- `fulfillment.canceled_at` was set while the Ongoing order behind it is NOT
-- actually cancelled at Ongoing.
--
-- Root cause: before this fix, `OngoingFulfillmentProviderService
-- .cancelFulfillment` returned `{ canceled: false, reason: "status_not_cancellable" }`
-- WITHOUT throwing when Ongoing's own status had moved past the integration's
-- `cancellable_status_codes` window. Medusa's core `FulfillmentModuleService
-- .cancelFulfillment` (verified @medusajs/fulfillment 2.16.0,
-- fulfillment-module-service.js:711-728) only inspects throw/no-throw and
-- unconditionally sets `fulfillment.canceled_at` on any non-throwing return —
-- so any fulfillment cancelled BEFORE this fix shipped may still be shipping
-- at Ongoing while Medusa shows it as cancelled.
--
-- This is a DIAGNOSTIC query only — it does not repair anything. A row
-- returned here needs a human to check the order in Ongoing's own UI/API and
-- decide: cancel it there manually, or (if Ongoing already shipped it)
-- correct the Medusa side to reflect that. Do not run an UPDATE off the back
-- of this query without checking Ongoing first — Ongoing is the system of
-- record for shipping state, not Medusa.
--
-- Run against the CONSUMING Medusa app's Postgres database (this plugin repo
-- has no database of its own). Both tables live in that same database:
-- `fulfillment` from `@medusajs/fulfillment`, `ongoing_order_sync` from this
-- plugin's `ongoing` module (see src/modules/ongoing/models/order-sync.ts).
--
--   psql "$DATABASE_URL" -f scripts/diagnose-cancel-mismatch.sql

SELECT
  f.id           AS medusa_fulfillment_id,
  f.canceled_at  AS medusa_canceled_at,
  s.id           AS ongoing_order_sync_id,
  s.ongoing_order_number,
  s.ongoing_order_id,
  s.sync_state   AS ongoing_sync_state,
  s.latest_status_code,
  s.latest_status_text
FROM fulfillment f
JOIN ongoing_order_sync s
  ON s.medusa_fulfillment_id = f.id
WHERE f.canceled_at IS NOT NULL
  AND s.sync_state <> 'cancelled'
ORDER BY f.canceled_at DESC;
```

- [ ] **Step 9: Verify the diagnostic script by inspection**

There is no database in this repo to run the query against. Verify instead by inspection:
- Column names on the `ongoing_order_sync` side (`id`, `medusa_fulfillment_id`, `ongoing_order_number`, `ongoing_order_id`, `sync_state`, `latest_status_code`, `latest_status_text`) match `src/modules/ongoing/models/order-sync.ts:3-23` exactly.
- `f.id` / `f.canceled_at` match the core `fulfillment` model's standard columns (`id`, `canceled_at`) used identically elsewhere in this codebase, e.g. the JSDoc quote of `fulfillment-module-service.js` above (`fulfillment.canceled_at`).
- If a consuming Medusa app with a live Postgres database is available at implementation time, additionally run `psql "$DATABASE_URL" -f scripts/diagnose-cancel-mismatch.sql` and confirm it executes without a syntax/column error (0 rows back is a valid, expected result on a fresh install).

- [ ] **Step 10: Commit**

```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts scripts/diagnose-cancel-mismatch.sql
git commit -m "fix(ongoing-provider): cancelFulfillment throws NOT_ALLOWED on status_not_cancellable instead of silently succeeding (#109)"
```

---

## Self-Review (completed during planning)

- **Issue #109 coverage:**
  - MedusaError type decided and justified (`NOT_ALLOWED`, not the issue's suggested-but-nonexistent `INVALID_STATE`) — Decision 1 ✓
  - `no_identifier` sub-case decided (stays silent) with justification tied to the verified `createFulfillment` stash-shape fact — Decision 2 ✓
  - `order.canceled` subscriber impact analyzed: no code change, gate still correct — Decision 3, verified against `order-canceled.ts:65-93` and core's `cancelValidateOrder` requiring all fulfillments already canceled before `order.canceled` fires ✓
  - Test cases: idempotent already-cancelled resolves (pre-existing test, unchanged + pinned again in the `it.each`), non-cancellable throws a distinguishable `MedusaError` (`instanceof MedusaError` + `.type === NOT_ALLOWED`), no-identifier throws — decided to NOT throw, and the pre-existing `"is an idempotent no-op..."` test already pins that; Task 1 Step 1 adds the new throw test + the 3-reason boundary table ✓
  - Data repair: diagnostic SQL + explicit no-auto-repair note — Decision 4, Task 1 Steps 8-9 ✓
  - Boundary with #111 stated explicitly; `cancel-ongoing-order.ts` is not touched ✓
- **Placeholder scan:** every step has complete, exact code (imports, full test bodies, full replacement blocks, full SQL file). No "TBD"/"handle appropriately"/"similar to above" language. ✓
- **Type consistency:** `MedusaError.Types.NOT_ALLOWED` matches the verified enum; `CancelDecision.reason` literals (`"status_not_cancellable"`, `"already_cancelled"`, `"no_sync_row"`, `"no_ongoing_order_id"`) match `decide-ongoing-cancel.ts:9-15` verbatim; the SQL column names match `order-sync.ts:3-23` verbatim. ✓
- **Task granularity:** kept to a single task — the business-logic fix keeps its full failing-test-first TDD cycle and review; the diagnostic SQL (scaffolding, no test harness) is folded into the same task's trailing steps rather than spawning a second implement+review round, per the coarse-decomposition guidance for trivial/scaffolding work. ✓

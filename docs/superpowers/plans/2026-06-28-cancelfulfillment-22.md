# cancelFulfillment Provider Method Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `cancelFulfillment(data)` on `OngoingFulfillmentProviderService` (issue #22) so that, given only the stashed fulfillment `data`, it resolves the warehouse and runs the idempotent `cancelOngoingOrderWorkflow` (#28) to cancel the order in Ongoing.

**Architecture:** Medusa's fulfillment module-service calls `provider.cancelFulfillment(provider_id, fulfillment.data ?? {})` — the provider method therefore receives **only** the stashed `data` object (no fulfillment row, items, or location arg). The method reads `{ ongoing_order_number, ongoing_order_id, location_id, credential_key }` out of `data`, resolves the warehouse (credential key directly, or via `getIntegrationByLocation(location_id)` as a fallback), then invokes `cancelOngoingOrderWorkflow` keyed on the order identifiers. All cancellation gating/idempotency lives in the workflow (#28); this method is a thin, defensive adapter that is itself idempotent (returns a benign result instead of throwing on missing identifiers or already-cancelled state).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `AbstractFulfillmentProviderService`, `@medusajs/framework/workflows-sdk`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests with mocked dependencies (no DB / no running Medusa).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes); resolved from the container with `container.resolve("ongoing")` → `OngoingModuleService` (`ONGOING_MODULE` in `src/modules/ongoing/index.ts`).
- Fulfillment provider lives at `src/providers/ongoing-fulfillment/` (per spec §5 / §14). Exported via `@org/plugin/providers/*` → `src/providers/ongoing-fulfillment/index.ts`.
- Prices/quantities stored as-is — never ×100 or ÷100.
- Plugin build output is `.medusa/server`; verify with `yarn build`.
- TDD: a **failing Jest unit test** comes before the implementation; the test mocks `cancelOngoingOrderWorkflow` and the `"ongoing"` module service (per the M1 plan, plugin tests are pure unit tests with mocked dependencies — there is no DB or running Medusa in this repo).

---

## Background — verified facts the implementer must not re-derive

- **`cancelFulfillment` signature (verified against 2.16.0 source):**
  `cancelFulfillment(data: Record<string, unknown>): Promise<any>`. The module-service calls
  `fulfillmentProviderService_.cancelFulfillment(provider_id, fulfillment.data ?? {})` — the
  **only** argument is the stashed `fulfillment.data`. There is **no** fulfillment row, no items
  array, and no location argument. Everything must be resolved from `data`.
- **What `data` contains** (set by `createFulfillment` in #21, spec §5):
  `{ ongoing_order_number, ongoing_order_id, location_id, credential_key }`. All four are what
  `createFulfillment` returns as `data`. Any of them may be absent if the original push failed
  before stashing — handle defensively.
- **`cancelOngoingOrderWorkflow` (from #28, verified against `docs/superpowers/plans/2026-06-28-cancelongoingorder-28.md`):**
  - Import: `import { cancelOngoingOrderWorkflow } from "../../workflows"` (barrel re-export) or
    `from "../../workflows/cancel-ongoing-order"`.
  - Input type `CancelOngoingOrderInput = { medusa_order_id?: string; medusa_fulfillment_id?: string; ongoing_order_number?: string }`.
  - The decision step prefers `ongoing_order_number`, then `medusa_fulfillment_id`, then `medusa_order_id`.
  - Run shape (Medusa workflows-sdk): `await cancelOngoingOrderWorkflow(container).run({ input })`
    → returns `{ result }` where `result` is a `CancelDecision`
    `{ shouldCancel: boolean; reason: "ok" | "no_sync_row" | "already_cancelled" | "no_ongoing_order_id" | "status_not_cancellable"; orderSyncId?; ongoingOrderId?; credentialKey? }`.
  - The workflow is **fully idempotent**: it short-circuits (`shouldCancel:false`) on already-cancelled / non-cancellable / missing sync row, and its cancel step swallows already-cancelled 4xx. This method does **not** re-implement any of that gating.
- **Two converging triggers** (spec §5, §8): this provider method (#22) and the `order.canceled`
  subscriber (#32) both route to `cancelOngoingOrderWorkflow`; convergence is safe because the
  workflow is idempotent.
- **Idempotency at the Medusa layer:** Medusa only invokes `provider.cancelFulfillment` when
  `!fulfillment.canceled_at`, so a single fulfillment is never cancelled twice through this path.
- **`AbstractFulfillmentProviderService.cancelFulfillment`** in the base class is a no-op/throw
  stub; overriding it is required for cancellation to reach Ongoing.
- **Warehouse resolution:** the workflow keys off the `OngoingOrderSync` row (which already carries
  `ongoing_order_id` + the integration), so this method does **not** need to build a client itself.
  It only needs to pass the order identifiers. `credential_key` / `location_id` in `data` are used
  defensively (logging + future-proofing); if the workflow ever needs the credential key it derives
  it from the sync row's integration. We still resolve `getIntegrationByLocation(location_id)` only
  as a **fallback log/diagnostic** when `data` has neither order identifier — there is otherwise
  nothing to cancel.

---

## File Structure

This task assumes #20 has produced `src/providers/ongoing-fulfillment/service.ts` exporting
`OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService`, and #28 has produced
`cancelOngoingOrderWorkflow`. `cancelFulfillment` is **added as a method** to that existing class.

**Create:**
- `src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts` — unit test for the method (mocks the workflow + module service).

**Modify:**
- `src/providers/ongoing-fulfillment/service.ts` — add the `cancelFulfillment` method (and its imports).

> **Pre-flight (do this first, before Task 1):** Confirm #20 and #28 are merged.
> - `test -f src/providers/ongoing-fulfillment/service.ts` and confirm it exports a class extending `AbstractFulfillmentProviderService`. If it does not exist, **stop** — #20 is the blocker for this issue.
> - `test -f src/workflows/cancel-ongoing-order.ts` and confirm `cancelOngoingOrderWorkflow` is exported (directly and/or via `src/workflows/index.ts`). If it does not exist, **stop** — #28 is the blocker.
> - Open `service.ts` and note: (a) the exact class name (expected `OngoingFulfillmentProviderService`), (b) whether the constructor already captures the container/logger (e.g. `protected readonly logger_` or a stored `container_`), so the new method can resolve the container and log consistently with the rest of the class. If the class does not retain a container reference, the method resolves the workflow via the stored container captured in the constructor — adapt the access path to match what #20 implemented (the test below injects a fake container, so the production access path is the only thing to align).

---

## Task 1: `cancelFulfillment` resolves the warehouse from `data` and runs the idempotent workflow

**Files:**
- Modify: `src/providers/ongoing-fulfillment/service.ts`
- Test: `src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`

**Interfaces:**
- Consumes:
  - `cancelOngoingOrderWorkflow` from `../../workflows` (#28) — `cancelOngoingOrderWorkflow(container).run({ input })` → `{ result: CancelDecision }`, with `CancelOngoingOrderInput = { medusa_order_id?, medusa_fulfillment_id?, ongoing_order_number? }`.
  - The `"ongoing"` module service (#52, `src/modules/ongoing/service.ts`): `getIntegrationByLocation(stockLocationId)` — used only as a diagnostic fallback.
  - The provider's stored container reference set up by #20 (the constructor receives `(container, options)`).
- Produces, on `OngoingFulfillmentProviderService`:
  - `type OngoingFulfillmentData = { ongoing_order_number?: string; ongoing_order_id?: number; location_id?: string; credential_key?: string }` — the shape `createFulfillment` (#21) stashes.
  - `async cancelFulfillment(data: Record<string, unknown>): Promise<Record<string, unknown>>` — resolves the order identifiers from `data`, runs `cancelOngoingOrderWorkflow`, and returns a benign result object `{ canceled: boolean; reason: string }` (never throws on a benign already-cancelled / missing-identifier path). Returns the **same `data`-derived** object Medusa expects back (Medusa persists the return as the fulfillment `data`); returning the original `data` merged with the cancel outcome is safe.

Notes for the implementer:
- The method is a plain `async` method (not a workflow composition) — `if`/`?.`/`??` are all allowed here.
- **Identifier extraction:** read `ongoing_order_number` (string) and `ongoing_order_id` (number) from `data`. The workflow only needs identifiers it can use to find the `OngoingOrderSync` row; `ongoing_order_number` is the strongest key (the upsert key), so pass it through. Also pass `medusa_fulfillment_id`/`medusa_order_id` **only if present in `data`** (they may not be — `createFulfillment` stashes the four fields above; do not fabricate ids).
- **Nothing-to-cancel short-circuit (idempotent no-op):** if `data` has neither `ongoing_order_number` nor any medusa id, there is no way to locate a sync row → return `{ ...data, canceled: false, reason: "no_identifier" }` without calling the workflow. Optionally call `getIntegrationByLocation(data.location_id)` first purely to log a diagnostic if a `location_id` is present; do not throw.
- **Run the workflow** with `{ input: { ongoing_order_number, medusa_fulfillment_id, medusa_order_id } }` (omit undefined keys). The workflow returns a `CancelDecision`; map `result.shouldCancel` / `result.reason` into the return value.
- **Do not throw on benign outcomes.** The workflow itself swallows already-cancelled 4xx (returns `shouldCancel:true` after a swallowed cancel, or `shouldCancel:false, reason:"already_cancelled"`). A thrown error only escapes the workflow on a `retryable` failure (429/5xx/network); let that propagate so Medusa surfaces a retryable failure — but a benign already-cancelled response must resolve, never throw. The tests below pin both.
- Resolve the container the same way #20's other methods do. In the test, the container is injected; in production use the container captured by the constructor as `this.container_` (the field #20 sets — #21 uses it directly). The workflow factory is invoked as `cancelOngoingOrderWorkflow(container)`.

- [ ] **Step 1: Write the failing test**

Create `src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`:
```ts
import { OngoingApiError } from "../../../lib/ongoing/errors"

// Mock the workflows barrel so the provider's `cancelOngoingOrderWorkflow` import is a jest fn.
const run = jest.fn()
const workflowFactory = jest.fn().mockReturnValue({ run })
jest.mock("../../../workflows", () => ({
  cancelOngoingOrderWorkflow: (container: unknown) => workflowFactory(container),
}))

// Import AFTER the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: OngoingFulfillmentProviderService } = require("../service")

const makeService = (serviceOverrides: any = {}) => {
  const ongoingService = {
    getIntegrationByLocation: jest.fn().mockResolvedValue({ id: "oint_1", credential_key: "wh-a" }),
    ...serviceOverrides,
  }
  const container = { resolve: (key: string) => (key === "ongoing" ? ongoingService : undefined) }
  // #20's constructor is (container, options). options can be a minimal valid object.
  const service = new OngoingFulfillmentProviderService(container, {})
  // Ensure the method can reach the injected container via #20's storage field.
  ;(service as any).container_ = container
  return { service, container, ongoingService }
}

describe("OngoingFulfillmentProviderService.cancelFulfillment", () => {
  beforeEach(() => {
    run.mockReset()
    workflowFactory.mockClear()
  })

  it("resolves identifiers from data and runs cancelOngoingOrderWorkflow", async () => {
    run.mockResolvedValue({ result: { shouldCancel: true, reason: "ok", ongoingOrderId: 999 } })
    const { service, container } = makeService()

    const data = {
      ongoing_order_number: "1001-abc",
      ongoing_order_id: 999,
      location_id: "sloc_1",
      credential_key: "wh-a",
    }

    const result = await service.cancelFulfillment(data)

    // Workflow built with the provider's container.
    expect(workflowFactory).toHaveBeenCalledWith(container)
    // Run called with the order-number key derived from data.
    expect(run).toHaveBeenCalledTimes(1)
    const runArg = run.mock.calls[0][0]
    expect(runArg.input.ongoing_order_number).toBe("1001-abc")
    // Returns a benign outcome carrying the cancel result.
    expect(result.canceled).toBe(true)
    expect(result.reason).toBe("ok")
  })

  it("is an idempotent no-op (does not call the workflow) when data has no identifier", async () => {
    const { service } = makeService()

    const result = await service.cancelFulfillment({ location_id: "sloc_1" })

    expect(run).not.toHaveBeenCalled()
    expect(result.canceled).toBe(false)
    expect(result.reason).toBe("no_identifier")
  })

  it("does not throw on a benign already-cancelled workflow result", async () => {
    run.mockResolvedValue({ result: { shouldCancel: false, reason: "already_cancelled" } })
    const { service } = makeService()

    const result = await service.cancelFulfillment({ ongoing_order_number: "1001-abc" })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result.canceled).toBe(false)
    expect(result.reason).toBe("already_cancelled")
  })

  it("propagates a retryable error so Medusa can surface a retry", async () => {
    run.mockRejectedValue(new OngoingApiError("down", { status: 503, kind: "retryable" }))
    const { service } = makeService()

    await expect(
      service.cancelFulfillment({ ongoing_order_number: "1001-abc" })
    ).rejects.toBeInstanceOf(OngoingApiError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`
Expected: FAIL — `service.cancelFulfillment is not a function` (the method does not exist yet). If it instead fails to import `../service`, #20 is not merged — stop and resolve the blocker.

- [ ] **Step 3: Add the type + method to the provider service**

In `src/providers/ongoing-fulfillment/service.ts`, add the workflow import near the top (alongside the existing imports #20 created):
```ts
import { cancelOngoingOrderWorkflow } from "../../workflows"
```

Add the stashed-data type above the class (or in a shared types file if #20 created one — keep it co-located if not):
```ts
export type OngoingFulfillmentData = {
  ongoing_order_number?: string
  ongoing_order_id?: number
  location_id?: string
  credential_key?: string
  medusa_order_id?: string
  medusa_fulfillment_id?: string
}
```

Add the method inside the `OngoingFulfillmentProviderService` class body:
```ts
  async cancelFulfillment(
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const stashed = (data ?? {}) as OngoingFulfillmentData

    const ongoingOrderNumber =
      typeof stashed.ongoing_order_number === "string" ? stashed.ongoing_order_number : undefined
    const medusaFulfillmentId =
      typeof stashed.medusa_fulfillment_id === "string" ? stashed.medusa_fulfillment_id : undefined
    const medusaOrderId =
      typeof stashed.medusa_order_id === "string" ? stashed.medusa_order_id : undefined

    // Resolve the container the same way the rest of this provider does (#20):
    // the constructor captures it as `this.container_` (the same field #21 uses).
    const container = (this as any).container_

    // Idempotent no-op: nothing in `data` lets us locate an OngoingOrderSync row.
    if (!ongoingOrderNumber && !medusaFulfillmentId && !medusaOrderId) {
      if (typeof stashed.location_id === "string") {
        // Diagnostic only; never throws.
        try {
          const ongoing = container.resolve("ongoing") as any
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

> NOTE on the container field name: #20's `service.ts` captures the injected container as
> `this.container_` (and #21 already reads it directly), so this method uses `this.container_`.
> Do not introduce a second container field.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full unit suite to confirm no regression**

Run: `yarn test`
Expected: PASS (all suites green — provider cancel tests plus all pre-existing M1 + #28 suites).

- [ ] **Step 6: Build the plugin to validate compilation**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`. This confirms the workflow import path (`../../workflows`) resolves and the method signature is compatible with `AbstractFulfillmentProviderService`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/__tests__/cancel-fulfillment.test.ts
git commit -m "feat(ongoing-provider): cancelFulfillment resolves warehouse from data, runs idempotent cancelOngoingOrder (#22)"
```

---

## Self-Review (completed during planning)

- **Issue #22 coverage:**
  - `cancelFulfillment` receives ONLY `data` → method signature `cancelFulfillment(data: Record<string, unknown>)`, no fulfillment/items/location args (matches verified 2.16.0 module-service call) ✓
  - Resolves warehouse from the stashed `{ ongoing_order_number, ongoing_order_id, location_id, credential_key }` → method reads those fields, passes `ongoing_order_number` (+ any medusa ids) to the workflow; uses `getIntegrationByLocation(location_id)` as a diagnostic fallback ✓
  - Runs the idempotent `cancelOngoingOrder` workflow (#28) → `cancelOngoingOrderWorkflow(container).run({ input })`, decision-result mapped to the return ✓
  - Idempotency: (1) Medusa only invokes when `!canceled_at` (documented in Background, not re-implemented), (2) workflow itself idempotent — method adds a no-op when no identifier and never throws on benign already-cancelled (tests pin both) ✓
  - Converges with #32 `order.canceled` on the same workflow → documented; both pass identifiers to the same idempotent workflow ✓
- **Tests-to-specify checklist (from the issue):**
  - Resolve warehouse from `data` + invoke `cancelOngoingOrder` with right id/credential key → test 1 (asserts `workflowFactory(container)` + `run` input `ongoing_order_number`) ✓
  - Idempotent no-op when already cancelled → test 3 (`already_cancelled` result, no throw) ✓
  - Does not throw on benign already-cancelled response → test 3 resolves; test 4 confirms only genuine retryable errors propagate ✓
  - (Bonus) no-op when `data` has no identifier → test 2 ✓
  - `yarn build` step → Task 1 Step 6 ✓
- **Placeholder scan:** every code step has complete code. The two explicit verify-points (container field name, #20/#28 pre-flight existence) state the exact resolution method and are not missing content ✓
- **Type consistency:** `OngoingFulfillmentData` field names match the spec §5 `createFulfillment` return (`ongoing_order_number`, `ongoing_order_id`, `location_id`, `credential_key`); `cancelOngoingOrderWorkflow` input keys (`ongoing_order_number`, `medusa_fulfillment_id`, `medusa_order_id`) and `CancelDecision` fields (`shouldCancel`, `reason`) match #28's plan verbatim; `.run({ input })` → `{ result }` matches the workflows-sdk run contract used in the #28 plan ✓

## Verify-points carried at implementation time

- **Container access field** on `OngoingFulfillmentProviderService` — #20 stores it as
  `this.container_` (the field #21 reads directly); use that single path.
- **Workflow run return shape** — `cancelOngoingOrderWorkflow(container).run({ input })` returns
  `{ result }`. Confirm against the installed `@medusajs/framework` 2.16.0 if the first integration
  surfaces a different envelope (the unit test mocks `run` to return `{ result }`, matching the
  documented contract).
- **`createFulfillment` stash shape (#21)** — this method consumes `ongoing_order_number` as the
  primary key. If #21 ends up stashing additional `medusa_fulfillment_id`/`medusa_order_id`, they
  are passed through automatically; if it stashes neither and `ongoing_order_number` is absent on a
  failed push, the `no_identifier` no-op path handles it.

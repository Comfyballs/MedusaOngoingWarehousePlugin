# createFulfillment → pushOrderToOngoing Wiring (Issue #21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `OngoingFulfillmentProviderService.createFulfillment` so that, when a Medusa fulfillment is created at an Ongoing-bound stock location, it synchronously pushes the order to Ongoing (via the `pushOrderToOngoing` workflow) and stashes `{ ongoing_order_number, ongoing_order_id, location_id, credential_key }` onto the fulfillment row.

**Architecture:** `createFulfillment` reads the (hydrated) `fulfillment.id` + `fulfillment.location_id`, resolves the Ongoing integration for that location through the existing `ongoing` module service (`getIntegrationByLocation` → `credential_key`) **only to obtain `credential_key` for the returned stash**, runs `pushOrderToOngoing` with input `{ fulfillment_id: fulfillment.id }` (the workflow re-queries the full order and re-derives its own integration context), and returns the stash as `result.data` (persisted onto the fulfillment) with `labels: []`. The push runs **synchronously inside `createFulfillment`**, resolving the Medusa container/workflow via provider DI (`this.container_`). A missing `location_id` throws a terminal, operator-readable error so the module-service deletes the just-created fulfillment and surfaces a clean failure. `cancelFulfillment` (#22) later reads only `data`, so `credential_key` MUST be in the stash.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `AbstractFulfillmentProviderService`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (mocked deps, no live DB), native `fetch` (Node ≥20).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase module names; never dashes). The provider lives at `src/providers/ongoing-fulfillment/` (directory name with a dash is fine; it maps via the `exports` key `./providers/*`).
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100.
- Plugin build output is `.medusa/server`; the provider is published via `exports["./providers/*"] → ./.medusa/server/src/providers/*/index.js`.
- Credentials are NEVER persisted in the DB — they come from plugin options via the `ongoing` module service helpers.
- This is a **plugin**, not an app: there is no local Postgres/Medusa instance, so all tests here are **pure unit tests** with mocked dependencies (mocked `ongoing` service + mocked `pushOrderToOngoing`). No DB.
- TDD: a failing Jest unit test is written and run (must fail) **before** the implementation of each behavior.

---

## Dependencies (read before starting)

This plan **adds a method to an existing class** and **calls an existing workflow**. Both are produced by sibling issues:

- **#20 — provider class scaffold.** Produces `src/providers/ongoing-fulfillment/service.ts` exporting `class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService` with `static identifier = "ongoing"`, a constructor receiving `(container, options)` via DI (stores the injected container as `this.container_` so workflows can be run), and `src/providers/ongoing-fulfillment/index.ts` exporting it via `ModuleProvider(Modules.FULFILLMENT, { services: [OngoingFulfillmentProviderService] })`. **If #20 is not yet merged when this task runs, Task 0 below creates the minimal scaffold so this plan is self-contained; if #20 exists, Task 0 only verifies/aligns the constructor + container handle.**
- **#26 — `pushOrderToOngoing` workflow.** Produces `pushOrderToOngoing` exported from `src/workflows/index.ts`. Signature used by this plan (canonical M2 contract):

  ```ts
  // pushOrderToOngoing.run({ input }) resolves to { result: { ongoingOrderId: number; orderNumber: string } }
  pushOrderToOngoing(container).run({
    input: { fulfillment_id: string },
  }): Promise<{ result: { ongoingOrderId: number; orderNumber: string } }>
  ```

  The workflow's INPUT is exactly `{ fulfillment_id: string }`. It **re-queries the full order itself** via `query.graph` from the linked order id, resolves SKUs, maps, upserts, and **re-derives its own integration context** — `createFulfillment` does NOT pass order/items/location/credential into it. This plan references the workflow **by name only** and mocks it in tests; do not implement it here.

### Existing symbols this plan consumes (verified)

From `src/modules/ongoing/service.ts`:
- `getIntegrationByLocation(stockLocationId: string)` → resolves the single enabled `OngoingIntegration` row for a location or `undefined`. The row carries `credential_key`.
- `getCredentials(credentialKey)` / `getClient(credentialKey)` — not needed by `createFulfillment` directly (the workflow uses them); listed for context.

From `src/modules/ongoing/index.ts`: `ONGOING_MODULE = "ongoing"` (the registration name to `container.resolve(ONGOING_MODULE)`).

### Verified Medusa 2.16.0 `createFulfillment` contract

```ts
createFulfillment(
  data: Record<string, unknown>,
  items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
  order: Partial<FulfillmentOrderDTO> | undefined,
  fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
): Promise<CreateFulfillmentResult>

type CreateFulfillmentResult = {
  data: Record<string, unknown>                 // persisted onto the fulfillment row
  labels: { tracking_number: string; tracking_url: string; label_url: string }[]
}
```

- `order` may be `undefined` and `items` are thin → **do NOT rely on them**; the workflow re-queries the order.
- `fulfillment.location_id` **IS** hydrated in the 4th arg (module-service passes the fulfillment with only `provider_id`/`data`/`items` omitted; `location_id` is a persisted, non-null column). `fulfillment.id` is present. Still guard for `undefined` and log once during a dev fulfillment.
- On a thrown error, the module-service deletes the just-created fulfillment and rethrows — so throwing a terminal error on missing `location_id` yields a clean operator-visible failure (do NOT guess a warehouse).

---

## File Structure

**Create (only if #20 not yet merged — see Task 0):**
- `src/providers/ongoing-fulfillment/service.ts` — provider class scaffold (minimal: extends `AbstractFulfillmentProviderService`, `static identifier`, DI constructor holding the container).
- `src/providers/ongoing-fulfillment/index.ts` — `ModuleProvider` export.

**Modify (the core of this issue):**
- `src/providers/ongoing-fulfillment/service.ts` — add the `createFulfillment` method.

**Create (tests):**
- `src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts`

---

## Task 0: Dev spike — confirm the provider can resolve the container/workflow inside `createFulfillment`, and establish the scaffold

> **Why first:** the approved design runs the push synchronously from inside `createFulfillment`, which requires the provider to resolve the Medusa container (to run a workflow) at request time. Per #20's canonical contract the provider stores the injected container as `this.container_`; this spike confirms `this.container_` is populated and resolves a workflow cleanly. If it does NOT (e.g. container unavailable at fulfillment time), the documented fallback is a `fulfillment.created` subscriber that runs `pushOrderToOngoing` and patches the fulfillment `data` — but plan and build for the in-method approach.

**Files:**
- Verify/Create: `src/providers/ongoing-fulfillment/service.ts`
- Verify/Create: `src/providers/ongoing-fulfillment/index.ts`

**Interfaces:**
- Consumes: nothing (scaffold).
- Produces: `class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService` with `static identifier = "ongoing"` and a constructor that stores the injected container as `protected readonly container_: MedusaContainer`. Later steps add `createFulfillment`.

- [ ] **Step 1: Check whether #20 already delivered the scaffold**

Run:
```bash
ls src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/index.ts 2>/dev/null && cat src/providers/ongoing-fulfillment/service.ts
```
Expected: either both files print (use them — skip to Step 4 after confirming the constructor stores the container) or "No such file" (continue to Step 2 to create the scaffold).

- [ ] **Step 2: Create the provider service scaffold (only if missing)**

Create `src/providers/ongoing-fulfillment/service.ts`:
```ts
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

type InjectedDependencies = {
  // resolved-by-name dependencies arrive here; the container itself is the 1st ctor arg
}

class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "ongoing"

  protected readonly container_: MedusaContainer

  // Medusa injects (container, options) into fulfillment provider constructors.
  constructor(container: MedusaContainer, _options: Record<string, unknown>) {
    super()
    this.container_ = container
  }

  async getFulfillmentOptions() {
    return [{ id: "ongoing" }]
  }

  async validateOption(_data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return data
  }

  async canCalculate(): Promise<boolean> {
    return false
  }
}

export default OngoingFulfillmentProviderService
```

> NOTE: the placeholder `getFulfillmentOptions`/`validateOption`/`validateFulfillmentData`/`canCalculate` bodies belong to #20's scope; if #20 already implemented richer versions, keep theirs and only ensure `container_` is stored. Do not regress #20's work.

- [ ] **Step 3: Create the provider index (only if missing)**

Create `src/providers/ongoing-fulfillment/index.ts`:
```ts
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import OngoingFulfillmentProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [OngoingFulfillmentProviderService],
})
```

- [ ] **Step 4: Spike test — prove the container handle can run a workflow**

This is a throwaway confirmation that the in-method approach is viable. Create a temporary spike test `src/providers/ongoing-fulfillment/__tests__/spike-container.test.ts`:
```ts
import OngoingFulfillmentProviderService from "../service"

describe("provider container spike", () => {
  it("stores the injected container and can call .resolve on it", () => {
    const fakeWorkflow = jest.fn()
    const container = { resolve: jest.fn().mockReturnValue("ongoing-service") } as any
    const provider = new OngoingFulfillmentProviderService(container, {})

    // The handle the in-method push relies on: a container we can resolve services from
    // and pass to a workflow factory.
    // @ts-expect-error reading protected member in a unit spike
    expect(provider.container_).toBe(container)
    // @ts-expect-error
    expect(provider.container_.resolve("ongoing")).toBe("ongoing-service")
    expect(fakeWorkflow).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run the spike + build to confirm viability**

Run:
```bash
yarn test src/providers/ongoing-fulfillment/__tests__/spike-container.test.ts
yarn build
```
Expected: spike test PASSES (container is stored and resolvable) and `yarn build` compiles (`AbstractFulfillmentProviderService` + `ModuleProvider` imports resolve, output under `.medusa/server`).

**Decision gate:** if the spike + build pass, the in-method approach is confirmed — proceed to Task 1. If `yarn build` reveals the container cannot be injected into the provider in 2.16.0 (constructor arity mismatch / type error), STOP and switch to the documented fallback: a `src/subscribers/fulfillment-created.ts` subscriber that runs `pushOrderToOngoing` and patches the fulfillment `data`. Record the deviation in the issue before proceeding.

- [ ] **Step 6: Remove the throwaway spike test**

Run:
```bash
rm src/providers/ongoing-fulfillment/__tests__/spike-container.test.ts
```
Expected: file removed (its assertion is subsumed by the real tests in Task 1). The scaffold files remain.

- [ ] **Step 7: Commit the scaffold (only if Task 0 created it)**

If Steps 2–3 created files (i.e. #20 had not merged):
```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/index.ts
git commit -m "feat(ongoing-fulfillment): provider scaffold holding DI container for in-method push (#21)"
```
If #20 already delivered the scaffold, skip this commit (nothing to add).

---

## Task 1: `createFulfillment` — synchronous push + data stash

**Files:**
- Modify: `src/providers/ongoing-fulfillment/service.ts`
- Test: `src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts`

**Interfaces:**
- Consumes:
  - The `ongoing` module service (resolved by `this.container_.resolve("ongoing")`), specifically `getIntegrationByLocation(locationId)` → `{ credential_key: string, ... } | undefined`.
  - `pushOrderToOngoing` from `../../workflows` (#26): `pushOrderToOngoing(this.container_).run({ input: { fulfillment_id } })` → `{ result: { ongoingOrderId, orderNumber } }`.
- Produces, on `OngoingFulfillmentProviderService`:
  - `async createFulfillment(data, items, order, fulfillment): Promise<{ data: Record<string, unknown>; labels: [] }>` returning, on success:
    `{ data: { ongoing_order_number, ongoing_order_id, location_id, credential_key }, labels: [] }`.
  - On `fulfillment.location_id` undefined/empty → throws an `Error` whose message names the missing location and the fulfillment id (terminal, operator-readable); the workflow is NOT called.
  - On no integration for the location → throws an `Error` naming the location (terminal); the workflow is NOT called.

- [ ] **Step 1: Write the failing test**

Create `src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts`:
```ts
import OngoingFulfillmentProviderService from "../service"

// Mock the workflow module so the provider's import resolves to a controllable factory.
jest.mock("../../../workflows", () => ({
  pushOrderToOngoing: jest.fn(),
}))
import { pushOrderToOngoing } from "../../../workflows"

const makeProvider = (ongoingService: any) => {
  const container = { resolve: jest.fn().mockReturnValue(ongoingService) } as any
  return { provider: new OngoingFulfillmentProviderService(container, {}), container }
}

describe("OngoingFulfillmentProviderService.createFulfillment", () => {
  beforeEach(() => {
    ;(pushOrderToOngoing as jest.Mock).mockReset()
  })

  it("resolves the integration, runs the push, and returns the exact stash", async () => {
    const ongoingService = {
      getIntegrationByLocation: jest
        .fn()
        .mockResolvedValue({ credential_key: "warehouse-a", stock_location_id: "loc_1" }),
    }
    const { provider, container } = makeProvider(ongoingService)

    const run = jest.fn().mockResolvedValue({
      result: { ongoingOrderId: 999, orderNumber: "1001-abc" },
    })
    ;(pushOrderToOngoing as jest.Mock).mockReturnValue({ run })

    const result = await provider.createFulfillment(
      {},                                  // data (thin)
      [{ id: "fi_1" }] as any,             // items (thin)
      undefined,                           // order (may be undefined)
      { id: "ful_1", location_id: "loc_1" } as any // fulfillment (hydrated)
    )

    expect(ongoingService.getIntegrationByLocation).toHaveBeenCalledWith("loc_1")
    expect(container.resolve).toHaveBeenCalledWith("ongoing")
    expect(pushOrderToOngoing).toHaveBeenCalledWith(container)
    expect(run).toHaveBeenCalledWith({
      input: { fulfillment_id: "ful_1" },
    })
    expect(result).toEqual({
      data: {
        ongoing_order_number: "1001-abc",
        ongoing_order_id: 999,
        location_id: "loc_1",
        credential_key: "warehouse-a",
      },
      labels: [],
    })
  })

  it("throws a terminal error and never calls the workflow when location_id is undefined", async () => {
    const ongoingService = { getIntegrationByLocation: jest.fn() }
    const { provider } = makeProvider(ongoingService)

    await expect(
      provider.createFulfillment({}, [] as any, undefined, { id: "ful_2" } as any)
    ).rejects.toThrow(/location_id/i)

    expect(pushOrderToOngoing).not.toHaveBeenCalled()
    expect(ongoingService.getIntegrationByLocation).not.toHaveBeenCalled()
  })

  it("throws a terminal error and never calls the workflow when no integration exists for the location", async () => {
    const ongoingService = {
      getIntegrationByLocation: jest.fn().mockResolvedValue(undefined),
    }
    const { provider } = makeProvider(ongoingService)

    await expect(
      provider.createFulfillment({}, [] as any, undefined, {
        id: "ful_3",
        location_id: "loc_x",
      } as any)
    ).rejects.toThrow(/loc_x/)

    expect(pushOrderToOngoing).not.toHaveBeenCalled()
  })
})
```

> NOTE on the mock path: `jest.mock("../../../workflows")` is relative to the test file at `src/providers/ongoing-fulfillment/__tests__/` → resolves to `src/workflows/index.ts`. The provider's own import (Step 3) uses `../../workflows` (relative to `service.ts` at `src/providers/ongoing-fulfillment/`). Both reference the same module; Jest hoists the mock so the provider receives the mocked `pushOrderToOngoing`.

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts`
Expected: FAIL — `provider.createFulfillment is not a function` (method not implemented yet).

- [ ] **Step 3: Implement `createFulfillment`**

In `src/providers/ongoing-fulfillment/service.ts`, add the workflow import near the top (after the existing imports):
```ts
import { pushOrderToOngoing } from "../../workflows"
```

Add the method inside the `OngoingFulfillmentProviderService` class (after the constructor / existing methods):
```ts
  async createFulfillment(
    _data: Record<string, unknown>,
    _items: unknown[],
    _order: unknown,
    fulfillment: { id?: string; location_id?: string }
  ): Promise<{ data: Record<string, unknown>; labels: [] }> {
    const fulfillmentId = fulfillment?.id
    const locationId = fulfillment?.location_id

    // location_id is expected to be hydrated in the 4th arg. Guard + log once so a
    // dev fulfillment surfaces any 2.16.0 hydration surprise; do NOT guess a warehouse.
    if (!locationId) {
      const logger = this.container_.resolve("logger") as { warn: (m: string) => void }
      logger.warn(
        `[ongoing] createFulfillment received fulfillment ${fulfillmentId ?? "<unknown>"} without a location_id`
      )
      throw new Error(
        `[ongoing] cannot push fulfillment ${fulfillmentId ?? "<unknown>"} to Ongoing: ` +
          `fulfillment.location_id is missing. Refusing to guess a warehouse.`
      )
    }

    const ongoingService = this.container_.resolve("ongoing") as {
      getIntegrationByLocation: (
        locationId: string
      ) => Promise<{ credential_key: string } | undefined>
    }

    const integration = await ongoingService.getIntegrationByLocation(locationId)
    if (!integration) {
      throw new Error(
        `[ongoing] no enabled Ongoing integration is bound to stock location "${locationId}"; ` +
          `cannot push fulfillment ${fulfillmentId}.`
      )
    }

    // credential_key is resolved here ONLY for the returned stash; the workflow
    // re-derives its own integration context from the fulfillment id.
    const credentialKey = integration.credential_key

    const { result } = await pushOrderToOngoing(this.container_).run({
      input: {
        fulfillment_id: fulfillmentId as string,
      },
    })

    // credential_key MUST be stashed: cancelFulfillment (#22) receives only `data`.
    return {
      data: {
        ongoing_order_number: result.orderNumber,
        ongoing_order_id: result.ongoingOrderId,
        location_id: locationId,
        credential_key: credentialKey,
      },
      labels: [],
    }
  }
```

> NOTE: `this.container_.resolve("ongoing")` uses the module registration name (`ONGOING_MODULE = "ongoing"`). The `logger` resolve uses Medusa's built-in registration key `"logger"`. Both are framework-standard container keys in 2.16.0.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts`
Expected: PASS (3 tests). The success test asserts the exact stash; both error tests assert a terminal throw with the workflow never invoked.

> NOTE: if the success/error tests fail because `this.container_.resolve("logger")` throws inside the missing-`location_id` path, confirm the test's `container.resolve` mock returns a logger-like object for `"logger"`. The success test never hits the logger path; the undefined-`location_id` test does. Adjust the test's `container.resolve` to `jest.fn((key) => key === "logger" ? { warn: jest.fn() } : ongoingService)` if needed — the implementation calls `resolve("logger")` only on the missing-location branch, so the simplest fix is to make the mock branch on the key. Update the `makeProvider` helper accordingly:
> ```ts
> const makeProvider = (ongoingService: any) => {
>   const container = {
>     resolve: jest.fn((key: string) =>
>       key === "logger" ? { warn: jest.fn() } : ongoingService
>     ),
>   } as any
>   return { provider: new OngoingFulfillmentProviderService(container, {}), container }
> }
> ```
> (Make this edit in Step 1's test file before Step 4 if you anticipate the logger resolve; the assertions on `container.resolve` calls for `"ongoing"` still hold.)

- [ ] **Step 5: Build the plugin to validate compilation**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; the provider + its new `createFulfillment` compile and appear under `.medusa/server/src/providers/ongoing-fulfillment/`.

> NOTE: `yarn build` requires `src/workflows/index.ts` to export `pushOrderToOngoing` (#26). If #26 is not yet merged, the build (and the import in `service.ts`) will fail to resolve. In that case this task is **blocked on #26** — do not stub the workflow here; record the block on the issue and proceed only once #26's export exists. (The unit tests pass regardless because they `jest.mock` the workflow module.)

- [ ] **Step 6: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (the foundation suites from M1 plus this provider suite).

- [ ] **Step 7: Commit**

```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/__tests__/create-fulfillment.test.ts
git commit -m "feat(ongoing-fulfillment): createFulfillment pushes order to Ongoing and stashes sync data (#21)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (§5 `createFulfillment` bullet):** reads `fulfillment.id` + `fulfillment.location_id` ✓ (Task 1 Step 3); runs `pushOrderToOngoing` which re-queries the full order ✓ (referenced by name, mocked in tests, not reimplemented); returns `data: { ongoing_order_number, ongoing_order_id, location_id, credential_key }` ✓ (exact-stash assertion, Task 1 Step 1); `credential_key` stashed for `cancelFulfillment` #22 ✓; "confirm `fulfillment.location_id` is hydrated; handle missing/undefined" ✓ (guard + one-time warn log + terminal throw, Task 1 Step 3); §13 open item #1 (`location_id` hydration) addressed by the dev-spike framing + guard.
- **Synchronous in-method push (confirmed decision):** Task 0 is an explicit dev spike proving the provider can resolve the container and run a workflow at fulfillment time, with the documented `fulfillment.created` subscriber fallback called out as the decision-gate alternative — but the plan builds for the in-method approach throughout.
- **Dependency hygiene:** #20 (provider scaffold) handled by Task 0 (verify-or-create, no regression); #26 (`pushOrderToOngoing`) referenced by name only, mocked in tests, with the build step flagged as blocked-on-#26 if its export is absent.
- **Placeholder scan:** every code step contains full code; the three NOTE callouts (mock path resolution, container key names, logger-resolve mock branch) are explicit clarifications with stated resolutions, not missing content. No "TBD"/"add error handling"/"similar to" placeholders.
- **Type/name consistency:** `createFulfillment` signature, the stash keys (`ongoing_order_number`, `ongoing_order_id`, `location_id`, `credential_key`), the canonical workflow input key (`fulfillment_id` only), the workflow result keys (`ongoingOrderId`, `orderNumber`), `getIntegrationByLocation`, the module key `"ongoing"`, and `this.container_` are used identically across Task 0, Task 1 tests, and Task 1 implementation. The provider resolves the integration locally ONLY for `credential_key` in the stash; the workflow re-derives integration context from `{ fulfillment_id }`. Workflow result `orderNumber` → stash `ongoing_order_number`; `ongoingOrderId` → `ongoing_order_id` (mapping is explicit and consistent).

## Known verify-points carried forward
- **#26 export shape:** this plan assumes the canonical contract `pushOrderToOngoing(this.container_).run({ input: { fulfillment_id } })` resolving `{ result: { ongoingOrderId, orderNumber } }`. If #26 lands with a different invocation (e.g. a thin wrapper or different result keys), update the import call + the mapping in Task 1 Step 3 and the mocked `run` return in the test — single-spot edits.
- **`fulfillment.location_id` hydration (§13 #1):** the guard + one-time warn log makes a real-world hydration surprise observable during the first dev fulfillment; if it is ever observed undefined in practice, that is the trigger to revisit the subscriber fallback.

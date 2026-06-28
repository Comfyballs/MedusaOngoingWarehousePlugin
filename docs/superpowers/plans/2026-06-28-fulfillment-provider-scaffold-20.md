# Ongoing Fulfillment Provider Scaffold (Issue #20) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Ongoing fulfillment provider class — extending `AbstractFulfillmentProviderService`, registered via `ModuleProvider` — with the four shipping-option-lifecycle methods (`getFulfillmentOptions`, `validateOption`, `validateFulfillmentData`, `canCalculate`) implemented and unit-tested, so that admins can create Ongoing shipping options and the later issues (#21 createFulfillment, #22 cancelFulfillment, #23 stubs) drop their methods into an already-wired class.

**Architecture:** A single fulfillment provider lives at `src/providers/ongoing-fulfillment/`. The provider class (`OngoingFulfillmentProviderService`) extends Medusa's `AbstractFulfillmentProviderService`, sets a stable `static identifier = "ongoing"`, and returns a fixed pair of fulfillment options (`ongoing-standard`, `ongoing-return`). It overrides the three lifecycle methods whose base implementations throw (`getFulfillmentOptions`, `validateOption`, `validateFulfillmentData`) plus `canCalculate` (flat rates → `false`). The remaining abstract methods (`createFulfillment`, `cancelFulfillment`, `createReturnFulfillment`, `calculatePrice`, `getFulfillmentDocuments`) are intentionally left on the throwing base for #21/#22/#23 to fill. The `index.ts` default-exports `ModuleProvider(Modules.FULFILLMENT, { services: [...] })`. Tests are pure Jest unit tests that instantiate the class directly with mocked deps — no live DB, no Medusa container.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/utils`, `@medusajs/framework/types`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest 29 + `@swc/jest` for unit tests (already wired in `package.json` + `jest.config.js` from M1).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Copy from `package.json`.
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module / provider identifier is **`"ongoing"`** — `static identifier = "ongoing"`; the runtime provider id Medusa derives is `fp_ongoing_<config-id>`.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100. (No price logic in this issue, but `canCalculate` returns `false` precisely because rates are flat.)
- Provider exports path is exactly **`src/providers/ongoing-fulfillment/index.ts`**; `package.json` `exports` already routes `./providers/*` → `./.medusa/server/src/providers/*/index.js`.
- This is a **plugin**, not an app: no local Postgres/Medusa instance is wired here, so tests are **pure unit tests** (instantiate the class, mock deps). Provider registration + Medusa wiring is verified by `yarn build` compiling clean.
- Jest tooling already exists (`package.json` `test` script + `jest`/`@swc/jest`/`@types/jest` devDeps + `jest.config.js` with `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`). Do **not** re-add it.
- `getFulfillmentOptions()` takes **no arguments** → one global option list; it cannot be warehouse-specific. This is a known limitation (spec §5, §13.4). The actual Ongoing `wayOfDelivery` is resolved per-warehouse at payload-map time (Ongoing `GET /api/v1/orders/wayOfDeliveryTypes` is per-`goodsOwner`) in a later milestone — do not attempt per-warehouse carriers here.

---

## File Structure

**Create:**
- `src/providers/ongoing-fulfillment/service.ts` — `OngoingFulfillmentProviderService` class (extends `AbstractFulfillmentProviderService`).
- `src/providers/ongoing-fulfillment/index.ts` — `ModuleProvider(Modules.FULFILLMENT, { services: [OngoingFulfillmentProviderService] })` default export.
- `src/providers/ongoing-fulfillment/constants.ts` — shared option-id constants (`ONGOING_PROVIDER_ID`, `ONGOING_STANDARD_OPTION_ID`, `ONGOING_RETURN_OPTION_ID`, `ONGOING_FULFILLMENT_OPTIONS`), so #30 (seeds a shipping option) and the tests import one source of truth.
- `src/providers/ongoing-fulfillment/__tests__/service.test.ts` — unit tests for the four lifecycle methods.

**Modify:** none. (Jest tooling and `package.json` are already in place from M1.)

---

## Notes on verified 2.16.0 behavior (drive the design)

- `AbstractFulfillmentProviderService` is imported from `@medusajs/framework/utils`. In 2.16.0 its base methods **throw** `"<method> must be overridden by the child class"` for: `getFulfillmentOptions`, `validateFulfillmentData`, `validateOption`, `canCalculate`, `calculatePrice`, `createFulfillment`, `cancelFulfillment`, `createReturnFulfillment`, `getFulfillmentDocuments`. (Verified against `node_modules/@medusajs/utils/dist/fulfillment/provider.js`.) Therefore any method we do not override stays throwing — which is the correct "not yet implemented" state for #21/#22/#23.
- `getFulfillmentOptions(): Promise<FulfillmentOption[]>` where `FulfillmentOption = { id: string; is_return?: boolean; [k: string]: unknown }` (from `@medusajs/framework/types`). The manual provider returns `[{ id: "manual-fulfillment" }, { id: "manual-fulfillment-return", is_return: true }]`. We mirror that shape with clean ids.
- A shipping option's `provider_id` is built by Medusa as `` `${identifier}_${optionId}` `` → option id `ongoing-standard` yields provider_id `ongoing_ongoing-standard`. **Coordinate this id with issue #30**, which seeds a shipping option; that issue must reference `ONGOING_STANDARD_OPTION_ID`.
- `validateOption(data: Record<string, unknown>): Promise<boolean>` — base throws; **without this override admins cannot create shipping options** for the provider. Return `true` after asserting the option id is one we returned.
- `validateFulfillmentData(optionData, data, context): Promise<any>` — the return value is stored as the shipping method's `data`. `context` is `CartPropsForFulfillment & { from_location: StockLocationDTO }`. Minimal correct behavior: return `data` unchanged (what the manual provider does).
- `canCalculate(data: CreateShippingOptionDTO): Promise<boolean>` → `false` (Ongoing rates are flat in this plugin).
- Registration: `index.ts` default-exports `ModuleProvider(Modules.FULFILLMENT, { services: [OngoingFulfillmentProviderService] })`, both `ModuleProvider` and `Modules` from `@medusajs/framework/utils`.

---

## Task 1: Provider constants + fulfillment-option ids

**Files:**
- Create: `src/providers/ongoing-fulfillment/constants.ts`
- Test: `src/providers/ongoing-fulfillment/__tests__/service.test.ts` (created here, fleshed out in Task 2)

**Interfaces:**
- Consumes: `FulfillmentOption` type from `@medusajs/framework/types`.
- Produces:
  - `const ONGOING_PROVIDER_ID = "ongoing"` — the provider `static identifier`.
  - `const ONGOING_STANDARD_OPTION_ID = "ongoing-standard"`.
  - `const ONGOING_RETURN_OPTION_ID = "ongoing-return"`.
  - `const ONGOING_FULFILLMENT_OPTIONS: FulfillmentOption[]` — the stable option list `[{ id: ONGOING_STANDARD_OPTION_ID }, { id: ONGOING_RETURN_OPTION_ID, is_return: true }]`.

This is a constants module (pure scaffolding with a data assertion test). The single behavior worth pinning — the stable, never-rename ids and their shape — gets a focused test, since #30's shipping-option seed and the derived `provider_id` depend on these exact strings.

- [ ] **Step 1: Write the failing test for the option constants**

Create `src/providers/ongoing-fulfillment/__tests__/service.test.ts`:
```ts
import {
  ONGOING_PROVIDER_ID,
  ONGOING_STANDARD_OPTION_ID,
  ONGOING_RETURN_OPTION_ID,
  ONGOING_FULFILLMENT_OPTIONS,
} from "../constants"

describe("ongoing fulfillment constants", () => {
  it("pins the provider identifier and option ids (do not rename — provider_id derives from these)", () => {
    expect(ONGOING_PROVIDER_ID).toBe("ongoing")
    expect(ONGOING_STANDARD_OPTION_ID).toBe("ongoing-standard")
    expect(ONGOING_RETURN_OPTION_ID).toBe("ongoing-return")
  })

  it("exposes a stable two-entry option list, with the return option flagged is_return", () => {
    expect(ONGOING_FULFILLMENT_OPTIONS).toEqual([
      { id: "ongoing-standard" },
      { id: "ongoing-return", is_return: true },
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.test.ts`
Expected: FAIL — cannot find module `../constants`.

- [ ] **Step 3: Create the constants file**

Create `src/providers/ongoing-fulfillment/constants.ts`:
```ts
import type { FulfillmentOption } from "@medusajs/framework/types"

/**
 * Provider identifier. Medusa derives the runtime provider id as
 * `fp_${identifier}_${config-id}` and a shipping option's provider_id as
 * `${identifier}_${optionId}`. Do NOT rename without migrating shipping options.
 */
export const ONGOING_PROVIDER_ID = "ongoing"

/** Standard outbound shipping option id → provider_id "ongoing_ongoing-standard". */
export const ONGOING_STANDARD_OPTION_ID = "ongoing-standard"

/** Return shipping option id → provider_id "ongoing_ongoing-return". */
export const ONGOING_RETURN_OPTION_ID = "ongoing-return"

/**
 * The single, global option list this provider advertises. getFulfillmentOptions
 * takes no args, so this cannot vary per warehouse (known limitation, spec §5/§13.4);
 * the real Ongoing wayOfDelivery is resolved per-warehouse at order-payload time later.
 */
export const ONGOING_FULFILLMENT_OPTIONS: FulfillmentOption[] = [
  { id: ONGOING_STANDARD_OPTION_ID },
  { id: ONGOING_RETURN_OPTION_ID, is_return: true },
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/ongoing-fulfillment/constants.ts src/providers/ongoing-fulfillment/__tests__/service.test.ts
git commit -m "feat(ongoing-provider): add fulfillment provider id + option-id constants"
```

---

## Task 2: Provider class — lifecycle methods (TDD)

**Files:**
- Create: `src/providers/ongoing-fulfillment/service.ts`
- Modify: `src/providers/ongoing-fulfillment/__tests__/service.test.ts`

**Interfaces:**
- Consumes: `ONGOING_PROVIDER_ID`, `ONGOING_FULFILLMENT_OPTIONS`, `ONGOING_STANDARD_OPTION_ID`, `ONGOING_RETURN_OPTION_ID` from `./constants`; `AbstractFulfillmentProviderService` from `@medusajs/framework/utils`; `FulfillmentOption`, `ValidateFulfillmentDataContext`, `CreateShippingOptionDTO`, `Logger`, `MedusaContainer` from `@medusajs/framework/types`.
- Produces: `class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService` (default export) with:
  - `static identifier = "ongoing"` (= `ONGOING_PROVIDER_ID`).
  - `protected readonly container_: MedusaContainer` field — the injected container/cradle (first constructor arg).
  - `constructor(container: MedusaContainer, options?: Record<string, unknown>)` — calls `super(container, options)`, then stores `this.container_ = container`, `this.logger_ = container.logger`, and `this.options_ = options ?? {}`. **#21 (createFulfillment) and #22 (cancelFulfillment) rely on `this.container_`** to resolve the `'ongoing'` module and run workflows; capturing it here is what unblocks those issues without re-touching the constructor.
  - `getFulfillmentOptions(): Promise<FulfillmentOption[]>` → returns `ONGOING_FULFILLMENT_OPTIONS`.
  - `validateOption(data: Record<string, unknown>): Promise<boolean>` → `true` iff `data.id` is one of the two known option ids; otherwise `false`.
  - `validateFulfillmentData(optionData, data, context): Promise<Record<string, unknown>>` → returns `data` unchanged.
  - `canCalculate(data: CreateShippingOptionDTO): Promise<boolean>` → `false`.
  - `createFulfillment`, `cancelFulfillment`, `createReturnFulfillment`, `calculatePrice`, `getFulfillmentDocuments` are **not** overridden — they remain the throwing base methods (filled by #21/#22/#23).

- [ ] **Step 1: Write the failing tests for the provider class**

Append to `src/providers/ongoing-fulfillment/__tests__/service.test.ts` (below the existing constants `describe`):
```ts
import OngoingFulfillmentProviderService from "../service"
import type { Logger } from "@medusajs/framework/types"

const loggerStub = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger

// The provider receives the Medusa container (cradle) as its first constructor arg.
const containerStub = { logger: loggerStub } as any

const makeService = () =>
  new OngoingFulfillmentProviderService(containerStub, {})

describe("OngoingFulfillmentProviderService", () => {
  it("exposes the stable provider identifier", () => {
    expect(OngoingFulfillmentProviderService.identifier).toBe("ongoing")
  })

  it("captures the injected container as container_ (so #21/#22 can run workflows)", () => {
    const service = makeService() as any
    expect(service.container_).toBe(containerStub)
  })

  it("getFulfillmentOptions returns the stable option ids", async () => {
    const service = makeService()
    const options = await service.getFulfillmentOptions()
    expect(options).toEqual([
      { id: "ongoing-standard" },
      { id: "ongoing-return", is_return: true },
    ])
  })

  it("validateOption resolves true for a known option id", async () => {
    const service = makeService()
    await expect(service.validateOption({ id: "ongoing-standard" })).resolves.toBe(true)
    await expect(service.validateOption({ id: "ongoing-return" })).resolves.toBe(true)
  })

  it("validateOption resolves false for an unknown option id", async () => {
    const service = makeService()
    await expect(service.validateOption({ id: "not-ours" })).resolves.toBe(false)
    await expect(service.validateOption({})).resolves.toBe(false)
  })

  it("validateFulfillmentData returns the data it was passed", async () => {
    const service = makeService()
    const data = { foo: "bar" }
    const context = { from_location: { id: "sloc_1" } } as any
    await expect(
      service.validateFulfillmentData({ id: "ongoing-standard" }, data, context)
    ).resolves.toBe(data)
  })

  it("canCalculate resolves false (flat Ongoing rates)", async () => {
    const service = makeService()
    await expect(service.canCalculate({} as any)).resolves.toBe(false)
  })

  it("leaves createFulfillment on the throwing base (filled by #21)", async () => {
    const service = makeService()
    await expect(
      service.createFulfillment({}, [], undefined as any, {} as any)
    ).rejects.toThrow(/must be overridden/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.test.ts`
Expected: FAIL — cannot find module `../service`.

- [ ] **Step 3: Implement the provider class**

Create `src/providers/ongoing-fulfillment/service.ts`:
```ts
import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import type {
  CreateShippingOptionDTO,
  FulfillmentOption,
  Logger,
  MedusaContainer,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import {
  ONGOING_FULFILLMENT_OPTIONS,
  ONGOING_PROVIDER_ID,
  ONGOING_RETURN_OPTION_ID,
  ONGOING_STANDARD_OPTION_ID,
} from "./constants"

const KNOWN_OPTION_IDS = new Set<string>([
  ONGOING_STANDARD_OPTION_ID,
  ONGOING_RETURN_OPTION_ID,
])

/**
 * Ongoing Warehouse fulfillment provider.
 *
 * This issue (#20) scaffolds the class and the shipping-option lifecycle:
 * getFulfillmentOptions / validateOption / validateFulfillmentData / canCalculate.
 * Order creation (#21), cancellation (#22), and return/document stubs (#23) are
 * deliberately left on the throwing AbstractFulfillmentProviderService base so they
 * slot in without restructuring this class.
 */
class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = ONGOING_PROVIDER_ID

  // The Medusa container (cradle) is captured so createFulfillment (#21) and
  // cancelFulfillment (#22) can resolve the 'ongoing' module and run workflows
  // via this.container_. Do not drop this field.
  protected readonly container_: MedusaContainer
  protected readonly logger_: Logger
  protected readonly options_: Record<string, unknown>

  constructor(container: MedusaContainer, options?: Record<string, unknown>) {
    super(container, options)
    this.container_ = container
    this.logger_ = container.logger
    this.options_ = options ?? {}
  }

  /**
   * One global option list (the method takes no args, so it cannot be
   * warehouse-specific — known limitation, spec §5/§13.4).
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return ONGOING_FULFILLMENT_OPTIONS
  }

  /**
   * Base implementation throws; overriding it is what lets admins create
   * shipping options for this provider. Accept only ids we advertise.
   */
  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return typeof data?.id === "string" && KNOWN_OPTION_IDS.has(data.id)
  }

  /**
   * Return value is stored as the shipping method's `data`. For now we pass the
   * caller's data through unchanged (mirrors the manual provider). Real
   * way-of-delivery resolution happens at order-payload time in a later milestone.
   */
  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    return data
  }

  /** Ongoing rates are flat in this plugin → no calculated rates. */
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false
  }
}

export default OngoingFulfillmentProviderService
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.test.ts`
Expected: PASS (constants `describe` 2 tests + provider `describe` 8 tests = 10 tests).

> NOTE: if `@medusajs/framework/types` does not export `ValidateFulfillmentDataContext` or `CreateShippingOptionDTO` under those exact names in 2.16.0, the build (Task 3) will surface it as a missing-type error. Resolution: grep the installed types — `grep -rl "ValidateFulfillmentDataContext\|CreateShippingOptionDTO" node_modules/@medusajs/types/dist` — and import from the surfaced name; both are part of the fulfillment-provider method signatures in 2.16.0. The runtime behavior under test is unaffected (the test casts context/data with `as any`).

- [ ] **Step 5: Commit**

```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/__tests__/service.test.ts
git commit -m "feat(ongoing-provider): provider class with option/validate/canCalculate lifecycle"
```

---

## Task 3: Provider registration (`index.ts`) + build verification (scaffolding — verify by build)

**Files:**
- Create: `src/providers/ongoing-fulfillment/index.ts`

**Interfaces:**
- Consumes: `OngoingFulfillmentProviderService` from `./service`; `ModuleProvider`, `Modules` from `@medusajs/framework/utils`.
- Produces: default export `ModuleProvider(Modules.FULFILLMENT, { services: [OngoingFulfillmentProviderService] })` — the artifact a consuming app references under `@medusajs/medusa/fulfillment` → `providers` at `@org/plugin/providers/ongoing-fulfillment`. Runtime provider id: `fp_ongoing_<config-id>`.

This is pure wiring; correctness is verified by `yarn build` compiling and producing the provider under `.medusa/server`, not by a unit test (a unit test of `ModuleProvider(...)` output would only assert the framework's own return shape).

- [ ] **Step 1: Create the provider registration**

Create `src/providers/ongoing-fulfillment/index.ts`:
```ts
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import OngoingFulfillmentProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [OngoingFulfillmentProviderService],
})
```

- [ ] **Step 2: Build the plugin to validate everything compiles**

Run: `yarn build`
Expected: `medusa plugin:build` completes with no TypeScript errors; output appears at `.medusa/server/src/providers/ongoing-fulfillment/index.js` and `service.js`. If a type import name is wrong, fix per the Task 2 Step 4 NOTE and rebuild.

- [ ] **Step 3: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (M1 lib/module suites + the new provider suite).

- [ ] **Step 4: Commit**

```bash
git add src/providers/ongoing-fulfillment/index.ts
git commit -m "feat(ongoing-provider): register fulfillment ModuleProvider for the Ongoing provider"
```

---

## Self-Review (completed during planning)

- **Spec coverage (issue-#20 slice of spec §5):** extends `AbstractFulfillmentProviderService` (Task 2) ✓; `getFulfillmentOptions` returns stable ids (Tasks 1–2) ✓; `validateOption` overridden so the base no longer throws — admins can create shipping options (Task 2) ✓; `validateFulfillmentData` returns the method data (Task 2) ✓; `canCalculate → false` (Task 2) ✓; `ModuleProvider(Modules.FULFILLMENT, …)` registration at the exact path (Task 3) ✓; per-warehouse-carrier limitation documented in `constants.ts` + Global Constraints (spec §5/§13.4) ✓. `createFulfillment` (#21), `cancelFulfillment` (#22), and `createReturnFulfillment`/`getFulfillmentDocuments` stubs (#23) are deliberately left on the throwing base — verified by the "leaves createFulfillment on the throwing base" test — so they slot in later. The constructor captures the Medusa container as `this.container_` (verified by the "captures the injected container as container_" test) so #21/#22 can resolve the `'ongoing'` module and run workflows without re-touching the constructor. The `ongoing-standard` option id is published as `ONGOING_STANDARD_OPTION_ID` for issue #30's shipping-option seed; the derived shipping-option `provider_id` is `ongoing_ongoing-standard`.
- **Placeholder scan:** every code step contains full code; the one NOTE (Task 2 Step 4) is an explicit verify-point with the exact grep + resolution stated, not missing content. No "add validation", "handle edge cases", or "TBD".
- **Type consistency:** `OngoingFulfillmentProviderService`, `static identifier`, `ONGOING_PROVIDER_ID`/`ONGOING_STANDARD_OPTION_ID`/`ONGOING_RETURN_OPTION_ID`/`ONGOING_FULFILLMENT_OPTIONS`, and the four method names/return types are used identically across Tasks 1–3 and match the tests. `static identifier = ONGOING_PROVIDER_ID = "ongoing"` is consistent with the test asserting `.identifier === "ongoing"`.

## Known verify-points carried into later issues
- Exact `@medusajs/framework/types` export names for `ValidateFulfillmentDataContext` / `CreateShippingOptionDTO` in 2.16.0 (Task 2 Step 4 NOTE) — does not block; resolved by `yarn build` + grep.
- `createFulfillment`/`cancelFulfillment` real signatures and `fulfillment.location_id` hydration are confirmed in #21/#22 (spec §13.1), not here.
- Issue #30 must import `ONGOING_STANDARD_OPTION_ID` from `src/providers/ongoing-fulfillment/constants.ts` so the seeded shipping option's `provider_id` resolves to `ongoing_ongoing-standard`.

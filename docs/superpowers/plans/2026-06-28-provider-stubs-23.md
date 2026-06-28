# Provider Stub Extension Points (`createReturnFulfillment` + `getFulfillmentDocuments`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two documented, no-op extension-point methods — `createReturnFulfillment` and `getFulfillmentDocuments` — to the existing `OngoingFulfillmentProviderService` class so the provider satisfies the Medusa fulfillment-provider contract without throwing, leaving returns/label retrieval as clearly-marked future work.

**Architecture:** Both methods live in the same `OngoingFulfillmentProviderService` class created by issue #20 (`src/providers/ongoing-fulfillment/service.ts`). `createReturnFulfillment` MUST be overridden because `AbstractFulfillmentProviderService.createReturn` throws `"createReturn must be overridden"`; the documented stub returns `{ data: {}, labels: [] }` (matching Medusa's manual fulfillment provider). `getFulfillmentDocuments` is strictly optional (the base returns `[]`), but we add an explicit, labelled stub returning `[]` so the extension point is discoverable. Pure unit tests instantiate the class directly with no Ongoing client.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `AbstractFulfillmentProviderService`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"`; the fulfillment provider lives at `src/providers/ongoing-fulfillment/`.
- Plugin build output is `.medusa/server`; provider is exported via `package.json` `"./providers/*"` → `src/providers/*/index.js`.
- TDD: write the failing Jest unit test first (mocked deps, no real Ongoing client), then implement.
- No placeholders in shipped code — both methods are real, returning the documented values, with comments marking them as extension points (returns / label retrieval out of scope per spec §1 line 28).
- **DEPENDS ON #20** — the `OngoingFulfillmentProviderService` class scaffold (file `src/providers/ongoing-fulfillment/service.ts`, extending `AbstractFulfillmentProviderService`) must already exist. This plan only adds two methods to that class; it does not create the class, the provider `index.ts`, or the `identifier`.

---

## File Structure

**Modify:**
- `src/providers/ongoing-fulfillment/service.ts` — add `createReturnFulfillment` and `getFulfillmentDocuments` methods to the existing `OngoingFulfillmentProviderService` class (created by #20).

**Create:**
- `src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts` — unit tests asserting both stubs' return values and that `createReturnFulfillment` does not throw.

This is a single, small change set: the two methods change together (both are documented extension-point stubs on the same class) and share one test file, so they form one task.

---

## Task 1: Stub `createReturnFulfillment` and `getFulfillmentDocuments` as documented extension points

**Files:**
- Modify: `src/providers/ongoing-fulfillment/service.ts`
- Test: `src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts`

**Interfaces:**
- Consumes (from #20): `class OngoingFulfillmentProviderService extends AbstractFulfillmentProviderService` exported from `src/providers/ongoing-fulfillment/service.ts`. Its constructor signature is set by #20; the tests below instantiate it with the minimal arguments #20 requires (see Step 1 note).
- Produces, on `OngoingFulfillmentProviderService`:
  - `createReturnFulfillment(fulfillment: Record<string, unknown>): Promise<{ data: Record<string, unknown>; labels: never[] }>` — overrides the base (which throws); returns `{ data: {}, labels: [] }`.
  - `getFulfillmentDocuments(data: Record<string, unknown>): Promise<never[]>` — returns `[]`.

- [ ] **Step 1: Write the failing test**

> NOTE on construction: #20's `OngoingFulfillmentProviderService` extends `AbstractFulfillmentProviderService`, whose constructor takes `(container, options)`. Instantiate it the same way #20's own tests do. If #20's constructor tolerates empty args, `new OngoingFulfillmentProviderService({} as any, {} as any)` is sufficient because these two stubs touch neither the container nor options. If #20 requires specific constructor args, copy that exact construction from #20's test setup. Both stub methods are pure (no `this` dependencies), so no Ongoing client or mock is needed.

Create `src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts`:
```ts
import OngoingFulfillmentProviderService from "../service"

const makeService = () =>
  // These stubs read neither container nor options; empty args are safe.
  new OngoingFulfillmentProviderService({} as any, {} as any)

describe("OngoingFulfillmentProviderService extension-point stubs", () => {
  describe("createReturnFulfillment", () => {
    it("resolves to an empty data/labels result and does NOT throw", async () => {
      const service = makeService()
      await expect(
        service.createReturnFulfillment({ id: "ful_ret_1" })
      ).resolves.toEqual({ data: {}, labels: [] })
    })

    it("does not throw the base-class 'must be overridden' error", async () => {
      const service = makeService()
      await expect(service.createReturnFulfillment({})).resolves.toBeDefined()
    })
  })

  describe("getFulfillmentDocuments", () => {
    it("resolves to an empty array", async () => {
      const service = makeService()
      await expect(
        service.getFulfillmentDocuments({ id: "ful_1" })
      ).resolves.toEqual([])
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts`
Expected: FAIL. `getFulfillmentDocuments` either is not a function or inherits the base `[]` (so that case may pass), and `createReturnFulfillment` throws `"createReturn must be overridden"` (or is undefined) — the two `createReturnFulfillment` assertions fail. The suite is red until Step 3.

- [ ] **Step 3: Add the two stub methods to the existing class**

Open `src/providers/ongoing-fulfillment/service.ts` (created by #20). Inside the body of `class OngoingFulfillmentProviderService`, add the following two methods (place them after the existing methods, before the closing brace):
```ts
  /**
   * Extension point — returns fulfillment.
   *
   * Returns are out of scope for now (see design §1 "Out of scope": returns /
   * label retrieval are stubbed as extension points). The base
   * `AbstractFulfillmentProviderService.createReturn` THROWS
   * ("createReturn must be overridden"), so this MUST be overridden even to
   * no-op. The empty `{ data, labels }` shape matches Medusa's manual
   * fulfillment provider. Implement real Ongoing return creation here when
   * returns come into scope.
   */
  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown>; labels: never[] }> {
    return { data: {}, labels: [] }
  }

  /**
   * Extension point — fulfillment document retrieval.
   *
   * Label / document retrieval is out of scope for now (design §1). The base
   * returns `[]` and does NOT throw, so this override is optional; it is added
   * explicitly to mark a discoverable extension point. The sibling
   * `getReturnDocuments` and `getShipmentDocuments` methods also default to
   * `[]` on the base class and are related extension points to implement when
   * document retrieval comes into scope.
   */
  async getFulfillmentDocuments(
    data: Record<string, unknown>
  ): Promise<never[]> {
    return []
  }
```

> NOTE: `fulfillment` and `data` are intentionally unnamed-use parameters that document the real signatures for the future implementation. If #20's eslint config flags unused parameters as an error (it uses `@medusajs/eslint-plugin` recommended, which typically does not), prefix them with `_` (`_fulfillment`, `_data`) — keep the same types. Verify with `yarn lint` in Step 6.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build the plugin to confirm it compiles**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; the provider compiles to `.medusa/server/src/providers/ongoing-fulfillment/`.

- [ ] **Step 6: Lint + full unit suite**

Run: `yarn lint && yarn test`
Expected: lint clean (apply the `_`-prefix from the Step 3 NOTE if unused-param errors appear), all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/ongoing-fulfillment/service.ts src/providers/ongoing-fulfillment/__tests__/service.stubs.test.ts
git commit -m "feat(ongoing-fulfillment): stub createReturnFulfillment + getFulfillmentDocuments extension points

Closes #23"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §1 line 28 (returns / label retrieval stubbed as extension points) and §5 line 184 (`createReturnFulfillment`, `getFulfillmentDocuments` stubbed extension points) are both implemented by Task 1 ✓. Issue #23 scope (the two stubs on the same class as #20) is fully covered; nothing else is in scope.
- **Verified behavior:** `createReturnFulfillment` overrides a base method that THROWS, so the override is mandatory; the test asserts it resolves and does not throw. `getFulfillmentDocuments` base returns `[]` (no throw) — the explicit stub is documented as optional-but-deliberate, and the related `getReturnDocuments`/`getShipmentDocuments` `[]` defaults are noted as sibling extension points per the research.
- **Placeholder scan:** every code step contains full, shippable code with no TODO/TBD; the two NOTEs (constructor args, unused-param lint) are explicit verify-points with stated resolutions, not missing content.
- **Type consistency:** `createReturnFulfillment(fulfillment: Record<string, unknown>): Promise<{ data: Record<string, unknown>; labels: never[] }>` and `getFulfillmentDocuments(data: Record<string, unknown>): Promise<never[]>` are used identically in the Interfaces block, the test, and the implementation.
- **Dependency:** depends on #20 (provider class scaffold); Task 1 modifies that class and does not create it.

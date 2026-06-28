# Order-Number (Upsert Key) Scheme — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure function that derives the `ongoing_order_number` upsert key for a Medusa fulfillment, so order-push (#26) and edit-resync (#27) can use a stable, idempotent key against `PUT /api/v1/orders`.

**Architecture:** A single pure, dependency-free function in `src/lib/ongoing/` that maps `{ order.display_id, fulfillment.id }` → `` `${display_id}-${fulfillment.id}` `` (full fulfillment id, not truncated). It is unit-tested with mocked-free inputs (no Medusa, no DB, no `fetch`) and re-exported from the lib barrel. The function only generates the key; persisting it on `OngoingOrderSync.ongoing_order_number` and capturing `ongoing_order_id` from the `PUT` response happen in #26's record step (contract documented here, not implemented).

**Tech Stack:** TypeScript 5.6 (Node16 module resolution), Jest + `@swc/jest` for unit tests (already wired in Milestone 1). Pure TS — no runtime dependencies.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- This is a **plugin**, not an app: no local Postgres/Medusa instance is wired here, so this is a **pure unit test** (no DB, no `fetch`). Wiring correctness is verified by `yarn build` succeeding.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100. (N/A here; no numeric scaling.)
- Lib code lives under `src/lib/ongoing/`; tests live under `src/lib/ongoing/__tests__/*.test.ts`.
- TDD: write the failing test first, watch it fail, then implement.

---

## File Structure

**Create:**
- `src/lib/ongoing/order-number.ts` — the pure `buildOngoingOrderNumber` function.
- `src/lib/ongoing/__tests__/order-number.test.ts` — unit tests for the function.

**Modify:**
- `src/lib/ongoing/index.ts` — re-export `buildOngoingOrderNumber` from the lib barrel.

---

## Decision (recorded)

The upsert key is `` `${order.display_id}-${fulfillment.id}` `` using the **full** `fulfillment.id` suffix (e.g. `1001-ful_01J...`), not a truncated short id. Ongoing's OpenAPI documents only `minLength: 1` for `orderNumber` (no documented max), so collision-safety is preferred over brevity. This supersedes the illustrative `<order.display_id>-<fulfillment short id>` example in the spec §6.

Properties this guarantees:
- **Deterministic / stable across retries:** the same `{ display_id, fulfillment.id }` always yields the same key, so a retried `PUT /api/v1/orders` upserts the same Ongoing order rather than creating a duplicate.
- **Unique per Ongoing order:** distinct fulfillments of one Medusa order (multi-fulfillment / multi-location) yield distinct keys — one Ongoing order each.
- **Non-empty:** satisfies OpenAPI `minLength: 1` (both inputs are required and validated non-empty).

## Persistence / response contract (documented here; implemented in #26)

- Generate the key with `buildOngoingOrderNumber` and **persist it on `OngoingOrderSync.ongoing_order_number` BEFORE issuing the `PUT`**, so any retry reuses the same row + key. `ongoing_order_number` is the `.unique()` column on the model (`src/modules/ongoing/models/order-sync.ts:8`).
- The `PUT /api/v1/orders` response (`PostOrderResponse`) is flat — `{ orderId: int32, message: string }` — and does **not** echo `orderNumber`. So `ongoing_order_id` is captured from `response.orderId`, while `ongoing_order_number` stays the locally-generated value (it is the input key, not a server echo).

> NOTE: `src/lib/ongoing/client.ts`'s `putOrder` mapper currently reads `res.orderInfo.orderId` / `res.orderInfo.orderNumber` (assumed envelope, Milestone-1 verify-point). The flat `{ orderId, message }` shape above is the verified `PostOrderResponse`; reconciling `putOrder` to it is #26's concern, **out of scope for this plan**. This plan changes neither the client nor the model.

---

## Task 1: `buildOngoingOrderNumber` pure function

**Files:**
- Create: `src/lib/ongoing/order-number.ts`
- Test: `src/lib/ongoing/__tests__/order-number.test.ts`
- Modify: `src/lib/ongoing/index.ts`

**Interfaces:**
- Consumes: nothing (pure TS).
- Produces:
  - `function buildOngoingOrderNumber(input: { displayId: number | string; fulfillmentId: string }): string` — returns `` `${displayId}-${fulfillmentId}` ``. Throws `Error` if `displayId` is `null`/`undefined`/empty-string or if `fulfillmentId` is missing/empty, guaranteeing a non-empty key (OpenAPI `minLength: 1`). Consumed by #26 (`pushOrderToOngoing`) and #27 (`syncOrderEditToOngoing`).
  - Re-exported from `src/lib/ongoing/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/order-number.test.ts`:
```ts
import { buildOngoingOrderNumber } from "../order-number"

describe("buildOngoingOrderNumber", () => {
  it("produces `<display_id>-<fulfillment.id>` with the full fulfillment id", () => {
    expect(
      buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_01J9ABCDEF0123456789" })
    ).toBe("1001-ful_01J9ABCDEF0123456789")
  })

  it("is deterministic for the same inputs (stable across retries)", () => {
    const input = { displayId: 1001, fulfillmentId: "ful_01J9ABCDEF0123456789" }
    expect(buildOngoingOrderNumber(input)).toBe(buildOngoingOrderNumber(input))
  })

  it("produces different keys for different fulfillments of the same order", () => {
    const a = buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_A" })
    const b = buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "ful_B" })
    expect(a).not.toBe(b)
    expect(a).toBe("1001-ful_A")
    expect(b).toBe("1001-ful_B")
  })

  it("accepts a string display_id", () => {
    expect(buildOngoingOrderNumber({ displayId: "1001", fulfillmentId: "ful_A" })).toBe("1001-ful_A")
  })

  it("always returns a non-empty key", () => {
    const key = buildOngoingOrderNumber({ displayId: 1, fulfillmentId: "f" })
    expect(key.length).toBeGreaterThan(0)
  })

  it("throws when display_id is missing or empty", () => {
    expect(() =>
      buildOngoingOrderNumber({ displayId: undefined as unknown as number, fulfillmentId: "ful_A" })
    ).toThrow(/display/i)
    expect(() => buildOngoingOrderNumber({ displayId: "", fulfillmentId: "ful_A" })).toThrow(/display/i)
  })

  it("throws when fulfillment id is missing or empty", () => {
    expect(() =>
      buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: undefined as unknown as string })
    ).toThrow(/fulfillment/i)
    expect(() => buildOngoingOrderNumber({ displayId: 1001, fulfillmentId: "" })).toThrow(/fulfillment/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/order-number.test.ts`
Expected: FAIL — cannot find module `../order-number`.

- [ ] **Step 3: Implement the function**

Create `src/lib/ongoing/order-number.ts`:
```ts
export type OngoingOrderNumberInput = {
  displayId: number | string
  fulfillmentId: string
}

/**
 * Build the `ongoing_order_number` upsert key for a Medusa fulfillment.
 *
 * Format: `<order.display_id>-<fulfillment.id>` using the FULL fulfillment id.
 * - Deterministic: same inputs -> same key, so a retried `PUT /api/v1/orders`
 *   upserts the same Ongoing order instead of creating a duplicate.
 * - Unique per Ongoing order: distinct fulfillments of one Medusa order yield
 *   distinct keys (one Ongoing order each).
 * - Non-empty: satisfies Ongoing OpenAPI `orderNumber` minLength 1.
 *
 * This is the value persisted to `OngoingOrderSync.ongoing_order_number` (the
 * `.unique()` column) before the PUT. `ongoing_order_id` is captured separately
 * from the PUT response `orderId`; the response does not echo `orderNumber`.
 */
export function buildOngoingOrderNumber(input: OngoingOrderNumberInput): string {
  const displayId = input?.displayId
  if (displayId === undefined || displayId === null || `${displayId}` === "") {
    throw new Error("[ongoing] cannot build order number: order display_id is missing")
  }

  const fulfillmentId = input?.fulfillmentId
  if (!fulfillmentId) {
    throw new Error("[ongoing] cannot build order number: fulfillment id is missing")
  }

  return `${displayId}-${fulfillmentId}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/order-number.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Re-export from the lib barrel**

Edit `src/lib/ongoing/index.ts` — add the re-export line alongside the existing exports:
```ts
export { buildOngoingOrderNumber } from "./order-number"
export type { OngoingOrderNumberInput } from "./order-number"
```

- [ ] **Step 6: Run the full lib suite + build**

Run: `yarn test src/lib/ongoing`
Expected: PASS (all lib tests green, including the new file).

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output appears under `.medusa/server` and includes the compiled `order-number.js`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ongoing/order-number.ts src/lib/ongoing/__tests__/order-number.test.ts src/lib/ongoing/index.ts
git commit -m "feat(ongoing-client): pure ongoing_order_number upsert-key builder

Closes #25"
```

---

## Self-Review (completed during planning)

- **Spec coverage (#25 slice):** pure function generating `ongoing_order_number` per fulfillment (Task 1) ✓; format `` `${order.display_id}-${fulfillment.id}` `` with full fulfillment id per recorded decision (Task 1) ✓; deterministic/stable-across-retries, unique-per-fulfillment, non-empty (tests in Task 1, Step 1) ✓; persistence-before-PUT + `ongoing_order_id`-from-`response.orderId` contract documented, not implemented (Persistence/response contract section) ✓; `yarn build` step present (Task 1, Step 6) ✓. Persisting the key and reconciling `putOrder` to the flat `PostOrderResponse` are #26's concern — intentionally out of scope.
- **Placeholder scan:** every code step contains full code; the one NOTE callout (putOrder envelope) is an explicit scope boundary pointing at #26, not missing content.
- **Type consistency:** `buildOngoingOrderNumber` and `OngoingOrderNumberInput` are named identically in the function, the test imports, and the barrel re-export. The `.unique()` column reference matches `src/modules/ongoing/models/order-sync.ts:8` (`ongoing_order_number`).

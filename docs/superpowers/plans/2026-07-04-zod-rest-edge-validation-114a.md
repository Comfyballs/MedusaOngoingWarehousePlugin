# #114-a: Zod REST-edge validation (I1, I2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce structural runtime validation of Ongoing REST responses at the client boundary, so malformed 2xx bodies throw a non-retried `OngoingApiError` instead of flowing `undefined` fields into the domain.

**Architecture:** Add Zod as a runtime dep. New file `src/lib/ongoing/schemas.ts` defines schemas for the two response shapes today's `mapInventoryRow` and `mapTrackedOrder` parse. Both functions become `raw: unknown`, `.safeParse` the input, and throw `OngoingApiError({ kind: "terminal", reason: "unexpected_body_shape" })` on failure — reusing the terminal-error kind PR #118 introduced.

**Tech Stack:** TypeScript, Zod 3.x, Jest, Medusa v2.

## Global Constraints

- Zod schemas MUST NOT introduce runtime dependencies beyond the `zod` npm package.
- Every schema failure MUST throw via the existing `OngoingApiError` class — do not introduce a new error type.
- No behavior change on the happy path: `mapInventoryRow`/`mapTrackedOrder` MUST return the same `OngoingInventoryRow`/`OngoingTrackedOrder` shapes they return today.
- The `reason` code MUST be `"unexpected_body_shape"` — matching the convention #118 introduced.

## Prerequisites

- PRs #118 (client.ts safeJson + Content-Type validation, closes #107) and #120 (putOrder response typing, closes #108) MUST be merged before this plan starts. This plan builds on the `unexpected_body_shape` terminal-error convention introduced there and layers structural validation on top. The implementer MUST read `src/lib/ongoing/errors.ts` at plan start to confirm the exact `OngoingApiError` opts shape (whether `reason` is a top-level field or embedded in `body`) that #118 landed with, and use that shape in Task 2 below.

## File Structure

- **Create** `src/lib/ongoing/schemas.ts` — Zod schemas for `getInventory` and `getOrdersByStatus` REST response items.
- **Create** `src/lib/ongoing/__tests__/schemas.test.ts` — unit tests for both schemas: happy path, missing optional fields, wrong-type fields, production failure shapes (empty object, `article` omitted, `orderInfo` omitted).
- **Modify** `src/lib/ongoing/client.ts` — rewrite `mapInventoryRow` and `mapTrackedOrder` to `raw: unknown` + `safeParse` + throw-on-failure; leave the mapped return shapes unchanged.
- **Modify** `src/lib/ongoing/__tests__/client.test.ts` (or the file that already covers `mapInventoryRow`/`mapTrackedOrder`) — add tests that assert `OngoingApiError({kind: "terminal", reason: "unexpected_body_shape"})` is thrown on structurally invalid rows.
- **Modify** `package.json` — add `zod` to `dependencies`.
- **Modify** `yarn.lock` — via `yarn add zod`.

---

## Task 1: Add Zod dependency and schemas file with tests

**Files:**
- Modify: `package.json` (dependencies section)
- Modify: `yarn.lock`
- Create: `src/lib/ongoing/schemas.ts`
- Create: `src/lib/ongoing/__tests__/schemas.test.ts`

**Interfaces produced:**
- `export const OngoingInventoryRowResponseSchema: z.ZodSchema<...>`
- `export const OngoingTrackedOrderResponseSchema: z.ZodSchema<...>`
- `export type OngoingInventoryRowResponse = z.infer<typeof OngoingInventoryRowResponseSchema>`
- `export type OngoingTrackedOrderResponse = z.infer<typeof OngoingTrackedOrderResponseSchema>`

- [ ] **Step 1: Add Zod dependency**

Run: `yarn add zod`
Expected: `package.json` `dependencies` gains `"zod": "^3.x"` (latest stable at plan-execution time), `yarn.lock` updates.

- [ ] **Step 2: Write the failing tests for the two schemas**

Create `src/lib/ongoing/__tests__/schemas.test.ts`:

```ts
import {
  OngoingInventoryRowResponseSchema,
  OngoingTrackedOrderResponseSchema,
} from "../schemas"

describe("OngoingInventoryRowResponseSchema", () => {
  it("accepts a fully populated inventory row", () => {
    const raw = {
      article: { articleNumber: "SKU-1", articleSystemId: 42 },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 2,
        SellableNumberOfItems: 8,
        ToReceiveNumberOfItems: 5,
      },
    }
    const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
  })

  it("accepts a row with omitted optional counts (defaults to zeros downstream)", () => {
    const raw = { article: { articleNumber: "SKU-1", articleSystemId: 42 }, totalItems: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("rejects a row where article is omitted entirely", () => {
    const raw = { totalItems: { NumberOfItemsDecimal: 1 } }
    const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
    expect(parsed.success).toBe(false)
  })

  it("rejects a row where article.articleNumber is not a string", () => {
    const raw = { article: { articleNumber: 42, articleSystemId: 1 }, totalItems: {} }
    expect(OngoingInventoryRowResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects the empty object (production failure shape)", () => {
    expect(OngoingInventoryRowResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe("OngoingTrackedOrderResponseSchema", () => {
  it("accepts a fully populated tracked order", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
      parcels: [{ parcelTracking: { code: "ABC" } }, { trackingNumber: "XYZ" }],
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("accepts an order with parcels omitted", () => {
    const raw = {
      orderInfo: {
        orderId: 100,
        orderNumber: "ORD-1",
        orderStatus: { number: 300, text: "Sent" },
      },
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(true)
  })

  it("rejects an order where orderInfo is omitted entirely", () => {
    expect(OngoingTrackedOrderResponseSchema.safeParse({ parcels: [] }).success).toBe(false)
  })

  it("rejects an order where orderInfo.orderId is a string", () => {
    const raw = {
      orderInfo: { orderId: "100", orderNumber: "ORD-1", orderStatus: { number: 300, text: "Sent" } },
    }
    expect(OngoingTrackedOrderResponseSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects the empty object (production failure shape)", () => {
    expect(OngoingTrackedOrderResponseSchema.safeParse({}).success).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/lib/ongoing/__tests__/schemas.test.ts`
Expected: FAIL with `Cannot find module '../schemas'` (or similar).

- [ ] **Step 4: Implement the schemas**

Create `src/lib/ongoing/schemas.ts`:

```ts
import { z } from "zod"

// Response shape parsed by mapInventoryRow (src/lib/ongoing/client.ts). Fields that
// the downstream OngoingInventoryRow requires (articleNumber, articleSystemId) are
// required in the schema; counts default to 0 downstream if omitted, so they stay
// optional here.
export const OngoingInventoryRowResponseSchema = z.object({
  article: z.object({
    articleNumber: z.string(),
    articleSystemId: z.number(),
  }),
  totalItems: z
    .object({
      NumberOfItemsDecimal: z.number().optional(),
      AllocatedNumberOfItems: z.number().optional(),
      SellableNumberOfItems: z.number().optional(),
      ToReceiveNumberOfItems: z.number().optional(),
    })
    .optional(),
})

export type OngoingInventoryRowResponse = z.infer<typeof OngoingInventoryRowResponseSchema>

// Response shape parsed by mapTrackedOrder (src/lib/ongoing/client.ts). Downstream
// OngoingTrackedOrder requires ongoingOrderId (number), orderNumber (string), and
// orderStatus.{number,text} — those are required here; parcels + inner trackingNumber
// alternates stay optional (mapTrackedOrder already handles their absence).
export const OngoingTrackedOrderResponseSchema = z.object({
  orderInfo: z.object({
    orderId: z.number(),
    orderNumber: z.string(),
    orderStatus: z.object({
      number: z.number(),
      text: z.string(),
    }),
  }),
  parcels: z
    .array(
      z.object({
        parcelTracking: z.object({ code: z.string().optional() }).optional(),
        trackingNumber: z.string().optional(),
      })
    )
    .optional(),
})

export type OngoingTrackedOrderResponse = z.infer<typeof OngoingTrackedOrderResponseSchema>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/lib/ongoing/__tests__/schemas.test.ts`
Expected: PASS (all 10 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock src/lib/ongoing/schemas.ts src/lib/ongoing/__tests__/schemas.test.ts
git commit -m "feat(ongoing): add zod schemas for REST-edge response shapes (#114-a)"
```

---

## Task 2: Wire schemas into mapInventoryRow and mapTrackedOrder

**Files:**
- Modify: `src/lib/ongoing/client.ts:152-176` — rewrite `mapInventoryRow` and `mapTrackedOrder` bodies.
- Modify: `src/lib/ongoing/__tests__/client.test.ts` — add tests for the terminal-error throw on malformed rows.
- (Read only, to confirm `OngoingApiError` opts shape) `src/lib/ongoing/errors.ts`.

**Interfaces consumed:**
- `OngoingInventoryRowResponseSchema`, `OngoingTrackedOrderResponseSchema` from Task 1.
- `OngoingApiError` from `src/lib/ongoing/errors.ts` (post-#118 shape — implementer reads first).

- [ ] **Step 1: Read errors.ts to confirm reason-field convention**

Run: `cat src/lib/ongoing/errors.ts`
Read `OngoingApiError`'s constructor opts. Post-#118, the `unexpected_body_shape` reason will be in either:
- (A) a top-level `reason` field on opts, or
- (B) embedded in `body` (e.g. `body: { reason: "unexpected_body_shape", ... }`).

Use whichever shape #118 landed with. All subsequent code in this task MUST match that shape exactly.

- [ ] **Step 2: Write failing tests for malformed-row terminal-error throws**

In `src/lib/ongoing/__tests__/client.test.ts` (create the file if it does not exist; if it does, append to the appropriate describe block):

```ts
import { OngoingApiError } from "../errors"
// The test uses whatever named exports mapInventoryRow / mapTrackedOrder exposes.
// If they are internal (not exported), export them via an internal-only re-export
// in schemas.ts's test helper or exercise them through the public getInventory /
// getOrdersByStatus surface with a stub fetch that returns malformed rows.

describe("client REST-edge validation (#114-a)", () => {
  it("throws terminal OngoingApiError when inventory row lacks article", async () => {
    const client = makeStubClient({
      "/articles/inventory": [{ totalItems: {} }], // no article field
    })
    await expect(client.getInventory()).rejects.toMatchObject({
      name: "OngoingApiError",
      kind: "terminal",
    })
    // reason field placement matches #118's convention (top-level or nested in body)
  })

  it("throws terminal OngoingApiError when tracked order lacks orderInfo", async () => {
    const client = makeStubClient({
      "/orders": [{ parcels: [] }], // no orderInfo field
    })
    await expect(client.getOrdersByStatus(200, 400)).rejects.toMatchObject({
      name: "OngoingApiError",
      kind: "terminal",
    })
  })

  it("accepts an inventory row with omitted totalItems (defaults zeros)", async () => {
    const client = makeStubClient({
      "/articles/inventory": [{ article: { articleNumber: "SKU-1", articleSystemId: 1 } }],
    })
    const rows = await client.getInventory()
    expect(rows).toEqual([
      {
        articleNumber: "SKU-1",
        articleSystemId: 1,
        numberOfItems: 0,
        allocatedNumberOfItems: 0,
        sellableNumberOfItems: 0,
        toReceiveNumberOfItems: 0,
      },
    ])
  })
})

// makeStubClient is a helper defined at the top of the file that constructs an
// OngoingClient with a fetchImpl returning the given URL→body map. If the existing
// client.test.ts already has a helper for this, use it verbatim.
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/lib/ongoing/__tests__/client.test.ts`
Expected: FAIL — either "OngoingApiError not thrown" (current impl silently accepts malformed rows) or a different error.

- [ ] **Step 4: Rewrite mapInventoryRow and mapTrackedOrder**

Edit `src/lib/ongoing/client.ts` — replace lines 152–176 (the two `map*` functions). Add the import at the top:

```ts
import {
  OngoingInventoryRowResponseSchema,
  OngoingTrackedOrderResponseSchema,
} from "./schemas"
```

Replace `mapInventoryRow`:

```ts
function mapInventoryRow(raw: unknown): OngoingInventoryRow {
  const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError(
      "Ongoing inventory row failed schema validation",
      {
        kind: "terminal",
        // Match #118's reason-field placement. If #118 put reason on opts:
        //   reason: "unexpected_body_shape",
        // If #118 nested it in body:
        //   body: { reason: "unexpected_body_shape", issues: parsed.error.issues },
        // Pick the one that #118 landed with — see Task 2 Step 1.
      }
    )
  }
  const t = parsed.data.totalItems ?? {}
  return {
    articleNumber: parsed.data.article.articleNumber,
    articleSystemId: parsed.data.article.articleSystemId,
    numberOfItems: t.NumberOfItemsDecimal ?? 0,
    allocatedNumberOfItems: t.AllocatedNumberOfItems ?? 0,
    sellableNumberOfItems: t.SellableNumberOfItems ?? 0,
    toReceiveNumberOfItems: t.ToReceiveNumberOfItems ?? 0,
  }
}
```

Replace `mapTrackedOrder`:

```ts
function mapTrackedOrder(raw: unknown): OngoingTrackedOrder {
  const parsed = OngoingTrackedOrderResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError(
      "Ongoing tracked-order row failed schema validation",
      {
        kind: "terminal",
        // Same reason-field placement as mapInventoryRow above.
      }
    )
  }
  const parcels = parsed.data.parcels ?? []
  const trackingNumbers = parcels
    .map((p) => p.parcelTracking?.code ?? p.trackingNumber)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
  return {
    ongoingOrderId: parsed.data.orderInfo.orderId,
    orderNumber: parsed.data.orderInfo.orderNumber,
    statusNumber: parsed.data.orderInfo.orderStatus.number,
    statusText: parsed.data.orderInfo.orderStatus.text,
    trackingNumbers,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/lib/ongoing/__tests__/client.test.ts src/lib/ongoing/__tests__/schemas.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `yarn test`
Expected: All tests pass. If any pre-existing test provided a malformed row and expected `undefined` fields downstream, either the test uses stubbed data that's now correctly rejected (update the test to use a well-formed row) or the test was masking the very bug we're closing (update it to assert the throw).

- [ ] **Step 7: Lint and build**

Run: `yarn lint && yarn build`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.test.ts
git commit -m "feat(ongoing): validate REST-edge responses via zod schemas (#114-a)

mapInventoryRow and mapTrackedOrder now safeParse against zod schemas and
throw OngoingApiError({kind: 'terminal', reason: 'unexpected_body_shape'})
on malformed 2xx bodies, matching the convention introduced in #118."
```

---

## Self-Review

- **Spec coverage** (`docs/superpowers/specs/2026-07-04-tighten-any-type-holes-at-module-boundaries-114-design.md`, sub-issue #114-a): Add Zod dep (Task 1 Step 1), define schemas (Task 1 Step 4), rewrite `mapInventoryRow`/`mapTrackedOrder` to parse (Task 2 Step 4), throw terminal error on failure (Task 2 Step 4). All covered.
- **Placeholders:** Task 2 Step 4's code contains two spec-directed choices (reason field top-level vs body-nested) that depend on #118's landed shape — this is documented as an intentional "read errors.ts first" step (Task 2 Step 1), not a placeholder for the plan writer. The implementer picks one exact form from #118 and uses it. Not a plan defect.
- **Type consistency:** `mapInventoryRow` in Task 2 reads `parsed.data.article.articleNumber` (Zod-parsed) — matches `OngoingInventoryRow`'s required `articleNumber: string`. `mapTrackedOrder` reads `parsed.data.orderInfo.orderId` — matches `OngoingTrackedOrder`'s `ongoingOrderId: number`. Consistent.

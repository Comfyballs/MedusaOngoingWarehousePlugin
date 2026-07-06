# #114-d: Type `query: any` → `RemoteQueryFunction` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every `query: any` in source files with `query: RemoteQueryFunction`, so `query.graph({...})` entity/fields/filters are type-checked.

**Architecture:** Pure type-only rewrite. Import `RemoteQueryFunction` from `@medusajs/types` (specifically `@medusajs/types/dist/modules-sdk/remote-query` — but the top-level `@medusajs/types` re-exports it, so use the top-level path). Replace two source sites.

**Tech Stack:** TypeScript, Medusa v2 `@medusajs/types`.

## Global Constraints

- No runtime behavior change.
- `.graph(...)` call sites MUST NOT be reshaped. If a call surfaces a type error under `RemoteQueryFunction`, treat it as a latent bug (see Task 1 Step 5).

## File Structure

**Modify (2 source sites, current line numbers as of 2026-07-04):**

- `src/lib/ongoing/re-query-fulfillment-order.ts:34` — `query: any` on `reQueryFulfillmentOrder`'s parameter.
- `src/workflows/steps/reconcile-inventory-levels.ts:30` — `const query: any = container.resolve(ContainerRegistrationKeys.QUERY)` inside the step handler.

**Audit (do NOT modify, just verify no other residuals):**
- The four query.graph consumers not in the modify list (`src/subscribers/order-updated.ts:46,99`, `src/lib/ongoing/resolve-article-number.ts:52`) already resolve QUERY with an implicit inferred type — no annotation needed. Confirm they still compile after this change.

---

## Task 1: Type both `query: any` sites and audit call-graph downstream

**Files:**
- Modify: `src/lib/ongoing/re-query-fulfillment-order.ts:34`
- Modify: `src/workflows/steps/reconcile-inventory-levels.ts:30`

- [ ] **Step 1: Confirm the site list is still current**

Run: `rg -n "query:\s*any" src/`
Expected: exactly the two sites above. If more sites have appeared since 2026-07-04, add them to the pass.

- [ ] **Step 2: Verify clean baseline**

Run: `yarn lint && yarn build && yarn test`
Expected: 0 errors.

- [ ] **Step 3: Rewrite `re-query-fulfillment-order.ts`**

Edit `src/lib/ongoing/re-query-fulfillment-order.ts` — replace the parameter type on line 34:

Before:
```ts
import { MedusaError } from "@medusajs/framework/utils"

// ...

export async function reQueryFulfillmentOrder(
  query: any,
  fulfillmentId: string
): Promise<QueriedFulfillmentOrder> {
```

After:
```ts
import { MedusaError } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/types"

// ...

export async function reQueryFulfillmentOrder(
  query: RemoteQueryFunction,
  fulfillmentId: string
): Promise<QueriedFulfillmentOrder> {
```

- [ ] **Step 4: Rewrite `reconcile-inventory-levels.ts:30`**

Edit `src/workflows/steps/reconcile-inventory-levels.ts` — replace the local `query` declaration on line 30:

Before:
```ts
const query: any = container.resolve(ContainerRegistrationKeys.QUERY)
```

After:
```ts
const query = container.resolve<RemoteQueryFunction>(ContainerRegistrationKeys.QUERY)
```

Add the import if missing (place immediately below the existing framework imports at the top of the file):
```ts
import type { RemoteQueryFunction } from "@medusajs/types"
```

Note: If #114-b has already narrowed `container: any` on this file (line 20) to `MedusaContainer`, `container.resolve<T>(...)` will type-check correctly. If #114-b hasn't merged yet at rebase time, the outer `container: any` still lets `resolve<T>(...)` compile — the narrowing here is forward-safe either way.

- [ ] **Step 5: Verify no `query: any` remains anywhere in source**

Run: `rg -n "query:\s*any" src/`
Expected: no matches.

- [ ] **Step 6: Type-check strictly and audit graph call sites**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

If a `query.graph(...)` call site surfaces a type error under `RemoteQueryFunction`, DO NOT re-cast to `any`. Same rule as #114-b/-c:
1. Read `RemoteQueryFunction`'s `.graph` signature in `node_modules/@medusajs/types/dist/modules-sdk/remote-query.d.ts`.
2. Reshape the call to match (usually a wrong `entity` string, missing `fields`, or malformed `filters`).
3. If non-trivial (>5 lines) or behavior-changing, STOP — open a follow-up bug, revert THAT site to `any` with a `// TODO(#<new-bug>): query.graph shape mismatch pending fix` comment linking the issue, and continue.

- [ ] **Step 7: Full test suite + lint + build**

Run: `yarn test && yarn lint && yarn build`
Expected: All tests pass, 0 lint errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ongoing/re-query-fulfillment-order.ts src/workflows/steps/reconcile-inventory-levels.ts
git commit -m "refactor: type query:any as RemoteQueryFunction (#114-d)

Replaces the two source-file query:any sites with the framework-exported
RemoteQueryFunction type. Type-only; no runtime change. query.graph
call sites now type-checked."
```

---

## Self-Review

- **Spec coverage** (design doc, sub-issue #114-d): "Type `re-query-fulfillment-order.ts`'s `query` parameter as `RemoteQueryFunction`" — Task 1 Step 3. Plus the second site the audit surfaced at `reconcile-inventory-levels.ts:30` — Task 1 Step 4. Covered.
- **Placeholders:** None.
- **Type consistency:** `RemoteQueryFunction` used in both sites; import path `@medusajs/types` re-exports from the internal submodule.
- **Interaction with #114-b:** noted in Task 1 Step 4 — the narrowing is forward-safe whether #114-b lands before or after.

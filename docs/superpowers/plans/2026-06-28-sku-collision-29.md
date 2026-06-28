# SKU-Collision Handling (SKU→articleNumber Resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable `resolveArticleNumber(query, sku)` that resolves a Medusa SKU to an Ongoing articleNumber, treating any non-unique (count > 1) or unresolvable (count 0) SKU as a **terminal** error surfaced to the operator — never a guess.

**Architecture:** A single pure async function in the Ongoing lib that takes Medusa's `query` (RemoteQueryFunction) and a `sku`, runs a same-module `query.graph` over `product_variant` filtered by `sku`, and asserts exactly one match. On `count !== 1` it throws an `OngoingApiError` with `kind: "terminal"` (which maps 1:1 to `OngoingOrderSync.error_class = "terminal"`, spec §11) carrying an operator-readable message that names the SKU and the count. On `count === 1` it returns the SKU verbatim as the articleNumber (Ongoing `articleNumber == Medusa SKU`; article push is deferred per spec §1/§13). The function is consumed by the #24 mapper / #26 order-push workflow and reused by stock sync (M4). Tested as a pure unit (mocked `query.graph`, no DB).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests. No new runtime dependencies.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Copy from `package.json`.
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module names MUST be **camelCase**, never dashes: module id is `"ongoing"`.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100.
- Plugin build output is `.medusa/server`; migrations for plugin models are generated with **`npx medusa plugin:db:generate`** (not the app-level `db:generate`).
- This is a **plugin**, not an app: there is no local Postgres/Medusa instance wired here, so this issue's tests are **pure unit tests** (mocked `query.graph`, no DB). Wiring correctness is verified via `yarn build` succeeding.
- **TDD is mandatory:** every behavior change starts with a failing Jest unit test, run to confirm it fails, before implementation.
- **No new DB column.** Per the user decision, the HARD assumption ships for M2: any non-unique or unresolvable SKU is terminal. A future per-integration "require unique SKU" toggle is noted in code/docs but NOT built now.
- **Error classification is load-bearing:** the thrown error MUST be an `OngoingApiError` with `kind === "terminal"` so the existing recordSync path writes `OngoingOrderSync.error_class = "terminal"` (`src/modules/ongoing/models/order-sync.ts:15`) and the dashboard (spec §10) surfaces it.

---

## File Structure

**Create:**
- `src/lib/ongoing/resolve-article-number.ts` — the `resolveArticleNumber(query, sku)` resolver + its narrow `query`-shape type.
- `src/lib/ongoing/__tests__/resolve-article-number.test.ts` — unit tests (mocked `query.graph`).

**Modify:**
- `src/lib/ongoing/index.ts` — barrel re-export of `resolveArticleNumber` and its type so the #24 mapper / #26 push and later stock sync import it from `../../lib/ongoing`.

**Rationale:** The resolver lives in `src/lib/ongoing/` (the Medusa-agnostic-where-possible lib) alongside `errors.ts`, because it is a small, pure function reused by multiple consumers (mapper, push workflow, stock sync). It depends only on a structural `query.graph` shape and the existing `OngoingApiError`, not on the Medusa container, so it is trivially unit-testable with a mocked `query`.

---

## Task 1: SKU→articleNumber resolver with terminal collision/unresolvable handling

**Files:**
- Create: `src/lib/ongoing/resolve-article-number.ts`
- Modify: `src/lib/ongoing/index.ts`
- Test: `src/lib/ongoing/__tests__/resolve-article-number.test.ts`

**Interfaces:**
- Consumes:
  - `OngoingApiError` from `./errors` (existing — `src/lib/ongoing/errors.ts:10`): `new OngoingApiError(message, { kind: "terminal" })`. The `status`/`retryAfterMs`/`body` opts are optional and omitted here (this is a data-integrity error, not an HTTP error).
  - Medusa's `query` object. To keep the lib free of a hard `@medusajs/framework` type import, define a **narrow structural type** for just the `graph` call this function makes:
    ```ts
    export type ArticleNumberQuery = {
      graph<T = unknown>(config: {
        entity: string
        fields: string[]
        filters?: Record<string, unknown>
      }): Promise<{ data: T[] }>
    }
    ```
    The real Medusa `RemoteQueryFunction` is structurally assignable to this. Consumers pass `container.resolve("query")` (or `req.scope.resolve("query")`) directly.
- Produces:
  - `async function resolveArticleNumber(query: ArticleNumberQuery, sku: string): Promise<string>` — returns the SKU as the Ongoing articleNumber when exactly one Medusa variant has that SKU; throws a terminal `OngoingApiError` otherwise (count 0 or count > 1, or a blank SKU).
  - `export type ArticleNumberQuery` (above), re-exported from the lib barrel.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/resolve-article-number.test.ts`:
```ts
import { resolveArticleNumber, type ArticleNumberQuery } from "../resolve-article-number"
import { OngoingApiError } from "../errors"

// Build a fake `query` whose graph() returns the given variant rows.
const queryReturning = (rows: Array<{ id: string; sku: string }>): ArticleNumberQuery => ({
  graph: jest.fn().mockResolvedValue({ data: rows }),
})

describe("resolveArticleNumber", () => {
  it("returns the SKU as articleNumber when exactly one variant matches", async () => {
    const query = queryReturning([{ id: "variant_1", sku: "ABC-123" }])

    await expect(resolveArticleNumber(query, "ABC-123")).resolves.toBe("ABC-123")

    expect(query.graph).toHaveBeenCalledWith({
      entity: "product_variant",
      fields: ["id", "sku"],
      filters: { sku: "ABC-123" },
    })
  })

  it("throws a terminal OngoingApiError naming the SKU and count when >1 variant matches", async () => {
    const query = queryReturning([
      { id: "variant_1", sku: "DUP-9" },
      { id: "variant_2", sku: "DUP-9" },
    ])

    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toMatchObject({
      kind: "terminal",
    })
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toBeInstanceOf(OngoingApiError)
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toThrow(/DUP-9/)
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toThrow(/2/)
  })

  it("throws a terminal OngoingApiError naming the SKU when 0 variants match", async () => {
    const query = queryReturning([])

    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toMatchObject({
      kind: "terminal",
    })
    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toThrow(/MISSING-1/)
    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toThrow(/0/)
  })

  it("throws a terminal OngoingApiError without querying when the SKU is blank", async () => {
    const query = queryReturning([{ id: "variant_1", sku: "" }])

    await expect(resolveArticleNumber(query, "")).rejects.toMatchObject({ kind: "terminal" })
    expect(query.graph).not.toHaveBeenCalled()
  })

  it("classifies the thrown error so it maps to OngoingOrderSync.error_class 'terminal'", async () => {
    const query = queryReturning([])

    try {
      await resolveArticleNumber(query, "X")
      throw new Error("expected resolveArticleNumber to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(OngoingApiError)
      // recordSync writes error_class = err.kind for an OngoingApiError; assert the value the
      // OngoingOrderSync.error_class enum (["retryable","terminal"]) will receive.
      expect((err as OngoingApiError).kind).toBe("terminal")
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/resolve-article-number.test.ts`
Expected: FAIL — cannot find module `../resolve-article-number`.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/ongoing/resolve-article-number.ts`:
```ts
import { OngoingApiError } from "./errors"

/**
 * Narrow structural shape of Medusa's `query` object — only the `graph` call this
 * resolver makes. Medusa's RemoteQueryFunction is structurally assignable to this,
 * so consumers pass `container.resolve("query")` / `req.scope.resolve("query")` directly.
 */
export type ArticleNumberQuery = {
  graph<T = unknown>(config: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }): Promise<{ data: T[] }>
}

type VariantRow = { id: string; sku: string | null }

/**
 * Resolve a Medusa variant SKU to an Ongoing articleNumber.
 *
 * Ongoing's articleNumber is the Medusa SKU (article push is deferred — spec §1/§13),
 * so a unique resolution simply returns the SKU. SKU is NOT unique across Medusa
 * variants, so this looks the SKU up across ALL variants and requires exactly one
 * match. Any non-unique (count > 1) or unresolvable (count 0, or blank SKU) result is
 * a TERMINAL error (spec §11): we surface it to the operator rather than guess.
 *
 * The thrown OngoingApiError carries `kind: "terminal"`, which the sync recorder maps
 * onto OngoingOrderSync.error_class = "terminal" for the order widget / dashboard.
 *
 * NOTE (future toggle): the "require unique SKU" assumption is hard-coded for now. A
 * per-integration opt-out (e.g. pick the first match) could later be added as a column
 * on OngoingIntegration; intentionally NOT built in this milestone.
 */
export async function resolveArticleNumber(
  query: ArticleNumberQuery,
  sku: string
): Promise<string> {
  if (!sku) {
    throw new OngoingApiError(
      "[ongoing] cannot resolve an Ongoing articleNumber: the line item has no SKU. " +
        "Set a SKU on the Medusa variant before fulfilling through Ongoing.",
      { kind: "terminal" }
    )
  }

  const { data } = await query.graph<VariantRow>({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku },
  })

  const count = data.length

  if (count === 1) {
    return sku
  }

  if (count === 0) {
    throw new OngoingApiError(
      `[ongoing] SKU "${sku}" matched 0 Medusa variants — cannot resolve an Ongoing ` +
        `articleNumber. Ensure a product variant with this SKU exists.`,
      { kind: "terminal" }
    )
  }

  throw new OngoingApiError(
    `[ongoing] SKU "${sku}" matched ${count} Medusa variants — it must be unique to ` +
      `resolve an Ongoing articleNumber. Make the SKU unique across variants, then retry.`,
    { kind: "terminal" }
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/resolve-article-number.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Re-export from the lib barrel**

Edit `src/lib/ongoing/index.ts` — add the resolver export. The file currently reads:
```ts
export { OngoingClient } from "./client"
export { OngoingApiError, classifyHttpStatus } from "./errors"
export { Throttle } from "./throttle"
export * from "./types"
```
Add after the `Throttle` line:
```ts
export { resolveArticleNumber, type ArticleNumberQuery } from "./resolve-article-number"
```

- [ ] **Step 6: Run the whole lib suite to confirm nothing regressed**

Run: `yarn test src/lib/ongoing`
Expected: PASS (all existing lib tests plus the 5 new ones).

- [ ] **Step 7: Build the plugin to validate it compiles**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ongoing/resolve-article-number.ts src/lib/ongoing/index.ts src/lib/ongoing/__tests__/resolve-article-number.test.ts
git commit -m "feat(ongoing-client): terminal SKU->articleNumber resolver (Closes #29)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (issue #29 slice):** reusable `resolveArticleNumber(query, sku)` ✓; same-module `query.graph` over `product_variant` filtered by `{ sku }`, fields `["id","sku"]` (verified pattern, querying-data reference §"Filtering Nested Relations (Same Module)" — variant.sku is same-module, no Index Module needed) ✓; `count !== 1` → terminal `OngoingApiError` (spec §11) ✓; `count === 1` → returns SKU as articleNumber, article push deferred (spec §1/§13) ✓; operator-readable message naming SKU + count ✓; terminal classification maps to `OngoingOrderSync.error_class = "terminal"` (model enum `src/modules/ongoing/models/order-sync.ts:15`) — asserted in tests ✓; HARD assumption shipped, future toggle noted not built (user decision) ✓; `yarn build` step ✓. Consumers (#24 mapper, #26 push, M4 stock sync) import via the lib barrel — wiring those callers is their own issues, out of scope here.
- **Placeholder scan:** every code step contains full code; the single NOTE (future per-integration toggle) is an explicit deferred-scope marker per the user decision, not missing content.
- **Type consistency:** `ArticleNumberQuery`, `resolveArticleNumber`, and `OngoingApiError`'s `{ kind: "terminal" }` opts shape match the existing `OngoingApiError` constructor (`src/lib/ongoing/errors.ts:16-21`, where `status`/`retryAfterMs`/`body` are optional). The thrown `kind` value (`"terminal"`) is a member of both the `OngoingErrorKind` union and the `error_class` model enum.

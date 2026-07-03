# client.ts safeJson + unchecked cast lets malformed 2xx bodies flow into the domain (#107) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is business logic (the Ongoing REST client's response-parsing contract) and follows superpowers:test-driven-development — failing tests precede the implementation.

**Goal:** `OngoingClient.doFetch` (`src/lib/ongoing/client.ts:59-85`) must never cast an unvalidated 2xx response body to the caller's generic `T`. Today `safeJson` (`src/lib/ongoing/client.ts:178-184`) swallows `JSON.parse` failures and returns the raw text, and `doFetch` casts that raw text straight to `T` (`client.ts:84`, `return parsed as T`) with no `Content-Type` or shape check. A 200 response with an HTML error page, a truncated body, or a gateway-timeout page silently becomes e.g. `putOrder`'s `res.orderId === undefined`, and `{ ongoingOrderId: undefined }` gets persisted with no error trail (`src/workflows/steps/push-order-record-sync.ts:100`, `src/modules/ongoing/models/order-sync.ts:9`). Fix: validate `Content-Type: application/json` and JSON-parseability on every 2xx response before it is cast to `T`, throwing a typed `OngoingApiError({ kind: "terminal", reason: "unexpected_body_shape" })` on either failure.

**Architecture:** All Ongoing HTTP calls funnel through `OngoingClient.doFetch` (`client.ts:59`), called by the single `protected request<T>` wrapper (`client.ts:36`), which every public operation (`getOrderStatuses`, `getInventory`, `getOrdersByStatus`, `putOrder`, `cancelOrder`) goes through. Fixing `doFetch` once closes the gap for all of them — no per-operation changes are needed. The fix is edge validation inside the existing `OngoingApiError` type (add an optional `reason` field), not a new schema-validation dependency; see the **Zod/valibot vs typed error** decision below.

**Tech Stack:** Medusa 2.16.0, TypeScript 5.6 (`Node16` module resolution, decorators enabled — root `tsconfig.json`), yarn 4.6.0, Node >= 20, Jest (`@swc/jest`, `testEnvironment: "node"`, `clearMocks: true`, `jest.config.js:1-15`).

## Global Constraints

- **Scope is `doFetch`'s 2xx branch only.** The `!res.ok` (error) branch (`client.ts:73-82`) already carries `status`/`kind` and is unaffected — its body is diagnostic-only (fed into `OngoingApiError.body` for logging, never cast to `T`), so a best-effort parse there is safe and stays as-is (renamed for clarity, not behavior-changed).
- **Decision: typed `OngoingApiError` at the client edge, NOT a Zod/valibot schema layer.** Justification, from what already exists in `src/lib/ongoing/`:
  - `grep -rn '"zod"\|"valibot"\|"yup"\|"ajv"' package.json` returns zero matches — no schema-validation library is a dependency anywhere in this plugin today. Adding one here would be the first such dependency in the codebase, solely to fix one call site.
  - The existing precedent for "this response/input doesn't have the shape we need" is a **manually-thrown `OngoingApiError({ kind: "terminal" })`**, not a schema library: `src/lib/ongoing/order-mapper.ts:12-14` (`function terminal(message) { throw new OngoingApiError(message, { kind: "terminal" }) }`) and `src/lib/ongoing/resolve-article-number.ts:45-76` (three hand-written terminal throws for blank/non-unique SKU). `OngoingApiError` is already the codebase's one error currency; extending it with a `reason` discriminant is the consistent move, not a divergence.
  - The issue's own **Recommended fix** section asks for exactly this: "Throw a typed `OngoingApiError({ kind: 'terminal', reason: 'unexpected_body_shape' })` on mismatch" — a typed error, not a validation library.
  - Scope containment: full per-operation runtime schema validation (e.g. asserting `putOrder`'s response literally has a numeric `orderId`, or that `getInventory` rows match `OngoingInventoryRow`) is a materially larger, separate hardening effort spanning every response shape in `types.ts`. It is NOT required to close CRIT-1 (whose failure scenario is specifically "non-JSON body on a 2xx", not "well-formed JSON missing a field") and is not requested by the issue. If deeper per-shape validation is wanted later, it should be its own issue, scoped and prioritized independently — not silently bundled into this fix.
- **`Content-Type` check is case-insensitive substring match** (`(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")`) so `application/json; charset=utf-8` still passes — matches how every existing test in this suite sets the header (`"content-type": "application/json"`, e.g. `client.request.test.ts:14`).
- **An empty 2xx body is not "malformed"** and must keep resolving to `undefined` (existing behavior `cancelOrder` relies on via `res?.orderId ?? ongoingOrderId`, `client.ts:122`) — the `Content-Type`/JSON checks only run when `text` is non-empty. This preserves `cancelOrder`'s legitimate 204/empty-200-body case; it does not change or remove `cancelOrder`'s `res?.orderId ?? ongoingOrderId` fallback (out of scope for this issue — the fallback is orthogonal to the cast bug, and the issue's Verification section only flags it as "a symptom of the same gap, not a fix", not something this fix must also change).
- **Test command:** `yarn test <path-substring>` (Jest substring match); full suite `yarn test`.
- **No `verify-plan.sh` script exists in this repo** (checked: absent) — skipped per instructions; this plan is manually scanned for `TODO`/`TBD`/`<PLACEHOLDER>`/bare `path/to/…` markers instead (see Self-Review).

## Migration / roll-out note

**No schema/model migration is needed.** `OngoingOrderSync.ongoing_order_id` is already `model.number().nullable()` (`src/modules/ongoing/models/order-sync.ts:9`) — the column always allowed `null`; the bug is that the buggy code path could write `undefined` into it (a no-op update, per Mikro-ORM semantics, leaving the column at its prior value — `null` from the initial insert at `push-order-record-sync.ts:39-47`, which never sets `ongoing_order_id`) while `sync_state` still flipped to `"sent"` (`push-order-record-sync.ts:94-103`). This milestone is titled "Post-launch hardening", so treat this as a real possibility, not a hypothetical:

- **Detection (run by an operator against the consuming Medusa app's Postgres DB — this plugin repo has no direct DB access of its own):**
  ```sql
  SELECT id, medusa_order_id, medusa_fulfillment_id, ongoing_order_number, sync_state, last_synced_at
  FROM ongoing_order_sync
  WHERE sync_state IN ('sent', 'shipped')
    AND ongoing_order_id IS NULL
    AND deleted_at IS NULL;
  ```
- **Remediation (existing code path, no new code needed):** for each row returned, call the existing admin re-push endpoint, which already exists and already runs through the now-fixed `doFetch`: `POST /admin/ongoing/orders/{medusa_order_id}/repush` with body `{ "fulfillment_id": "<medusa_fulfillment_id>" }` (`src/api/admin/ongoing/orders/[orderId]/repush/route.ts:15-51`). This re-runs `pushOrderToOngoing`, which calls `client.putOrder` again and re-records `ongoing_order_id` correctly (assuming the underlying Ongoing order still exists — it does, since Ongoing accepted the original `PUT` and only the response body was mangled in transit).
- No new source file is added for detection/backfill: building a dedicated admin route or dashboard filter for this one-time historical query is a larger, separate scope than this client-level bug fix and is not required to close CRIT-1. The SQL query above plus the pre-existing repush endpoint is the complete, sufficient remediation path.

---

## File Structure

**Modify (Task 1):**
- `src/lib/ongoing/errors.ts` — add `OngoingApiErrorReason` type and an optional `reason` field on `OngoingApiError`.
- `src/lib/ongoing/client.ts` — restructure `doFetch`'s 2xx branch to validate `Content-Type` and JSON-parseability before casting to `T`; rename `safeJson` → `safeJsonForDiagnostics` and restrict its use to the `!res.ok` (error) branch only.
- `src/lib/ongoing/__tests__/errors.test.ts` — add a test asserting `OngoingApiError` carries `reason`.
- `src/lib/ongoing/__tests__/client.request.test.ts` — add 4 new test cases covering the failure scenario (non-JSON content-type, JSON body with wrong content-type, truncated JSON with correct content-type) plus a no-retry assertion; the existing "parses JSON on success" test (`client.request.test.ts:17-27`) already covers the 200-with-parseable-JSON case.
- `src/lib/ongoing/__tests__/client.test.ts` — update the `headers` mock (currently `{ get: () => null }`, lines 18 and 23) to return `"application/json"` for a `content-type` lookup, so this pre-existing 2xx-JSON test keeps passing under the new stricter check.

**Read only (verified unaffected, no changes needed):**
- `src/lib/ongoing/__tests__/client.operations.test.ts`, `client.orders-by-status.test.ts`, `client.cancel.test.ts` — all already construct real `Response` objects with `"content-type": "application/json"` set (e.g. `client.operations.test.ts:12-13`, `client.cancel.test.ts:13-17`, `client.orders-by-status.test.ts:12-16`), so they pass unchanged under the new check.
- `src/workflows/steps/push-order-record-sync.ts`, `src/api/admin/ongoing/orders/[orderId]/repush/route.ts`, `src/workflows/steps/upsert-ongoing-order-edit.ts`, `src/workflows/steps/decide-ongoing-cancel.ts` — all consume `client.putOrder`/`client.cancelOrder` results; none need code changes, since the fix guarantees a well-formed object (or a thrown `OngoingApiError`) reaches them instead of a silently-`undefined`-shaped one.

---

## Task 1: Validate 2xx `Content-Type` and JSON-parseability in `doFetch` before casting to `T` (TDD)

**Files:**
- Modify: `src/lib/ongoing/errors.ts`
- Modify: `src/lib/ongoing/client.ts`
- Test: `src/lib/ongoing/__tests__/errors.test.ts`
- Test: `src/lib/ongoing/__tests__/client.request.test.ts`
- Test: `src/lib/ongoing/__tests__/client.test.ts`

**Interfaces:**
- `OngoingApiError` (`src/lib/ongoing/errors.ts:19`) gains one new optional constructor field: `reason?: OngoingApiErrorReason`, stored as `this.reason`. Existing constructor calls (`errors.test.ts:20,23,40`; `client.ts:76-81`; `order-mapper.ts:13`; `resolve-article-number.ts:45-76`) omit it and are unaffected — it is optional.
- `OngoingClient.doFetch<T>` (`src/lib/ongoing/client.ts:59`, `private`) keeps its exact signature `(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>`. No public method (`getOrderStatuses`, `getInventory`, `getOrdersByStatus`, `putOrder`, `cancelOrder`, `testConnection`) changes signature.
- `safeJson` (`client.ts:178`, module-private) is renamed `safeJsonForDiagnostics` and is called only from the `!res.ok` branch. No exported symbol references the old name (verified: `grep -rn "safeJson" src` only matches `client.ts`).

- [ ] **Step 1: Write the failing tests in `client.request.test.ts`**

In `src/lib/ongoing/__tests__/client.request.test.ts`, add 4 new `it` blocks inside the existing `describe("OngoingClient.request", …)` block, after the last existing test (`"honors Retry-After seconds on 429…"`, ending at line 91, just before the closing `})` on line 92):

```ts
  it("throws a terminal unexpected_body_shape error when a 200 response has a non-JSON content-type", async () => {
    // Simulates an intermediary proxy/gateway returning an HTML error page with a 200
    // status (the CRIT-1 failure scenario) instead of Ongoing's real JSON response.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
    // A malformed 2xx body must not be retried — it is not a transient failure.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws a terminal unexpected_body_shape error when a 200 body is parseable JSON but the content-type is wrong", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderId: 1 }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
  })

  it("throws a terminal unexpected_body_shape error when a 200 body is truncated JSON despite a correct content-type", async () => {
    // Simulates a gateway-timeout page that cuts the body off mid-response.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('{"orderId":', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
  })

  it("resolves undefined for an empty 200 body without validating content-type", async () => {
    // An empty body (e.g. a bare 204-style DELETE response) has no shape to
    // validate and must keep resolving, not throw.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("", { status: 200, headers: {} })
    )
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error private
    const data = await client.request("DELETE", "/orders/1")
    expect(data).toBeUndefined()
  })
```

- [ ] **Step 2: Write the failing test in `errors.test.ts`**

In `src/lib/ongoing/__tests__/errors.test.ts`, add a test inside the existing `describe("OngoingApiError", …)` block (after the existing `"carries status, kind, and body"` test, before the block's closing `})` on line 46):

```ts
  it("carries an optional reason for finer-grained terminal classification", () => {
    const err = new OngoingApiError("boom", {
      status: 200,
      kind: "terminal",
      reason: "unexpected_body_shape",
      body: "<html>",
    })
    expect(err.reason).toBe("unexpected_body_shape")
  })
```

- [ ] **Step 3: Update the pre-existing `client.test.ts` fixture so it keeps passing under the stricter check**

In `src/lib/ongoing/__tests__/client.test.ts`, both `mockResolvedValueOnce` calls currently pass `headers: { get: () => null }` (lines 18 and 23). Replace both occurrences (`replace_all`) of:

```ts
        headers: { get: () => null },
```

with:

```ts
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
```

(This is a pre-existing 200-with-parseable-JSON test — `getInventory`'s pagination — so it must declare a matching content-type once `doFetch` starts requiring one; this is a fixture update, not new behavior under test.)

- [ ] **Step 4: Run the tests to verify the new ones fail and the fixture update alone does not turn them green**

Run: `yarn test src/lib/ongoing/__tests__/client.request.test.ts`
Expected: the 3 new "throws…" tests FAIL (current `doFetch` never rejects — it returns the raw HTML/text/truncated string cast to `T` instead of throwing). The 4th new test ("resolves undefined for an empty 200 body…") PASSES already (current behavior). All 6 pre-existing tests in the file still pass.

Run: `yarn test src/lib/ongoing/__tests__/errors.test.ts`
Expected: the new `reason` test FAILS (`err.reason` is `undefined` — `OngoingApiError` doesn't read/store `opts.reason` yet). All pre-existing tests in the file still pass.

Run: `yarn test src/lib/ongoing/__tests__/client.test.ts`
Expected: PASSES (Step 3's fixture update is content-type-correct already; current code doesn't check it yet either way, so this is a no-op confirmation, not a red step).

- [ ] **Step 5: Add `OngoingApiErrorReason` and the `reason` field to `errors.ts`**

In `src/lib/ongoing/errors.ts`, after the `OngoingErrorKind` type (line 1), add:

```ts
export type OngoingErrorKind = "retryable" | "terminal"

// Machine-readable sub-classification for a terminal OngoingApiError, for callers/logs
// that need to distinguish WHY beyond the coarse kind. "unexpected_body_shape": doFetch
// received a 2xx response whose Content-Type wasn't application/json, or whose body
// wasn't valid JSON — never cast an unvalidated body to the caller's generic T (#107).
export type OngoingApiErrorReason = "unexpected_body_shape"
```

Then update the `OngoingApiError` class (currently lines 19-36):

```ts
export class OngoingApiError extends Error {
  status?: number
  kind: OngoingErrorKind
  retryAfterMs?: number
  body?: unknown
  reason?: OngoingApiErrorReason

  constructor(
    message: string,
    opts: {
      status?: number
      kind: OngoingErrorKind
      retryAfterMs?: number
      body?: unknown
      reason?: OngoingApiErrorReason
    }
  ) {
    super(message)
    this.name = "OngoingApiError"
    this.status = opts.status
    this.kind = opts.kind
    this.retryAfterMs = opts.retryAfterMs
    this.body = opts.body
    this.reason = opts.reason
  }
}
```

- [ ] **Step 6: Restructure `doFetch`'s 2xx branch in `client.ts`**

In `src/lib/ongoing/client.ts`, replace `doFetch` (currently lines 59-85):

```ts
  private async doFetch<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await res.text()
    const parsed = text ? safeJson(text) : undefined

    if (!res.ok) {
      const kind = classifyHttpStatus(res.status)
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"))
      throw new OngoingApiError(`Ongoing ${method} ${path} failed (${res.status})`, {
        status: res.status,
        kind,
        retryAfterMs,
        body: parsed,
      })
    }

    return parsed as T
  }
```

with:

```ts
  private async doFetch<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await res.text()

    if (!res.ok) {
      // Error-body parsing is best-effort/diagnostic only -- fed into
      // OngoingApiError.body for logging, never cast to T -- so a swallowed
      // JSON.parse failure here is safe.
      const parsed = text ? safeJsonForDiagnostics(text) : undefined
      const kind = classifyHttpStatus(res.status)
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"))
      throw new OngoingApiError(`Ongoing ${method} ${path} failed (${res.status})`, {
        status: res.status,
        kind,
        retryAfterMs,
        body: parsed,
      })
    }

    // An empty 2xx body (e.g. a bare DELETE response) has no shape to validate.
    if (!text) {
      return undefined as T
    }

    // #107: a 2xx response is only trustworthy if the server actually says it's
    // JSON. Ongoing (or an intermediary proxy) returning HTML/plain-text on a
    // 200 must not be cast to T -- that silently produces `undefined` fields
    // downstream (e.g. putOrder's `res.orderId`) with no error trail.
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
    if (!contentType.includes("application/json")) {
      throw new OngoingApiError(
        `Ongoing ${method} ${path} returned a ${res.status} with content-type ` +
          `"${contentType || "(none)"}" instead of application/json`,
        { status: res.status, kind: "terminal", reason: "unexpected_body_shape", body: text }
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OngoingApiError(
        `Ongoing ${method} ${path} returned a ${res.status} with content-type ` +
          `application/json but an unparseable body`,
        { status: res.status, kind: "terminal", reason: "unexpected_body_shape", body: text }
      )
    }

    return parsed as T
  }
```

Then rename the module-private helper (currently lines 178-184):

```ts
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
```

to:

```ts
// Best-effort diagnostic parse for an ERROR (!res.ok) response body only -- the
// result is attached to OngoingApiError.body for logging and is never cast to a
// caller's generic T, so swallowing a JSON.parse failure here is safe. A 2xx body
// goes through the strict Content-Type + JSON.parse path in doFetch instead (#107).
function safeJsonForDiagnostics(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
```

- [ ] **Step 7: Run the tests to verify they now pass**

Run: `yarn test src/lib/ongoing/__tests__/client.request.test.ts`
Expected: PASS — all 4 new tests plus all 6 pre-existing tests.

Run: `yarn test src/lib/ongoing/__tests__/errors.test.ts`
Expected: PASS — the new `reason` test plus all pre-existing tests.

Run: `yarn test src/lib/ongoing/__tests__/client.test.ts`
Expected: PASS (unchanged from Step 4 — the fixture already declared the right content-type).

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts src/lib/ongoing/__tests__/client.orders-by-status.test.ts src/lib/ongoing/__tests__/client.cancel.test.ts`
Expected: PASS — no changes made to these files or their fixtures; confirms the real-`Response` `content-type: application/json` fixtures in these three files are unaffected by the stricter check.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ongoing/errors.ts src/lib/ongoing/client.ts src/lib/ongoing/__tests__/errors.test.ts src/lib/ongoing/__tests__/client.request.test.ts src/lib/ongoing/__tests__/client.test.ts
git commit -m "fix(ongoing): reject malformed 2xx bodies in doFetch instead of casting them to T (#107)"
```

---

## Task 2: Full verification before review

No new code — run the full gates and confirm green.

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: PASS — all suites green, in particular `src/lib/ongoing/__tests__/client.request.test.ts`, `client.test.ts`, and `errors.test.ts` with their new/updated cases, and no regression anywhere else (in particular `src/workflows/steps/__tests__/push-order-record-sync.test.ts` and any test exercising `putOrder`/`cancelOrder` through a mocked `OngoingClient` rather than a mocked `fetchImpl` — those are untouched by this change since they mock at the client-method boundary, not at `fetch`).

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: PASS — `medusa lint` (eslint flat config, `@medusajs/eslint-plugin` recommended) reports no errors on `src/lib/ongoing/errors.ts`, `src/lib/ongoing/client.ts`, or the three modified test files.

- [ ] **Step 3: Build**

Run: `yarn build`
Expected: PASS — `medusa plugin:build` compiles `src/lib/ongoing/errors.ts` and `src/lib/ongoing/client.ts` to `.medusa/server` with no type errors (the new `OngoingApiErrorReason` type and optional `reason` field type-check against every existing `OngoingApiError` constructor call site, all of which omit it).

- [ ] **Step 4: Confirm the diff scope**

Verify the working tree touches only the five files from Task 1 (`src/lib/ongoing/errors.ts`, `src/lib/ongoing/client.ts`, `src/lib/ongoing/__tests__/errors.test.ts`, `src/lib/ongoing/__tests__/client.request.test.ts`, `src/lib/ongoing/__tests__/client.test.ts`) — no changes to `types.ts`, any workflow step, any provider, any admin route, or any model/migration. Per `CLAUDE.md` ("Code review before merging"), the reviewer must independently load `medusa-dev:building-with-medusa` before merge.

- [ ] **Step 5: Re-confirm the roll-out note is actionable**

Confirm the "Migration / roll-out note" section above (SQL detection query + existing repush endpoint) needs no further action as part of this PR — it is an operator runbook to hand off, not a code change. No commit needed for this step.

---

## Self-Review (completed during planning)

- **Issue coverage:** both `Files` bullets (`client.ts:71` safeJson, `client.ts:84` unchecked cast) are addressed — `safeJson` is scoped to diagnostics-only and renamed; the cast at the old line 84 is now preceded by content-type + `JSON.parse` validation. All three `Recommended fix` bullets are implemented: `Content-Type` validated before parse, a typed `OngoingApiError({ kind: "terminal", reason: "unexpected_body_shape" })` thrown on mismatch, and `JSON.parse` failures are no longer swallowed on the 2xx path.
- **Failure-scenario test coverage:** "200 with non-JSON body" → Step 1's first test (`text/html`, garbage body). "200 with JSON but wrong content-type" → Step 1's second test. "200 with parseable JSON" (happy path) → covered by the pre-existing `client.request.test.ts:17-27` test, left unmodified, plus verified still green in Task 1 Step 7. Bonus: "truncated response" (named explicitly in the issue body) → Step 1's third test.
- **Decision made, not deferred:** typed `OngoingApiError` vs Zod/valibot is decided in Global Constraints with a `grep`-verified justification (zero schema-validation dependency exists in the codebase; the existing terminal-error idiom in `src/lib/ongoing/` is a manually-thrown `OngoingApiError`), not left as an open question.
- **Migration/roll-out addressed:** confirmed no schema change is needed (column already nullable); confirmed existing state could plausibly be affected (post-launch milestone) and given a concrete SQL detection query plus the pre-existing repush remediation path, without inventing new unrequested code.
- **Placeholder scan:** no `TODO`/`TBD`/`FIXME`/`<PLACEHOLDER>`/bare `path/to/…` anywhere in this document; every code step shows complete code; every command has an expected result.
- **Regression risk swept:** every other test file constructing a fetch mock (`client.operations.test.ts`, `client.orders-by-status.test.ts`, `client.cancel.test.ts`) was individually read and confirmed to already set `content-type: application/json` on its `Response` fixtures, so none needed edits; only `client.test.ts`'s bespoke `{ get: () => null }` mock needed the Step 3 fixture fix.

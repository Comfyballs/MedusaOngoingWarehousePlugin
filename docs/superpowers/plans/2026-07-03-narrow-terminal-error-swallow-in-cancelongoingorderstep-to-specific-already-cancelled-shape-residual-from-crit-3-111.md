# Narrow cancelOngoingOrderStep's terminal-error swallow to the specific "already cancelled" shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cancelOngoingOrderHandler` (`src/workflows/steps/cancel-ongoing-order.ts:15-42`) currently swallows *any* terminal (4xx, non-429) `OngoingApiError` from `client.cancelOrder` as an idempotent "already cancelled" success. Narrow that swallow to match only Ongoing's specific already-cancelled error shape; every other terminal 4xx (malformed id, permissions, 401/403, unrelated validation) must re-throw instead of masquerading as a successful cancel.

**Architecture:** A new predicate module `src/lib/ongoing/cancel-error-match.ts` exports `isAlreadyCancelledError(err: unknown): boolean`, which compares an `OngoingApiError`'s `status` and normalized body text against a fixture captured from a real Ongoing `DELETE /orders/{orderId}` rejection. The fixture is produced once by a discovery task (Task 1) — Ongoing's REST error-response shape is undocumented (verified below), so the match value cannot be guessed; it must come from a live capture. `cancelOngoingOrderHandler`'s catch block then calls this predicate instead of the current blanket `err.kind === "terminal"` check. Everything else about the step (input/output shape, retryable re-throw, logging on failure) is unchanged. `src/lib/ongoing/client.ts` needs no change: it correctly classifies every non-429 4xx as `kind: "terminal"` already — narrowing which *subset* of "terminal" is safe to swallow is entirely the step's job, matching the existing division of labor ("the workflow step, not the client, decides what to swallow" — `docs/superpowers/plans/2026-06-28-cancelongoingorder-28.md:68`).

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework/workflows-sdk`), TypeScript 5.6 (Node16 module resolution, `resolveJsonModule: true` in `tsconfig.json:18`), yarn 4.6, Jest + `@swc/jest` for unit tests, `ts-node` (swc mode, `tsconfig.json:22-24`) for the one-off discovery script.

## Global Constraints

- Medusa version floor: **2.16.0**. Package manager: **yarn 4.6.0**. Node **>= 20**.
- TDD: a **failing Jest unit test** comes before each piece of new business logic (the predicate, the step's narrowed catch branch). The discovery script in Task 1 is scaffolding/tooling, not business logic — it is verified by running it, not by a Jest test, per `docs/superpowers/process.md`'s TDD exemption for scripts.
- `OngoingApiError.kind` classification (`retryable` | `terminal`) in `src/lib/ongoing/errors.ts:3-8, 15-17` is unchanged by this plan — do not touch `classifyHttpStatus` or `classifyError`.
- Do not modify `src/lib/ongoing/client.ts` or its tests (`src/lib/ongoing/__tests__/client.cancel.test.ts`) — the client's job (classify status → `kind`) is already correct and out of scope; only the step's swallow decision narrows.
- For any standalone TypeScript check, use `node_modules/.bin/tsc --noEmit` rather than `npx tsc` — in this repo's sandbox `npx tsc` has been observed to silently no-op instead of erroring. `yarn build` (which runs `medusa plugin:build`, not raw `tsc`) is the reliable end-to-end compile check and is used in Task 2's verification.
- Workflow composition rules (no async/arrow/conditionals/try-catch in `createWorkflow` bodies) do **not** apply here: `cancelOngoingOrderHandler` is a step *handler* (already `async`, already uses `try/catch` at `cancel-ongoing-order.ts:23-41`), not the workflow composition function in `src/workflows/cancel-ongoing-order.ts`. This plan does not touch the workflow composition file.

---

## Background — verified facts the implementer must not re-derive

- **Current swallow logic** (`src/workflows/steps/cancel-ongoing-order.ts:29-36`): `if (err instanceof OngoingApiError && err.kind === "terminal")` → swallow as `{ cancelled: false, swallowed: true }`. `err.kind === "terminal"` is true for **every** non-429 4xx (`classifyHttpStatus`, `src/lib/ongoing/errors.ts:3-8`: only `429` and `>= 500` are `"retryable"`; everything else, including `400/401/403/404/422`, is `"terminal"`). This means a 401 (bad credentials) or 403 (forbidden) is **already** silently swallowed today, not just an unrelated 400 — the issue's "malformed order id, permissions issue, contract violation" examples are all currently mis-handled, confirming the 401/403 test case the task requires.
- **Where the error body lives:** `OngoingClient`'s `doFetch` (`src/lib/ongoing/client.ts:59-85`) reads the response text, JSON-parses it (`safeJson`), and throws `new OngoingApiError(`Ongoing ${method} ${path} failed (${res.status})`, { status: res.status, kind, body: parsed })` (`client.ts:76-81`). The synthetic `err.message` string (`"Ongoing DELETE /orders/999 failed (400)"`) never contains Ongoing's own error text — only `err.body` (the raw parsed response JSON, shape unknown) does. Any match predicate must inspect `err.body`, not `err.message`.
- **Ongoing's REST error-response shape is undocumented.** Verified by fetching `https://developer.ongoingwarehouse.com/REST/v1/openapi.json?version=57`: the `DELETE /api/v1/orders/{orderId}` operation (`operationId: Orders_Delete`) documents only a `200` response (`components.schemas.PostOrderResponse = { orderId: int32?, message: string? }`); there is no 4xx/error schema anywhere in `components.schemas`, and no `4XX`/`default` response entry on `Orders_Delete`. The webshop-flow doc's "Canceling orders and purchase orders" page (`https://developer.ongoingwarehouse.com/canceling-orders-and-inorders`) only describes the older SOAP `ProcessOrder`/`OrderOperation: Remove` flow and its `Success` boolean — it does not describe the REST `DELETE` error body at all. **The exact "already cancelled" message text cannot be sourced from docs or code — it must be captured from a live Ongoing account.** This is why Task 1 is a live-capture discovery task, not a guess.
- **`retry-failed-syncs` does not currently handle cancel-workflow failures.** `src/jobs/retry-failed-syncs.ts:164-167` only queries rows with `sync_state: "error", error_class: "retryable"`; those rows are written exclusively by the push/edit pipeline (`src/workflows/steps/push-order-record-sync.ts:45,66,82,101` and `src/workflows/steps/upsert-ongoing-order-edit.ts:82,99`). `src/workflows/cancel-ongoing-order.ts:17-39` has **no** step that writes `error_class`/`sync_state: "error"` on failure — when `cancelOngoingOrderStep` re-throws, the workflow simply fails with no compensation and no row write. The re-thrown error instead surfaces at the two call sites:
  - `src/providers/ongoing-fulfillment/service.ts:280-286`: the `retryable`-or-now-narrowed-terminal error propagates out of `cancelFulfillment`, so Medusa's core fulfillment-cancel path sees the throw and does **not** mark the fulfillment cancelled (comment at `service.ts:228-230` already documents this as the intended behavior for "genuine retryable failures").
  - `src/subscribers/order-canceled.ts:84-94`: the per-row `try/catch` logs `` `[ongoing] order.canceled: cancelOngoingOrderWorkflow failed for ${...}` `` and continues to the next row — the subscriber never throws further and there is no automatic retry for this path today.
  This plan does not change that propagation architecture; it only changes which errors get to it. A future issue may wire cancel-workflow failures into `error_class`/`retry-failed-syncs` — out of scope here.
- **Why under-capturing failure modes in Task 1 is safe:** the fix is exact-match-or-re-throw. The discovery task only needs to capture the literal already-cancelled shape (produced by DELETE-ing the same order twice — safe and reproducible in any sandbox). Any *other* terminal 4xx Ongoing might return (bad id, forbidden, "warehouse already started picking" if that also reaches this endpoint) automatically falls into the re-throw bucket by construction, without needing to be separately reproduced. Under-capturing can only make the swallow *narrower* than necessary (a safe failure mode — a legitimate already-cancelled variant would incorrectly surface as an error instead of a no-op, which is loud and fixable) — never wider (never a silent false success).
- **Prior plan scope:** `docs/superpowers/plans/2026-06-28-cancelongoingorder-28.md` built this step originally (Task 3, `2026-06-28-cancelongoingorder-28.md:430-546`) and its blanket-terminal-swallow test (`2026-06-28-cancelongoingorder-28.md:472-481`). This plan supersedes only that swallow-key logic; the rest of the step (input/output types, retryable re-throw, no compensation) is unchanged and reused as-is.
- **Related issue #109** (provider-layer fix — `cancelFulfillment` must throw instead of silently returning `{ canceled: false }` when `decideOngoingCancelStep` decides not to cancel) targets `src/providers/ongoing-fulfillment/service.ts:265,284`, a different code path (the *decision* not to attempt a DELETE at all) from this issue (the *DELETE's error response* being over-swallowed). They land independently, but both are needed: #109 stops a false success when Ongoing is never even asked to cancel; #111 (this plan) stops a false success when Ongoing *is* asked and rejects for a reason other than already-being-cancelled.

---

## File Structure

**Create:**
- `scripts/probe-ongoing-cancel-error.ts` — one-off, human-run discovery script; DELETEs a live Ongoing order twice and captures the second (error) response.
- `src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json` — the literal `{ status, body }` Ongoing returned, captured by running the script above against a real/sandbox Ongoing account (Task 1 deliverable; committed once populated).
- `src/lib/ongoing/cancel-error-match.ts` — `isAlreadyCancelledError(err: unknown): boolean`.
- `src/lib/ongoing/__tests__/cancel-error-match.test.ts`.

**Modify:**
- `src/workflows/steps/cancel-ongoing-order.ts` — swap the blanket `err.kind === "terminal"` check for `isAlreadyCancelledError(err)`.
- `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts` — replace the blanket-swallow test with a fixture-driven match test, add unrelated-400, 401/403, and keep the existing retryable-503 test.

---

## Task 1: Discovery — capture Ongoing's real "already cancelled" DELETE error shape

**Files:**
- Create: `scripts/probe-ongoing-cancel-error.ts`
- Create (populated by running the script against a live/sandbox Ongoing account): `src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json`

**Interfaces:**
- Consumes: `OngoingClient` (`src/lib/ongoing/client.ts`), `OngoingApiError` (`src/lib/ongoing/errors.ts`).
- Produces: a committed fixture file `{ status: number; body: unknown }` — Task 2 imports this directly, no other task reads from this one.

This task has two parts. Part A (below) is fully agent-doable and verifiable now with no network access. Part B requires a human with access to a real or sandbox Ongoing goods-owner account and **must complete before Task 2 can start** — Task 2 is blocked by this task's fixture existing and being non-empty.

- [ ] **Step 1: Write the probe script**

Create `scripts/probe-ongoing-cancel-error.ts`:
```ts
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { OngoingClient } from "../src/lib/ongoing/client"
import { OngoingApiError } from "../src/lib/ongoing/errors"

const USAGE =
  "Usage: ONGOING_BASE_URL=... ONGOING_USERNAME=... ONGOING_PASSWORD=... ONGOING_GOODS_OWNER_ID=... " +
  "npx ts-node scripts/probe-ongoing-cancel-error.ts <ongoingOrderId>\n\n" +
  "Captures the raw error Ongoing's REST API returns for DELETE /orders/{orderId} when the order " +
  "cannot be cancelled because it is already cancelled, and writes it to " +
  "src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json.\n\n" +
  "<ongoingOrderId> must be a real order in a live or sandbox Ongoing goods-owner account that has " +
  "ALREADY been cancelled once (run this script against it a first time to cancel it, then run it a " +
  "second time against the SAME order id — the second run is the one that captures the error)."

const REQUIRED_ENV_VARS = [
  "ONGOING_BASE_URL",
  "ONGOING_USERNAME",
  "ONGOING_PASSWORD",
  "ONGOING_GOODS_OWNER_ID",
] as const

async function main(): Promise<void> {
  const orderIdArg = process.argv[2]
  if (!orderIdArg || Number.isNaN(Number(orderIdArg))) {
    console.log(USAGE)
    return
  }
  const orderId = Number(orderIdArg)

  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var ${key}. ${USAGE}`)
    }
  }

  const client = new OngoingClient({
    key: "probe",
    baseUrl: process.env.ONGOING_BASE_URL as string,
    username: process.env.ONGOING_USERNAME as string,
    password: process.env.ONGOING_PASSWORD as string,
    goodsOwnerId: Number(process.env.ONGOING_GOODS_OWNER_ID),
  })

  try {
    const result = await client.cancelOrder(orderId)
    console.log(
      `DELETE succeeded (no error captured) — order ${orderId} was not yet cancelled:`,
      result
    )
    console.log(
      `Run this script again against the SAME order id (${orderId}) to capture the ` +
        `already-cancelled error shape from the second DELETE.`
    )
    return
  } catch (err) {
    if (!(err instanceof OngoingApiError)) {
      throw err
    }
    const fixture = { status: err.status ?? null, body: err.body ?? null }
    const fixtureDir = join(__dirname, "..", "src", "lib", "ongoing", "__fixtures__")
    mkdirSync(fixtureDir, { recursive: true })
    const fixturePath = join(fixtureDir, "cancel-already-cancelled-response.json")
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n")
    console.log(`Captured Ongoing's cancel-error shape to ${fixturePath}:`)
    console.log(JSON.stringify(fixture, null, 2))
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
```

- [ ] **Step 2: Verify the script runs and prints usage with no args (no network required)**

Run: `npx ts-node scripts/probe-ongoing-cancel-error.ts`
Expected: stdout starts with `Usage: ONGOING_BASE_URL=...`, exit code `0`, no network call attempted.

- [ ] **Step 3: Type-check the script**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no errors (this compiles the whole project including `scripts/probe-ongoing-cancel-error.ts`, since `tsconfig.json`'s `include` is `["**/*", ".medusa/types/*"]`).

- [ ] **Step 4 (REQUIRED HUMAN ACTION — blocks Task 2): capture the live fixture**

A human with access to a real or sandbox Ongoing goods-owner account must:
1. Pick (or create via the existing `putOrder` path / Ongoing admin UI) a disposable test order in that account.
2. Run `ONGOING_BASE_URL=<sandbox base url> ONGOING_USERNAME=<user> ONGOING_PASSWORD=<pass> ONGOING_GOODS_OWNER_ID=<id> npx ts-node scripts/probe-ongoing-cancel-error.ts <orderId>` once — this cancels the order (first DELETE succeeds).
3. Run the exact same command again with the same `<orderId>` — this is the DELETE Ongoing rejects because the order is already cancelled. The script writes `src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json`.
4. Open the written fixture and confirm `body` contains readable error text (a `message`/`Message`/`error`/`Error` string field, or at minimum a non-empty JSON object). If `body` is `null` or an empty object, note this explicitly in the Step 5 commit message — Task 2's predicate then narrows to `err.status === fixture.status && err.body normalizes to the same empty form`, i.e. status-plus-empty-body matching (coarser than message-based matching but still narrower than status-only, since a non-empty unrelated 4xx body would not match).

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-ongoing-cancel-error.ts src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json
git commit -m "chore(ongoing): capture live already-cancelled DELETE error shape for #111"
```

---

## Task 2: Narrow the swallow to the captured already-cancelled shape

**Blocked by:** Task 1 (`src/lib/ongoing/__fixtures__/cancel-already-cancelled-response.json` must exist and be committed).

**Files:**
- Create: `src/lib/ongoing/cancel-error-match.ts`
- Create: `src/lib/ongoing/__tests__/cancel-error-match.test.ts`
- Modify: `src/workflows/steps/cancel-ongoing-order.ts`
- Modify: `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`

**Interfaces:**
- Consumes: `OngoingApiError` (`src/lib/ongoing/errors.ts`), the fixture from Task 1.
- Produces: `export function isAlreadyCancelledError(err: unknown): boolean` from `src/lib/ongoing/cancel-error-match.ts` — used by `cancel-ongoing-order.ts`'s catch block.

- [ ] **Step 1: Write the failing test for the predicate**

Create `src/lib/ongoing/__tests__/cancel-error-match.test.ts`:
```ts
import { isAlreadyCancelledError } from "../cancel-error-match"
import { OngoingApiError } from "../errors"
import fixture from "../__fixtures__/cancel-already-cancelled-response.json"

describe("isAlreadyCancelledError", () => {
  it("matches the shape captured from a live Ongoing DELETE rejection (#111 fixture)", () => {
    const err = new OngoingApiError("Ongoing DELETE /orders/1 failed (already cancelled)", {
      status: fixture.status,
      kind: "terminal",
      body: fixture.body,
    })
    expect(isAlreadyCancelledError(err)).toBe(true)
  })

  it("matches even when the message embeds a different order id/number", () => {
    const bodyText = JSON.stringify(fixture.body)
    const swapped = JSON.parse(bodyText.replace(/\d+/g, "424242"))
    const err = new OngoingApiError("Ongoing DELETE /orders/2 failed (already cancelled)", {
      status: fixture.status,
      kind: "terminal",
      body: swapped,
    })
    expect(isAlreadyCancelledError(err)).toBe(true)
  })

  it("does not match an unrelated 4xx with different message text", () => {
    const err = new OngoingApiError("Ongoing DELETE /orders/1 failed", {
      status: fixture.status,
      kind: "terminal",
      body: { message: "Invalid order identifier format" },
    })
    expect(isAlreadyCancelledError(err)).toBe(false)
  })

  it("does not match 401/403 even with a matching-looking body", () => {
    const err401 = new OngoingApiError("unauthorized", {
      status: 401,
      kind: "terminal",
      body: fixture.body,
    })
    const err403 = new OngoingApiError("forbidden", {
      status: 403,
      kind: "terminal",
      body: fixture.body,
    })
    expect(isAlreadyCancelledError(err401)).toBe(false)
    expect(isAlreadyCancelledError(err403)).toBe(false)
  })

  it("does not match a retryable (5xx) error", () => {
    const err = new OngoingApiError("down", {
      status: 503,
      kind: "retryable",
      body: fixture.body,
    })
    expect(isAlreadyCancelledError(err)).toBe(false)
  })

  it("returns false for a non-OngoingApiError", () => {
    expect(isAlreadyCancelledError(new Error("boom"))).toBe(false)
    expect(isAlreadyCancelledError(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/cancel-error-match.test.ts`
Expected: FAIL — cannot find module `../cancel-error-match`.

- [ ] **Step 3: Implement the predicate**

Create `src/lib/ongoing/cancel-error-match.ts`:
```ts
import { OngoingApiError } from "./errors"
import fixture from "./__fixtures__/cancel-already-cancelled-response.json"

/**
 * Normalizes error text for comparison: lowercased, trimmed, and every digit
 * run collapsed to "#" so a message that embeds the order id/number (e.g.
 * "Order 12345 is already cancelled") still matches across different orders.
 */
function normalizeErrorText(text: string): string {
  return text.trim().toLowerCase().replace(/\d+/g, "#")
}

/**
 * Extracts a comparable text signal from an Ongoing error body. Ongoing's
 * REST error-response shape is undocumented (OpenAPI v57's Orders_Delete only
 * documents a 200 response; see #111 plan Background), so this defensively
 * tries the common single-message field names before falling back to the
 * raw stringified body.
 */
function extractErrorText(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>
    const candidate = record.message ?? record.Message ?? record.error ?? record.Error
    if (typeof candidate === "string") {
      return normalizeErrorText(candidate)
    }
  }
  if (typeof body === "string") {
    return normalizeErrorText(body)
  }
  return normalizeErrorText(JSON.stringify(body ?? ""))
}

const ALREADY_CANCELLED_STATUS: number = fixture.status
const ALREADY_CANCELLED_TEXT: string = extractErrorText(fixture.body)

/**
 * Narrow match for Ongoing's specific "already cancelled" DELETE rejection
 * (#111 — residual from CRIT-3). Only this exact shape (status + normalized
 * body text) is treated as idempotent success by cancelOngoingOrderHandler;
 * every other terminal 4xx (bad id, permissions, unrelated validation, 401,
 * 403) falls through and re-throws.
 */
export function isAlreadyCancelledError(err: unknown): boolean {
  if (!(err instanceof OngoingApiError) || err.kind !== "terminal") {
    return false
  }
  if (err.status !== ALREADY_CANCELLED_STATUS) {
    return false
  }
  return extractErrorText(err.body) === ALREADY_CANCELLED_TEXT
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/cancel-error-match.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing test for the step's narrowed catch branch**

Replace the second test ("swallows a terminal 4xx (already cancelled) as idempotent success") in `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts` and add the new cases. Replace the full file content with:
```ts
import { cancelOngoingOrderHandler } from "../cancel-ongoing-order"
import { OngoingApiError } from "../../../lib/ongoing/errors"
import fixture from "../../../lib/ongoing/__fixtures__/cancel-already-cancelled-response.json"

const invoke = (input: any, client: any) => {
  const service = { getClient: jest.fn().mockReturnValue(client) }
  const logger = { info: jest.fn(), error: jest.fn() }
  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  }
  return { result: cancelOngoingOrderHandler(input, { container }), logger }
}

describe("cancelOngoingOrderStep", () => {
  it("calls client.cancelOrder with the ongoing order id", async () => {
    const cancelOrder = jest.fn().mockResolvedValue({ ongoingOrderId: 999 })
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(cancelOrder).toHaveBeenCalledWith(999)
    expect(res.output).toEqual({ cancelled: true, swallowed: false })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: cancelled")
    )
  })

  it("swallows the specific already-cancelled shape as idempotent success", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed", {
        status: fixture.status,
        kind: "terminal",
        body: fixture.body,
      })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    const res = await result
    expect(res.output).toEqual({ cancelled: false, swallowed: true })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already cancelled (matched)")
    )
  })

  it("re-throws an unrelated terminal 4xx instead of swallowing it", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("Ongoing DELETE /orders/999 failed", {
        status: 400,
        kind: "terminal",
        body: { message: "Invalid order identifier format" },
      })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    await expect(result).rejects.toBeInstanceOf(OngoingApiError)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: failed")
    )
  })

  it("re-throws 401/403 instead of swallowing them", async () => {
    const cancelOrder401 = jest.fn().mockRejectedValue(
      new OngoingApiError("unauthorized", { status: 401, kind: "terminal" })
    )
    const { result: result401 } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder: cancelOrder401 }
    )
    await expect(result401).rejects.toBeInstanceOf(OngoingApiError)

    const cancelOrder403 = jest.fn().mockRejectedValue(
      new OngoingApiError("forbidden", { status: 403, kind: "terminal" })
    )
    const { result: result403 } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder: cancelOrder403 }
    )
    await expect(result403).rejects.toBeInstanceOf(OngoingApiError)
  })

  it("re-throws a retryable error (429/5xx) so retryFailedSyncs can re-attempt", async () => {
    const cancelOrder = jest.fn().mockRejectedValue(
      new OngoingApiError("down", { status: 503, kind: "retryable" })
    )
    const { result, logger } = invoke(
      { ongoingOrderId: 999, credentialKey: "wh-a" },
      { cancelOrder }
    )
    await expect(result).rejects.toBeInstanceOf(OngoingApiError)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cancel-ongoing-order: failed")
    )
  })
})
```

- [ ] **Step 6: Run it to verify the new/changed tests fail**

Run: `yarn test src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`
Expected: FAIL — the "swallows the specific already-cancelled shape" test fails because the handler still swallows on `err.kind === "terminal"` alone (so it currently passes for the wrong reason), and the "re-throws an unrelated terminal 4xx" / "re-throws 401/403" tests fail because the handler currently swallows those too (no rejection observed).

- [ ] **Step 7: Narrow the step's catch branch**

In `src/workflows/steps/cancel-ongoing-order.ts`, change the import on line 3 from:
```ts
import { OngoingApiError } from "../../lib/ongoing/errors"
```
to:
```ts
import { isAlreadyCancelledError } from "../../lib/ongoing/cancel-error-match"
```
Then replace the catch block (lines 29-36):
```ts
    if (err instanceof OngoingApiError && err.kind === "terminal") {
      // 4xx — Ongoing already cancelled / cannot cancel: idempotent success.
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled/terminal ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
```
with:
```ts
    if (isAlreadyCancelledError(err)) {
      // Narrowed match on Ongoing's specific "already cancelled" DELETE
      // rejection (#111) — NOT any terminal 4xx. Any other 4xx (bad id,
      // permissions, unrelated validation) falls through and re-throws below.
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled (matched) ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
```
The full resulting file:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { isAlreadyCancelledError } from "../../lib/ongoing/cancel-error-match"

export type CancelStepInput = {
  ongoingOrderId: number
  credentialKey: string
}

export type CancelStepResult = {
  cancelled: boolean
  swallowed: boolean
}

export const cancelOngoingOrderHandler = async (
  input: CancelStepInput,
  { container }: { container: any }
): Promise<StepResponse<CancelStepResult>> => {
  const ongoing = container.resolve("ongoing") as any
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const client = ongoing.getClient(input.credentialKey)

  try {
    await client.cancelOrder(input.ongoingOrderId)
    logger.info(
      `[ongoing] cancel-ongoing-order: cancelled ongoing_order_id=${input.ongoingOrderId}`
    )
    return new StepResponse({ cancelled: true, swallowed: false })
  } catch (err) {
    if (isAlreadyCancelledError(err)) {
      // Narrowed match on Ongoing's specific "already cancelled" DELETE
      // rejection (#111) — NOT any terminal 4xx. Any other 4xx (bad id,
      // permissions, unrelated validation) falls through and re-throws below.
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled (matched) ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
    logger.error(
      `[ongoing] cancel-ongoing-order: failed ongoing_order_id=${input.ongoingOrderId} error=${(err as Error).message}`
    )
    throw err
  }
}

export const cancelOngoingOrderStep = createStep(
  "cancel-ongoing-order",
  cancelOngoingOrderHandler
)
```

- [ ] **Step 8: Run the step test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Run the full test suite**

Run: `yarn test`
Expected: all suites PASS, including `src/lib/ongoing/__tests__/cancel-error-match.test.ts`, `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`, and every pre-existing suite (in particular `src/lib/ongoing/__tests__/client.cancel.test.ts` and `src/workflows/__tests__/push-order-to-ongoing.test.ts` / `src/workflows/__tests__/sync-order-edit-to-ongoing.test.ts` — unaffected by this change).

- [ ] **Step 10: Lint and build**

Run: `yarn lint`
Expected: no errors.

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output under `.medusa/server`.

- [ ] **Step 11: Commit**

```bash
git add src/lib/ongoing/cancel-error-match.ts src/lib/ongoing/__tests__/cancel-error-match.test.ts src/workflows/steps/cancel-ongoing-order.ts src/workflows/steps/__tests__/cancel-ongoing-order.test.ts
git commit -m "fix(ongoing): narrow cancel-step terminal-error swallow to the already-cancelled shape (#111)"
```

---

## Self-Review (completed during planning)

- **Issue #111 coverage:**
  - Narrow the swallow to the specific "already cancelled" shape, not any terminal 4xx → `isAlreadyCancelledError` (Task 2 Step 3) checks status + normalized body text, consumed by the step's catch block (Task 2 Step 7) ✓
  - Exact match predicate specified, not guessed → sourced from a live-captured fixture (Task 1), compared via exact (order-id-normalized) text equality, not a hand-picked regex ✓
  - Non-matching terminal 4xx re-throws and is classified → unchanged `throw err` fallthrough (`cancel-ongoing-order.ts` catch block); `err.kind` classification is untouched (`errors.ts:3-8`); Background section documents precisely how a re-thrown error actually surfaces today (`cancelFulfillment` propagation / subscriber log-and-continue), correcting the issue body's looser "surfaces via retry-failed-syncs" framing with the verified reality ✓
  - 401/403 re-thrown → explicit test in Task 2 Step 5, previously-undetected bug (401/403 were already silently swallowed under the old blanket check) called out in Background ✓
  - 5xx retryable retried → unchanged, existing test kept and re-verified in Task 2 Step 5 ✓
  - Interaction with #109 noted → Background bullet distinguishes the two code paths and states both are needed ✓
  - Discovery-not-guess requirement → Task 1 is a live-capture discovery task, blocking Task 2 ✓
- **Placeholder scan:** every step shows complete code; the only forward-reference is Task 2 depending on Task 1's fixture file, which is the explicitly-sanctioned discovery-gate pattern (the fixture's *path* and *shape* are concrete; only its *content* is captured live) — no unresolved marker text and no vague "handle it" phrasing anywhere, and no task's code repeats another task's code by cross-reference instead of showing it inline ✓
- **Type consistency:** `CancelStepInput`/`CancelStepResult` (unchanged from the original step) match across Task 2's test and implementation; `isAlreadyCancelledError(err: unknown): boolean` produced in Task 2 Step 3 matches its only call site in Task 2 Step 7; the fixture's `{ status: number; body: unknown }` shape (Task 1 Step 1's `writeFileSync` call) matches what Task 2's predicate and tests read ✓

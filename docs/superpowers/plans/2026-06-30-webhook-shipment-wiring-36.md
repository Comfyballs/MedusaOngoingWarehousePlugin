# Webhook → syncOngoingShipment Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the verified, in-band Ongoing webhook payload (delivered by issue #35's authenticated route) into the idempotent `syncOngoingShipmentWorkflow` (delivered by issue #33), so a "shipped" webhook applies tracking + marks the Medusa fulfillment shipped exactly once.

**Architecture:** This issue does **not** create the route, the verifier, or the workflow. Issue #35 builds the authenticated `POST /ongoing/webhooks/:credentialKey` route and extracts its in-band branch (the point reached only after token auth, goods-owner cross-check, payload parse, integration resolution, and the `shipped_status_codes` gate all pass) into a seam module, `dispatch-shipment.ts`, exporting `dispatchVerifiedShipment(scope, verified)` as a no-op stub the route already `await`s. Issue #33 builds `syncOngoingShipmentWorkflow`. This issue fills #35's seam by writing the body of `dispatchVerifiedShipment`: a pure function maps the verified webhook payload to the workflow's input, and the seam invokes the workflow via the passed container scope, swallowing workflow errors so the route always returns `200`. **The route file itself is not edited by #36.**

**Tech Stack:** Medusa v2 (2.16.0) file-based API routes (`MedusaRequest`/`MedusaResponse`), workflows-sdk factory `workflow(scope).run({ input })`, Jest 29 + `@swc/jest`, TypeScript (Node16 module resolution).

## Global Constraints

- Medusa pinned to **2.16.0**; Node **>= 20**; package manager **yarn 4.6.0** — never bump.
- **Mutations live in workflows, never in route handlers or the seam.** `dispatchVerifiedShipment` only *invokes* `syncOngoingShipmentWorkflow`; it performs no DB writes and no shipment logic itself. The Medusa-side shipment (`createOrderShipmentWorkflow`, `no_notification: false`) lives **inside #33's apply step**, not here.
- **Invoke a workflow from the seam with the passed scope:** `await someWorkflow(scope).run({ input })` — the same DI factory pattern subscribers use with `container` (see `src/subscribers/order-canceled.ts:64`); here the container is the `scope` the route forwards from `req.scope`.
- **Ongoing has no HMAC** — auth is a static `X-Auth-Token` compared against `webhookSecret`. That verification is #35's job; this issue runs strictly *after* it, inside the seam the route invokes only on the verified in-band path.
- **Always return `200` to Ongoing once auth passes.** Ongoing floods retries on any non-2xx response. A workflow failure must be logged and swallowed; the request still returns `200`. The workflow's `OngoingOrderSync.shipped_at` idempotency guard (spec §6, §7) makes a later Ongoing retry safe.
- Errors that must be surfaced to operators are recorded by the workflow on `OngoingOrderSync` (`sync_state`, `error_class`, `last_error`); the route only logs.
- Logger is resolved with `ContainerRegistrationKeys.LOGGER` (value `"logger"`) from `@medusajs/framework/utils`.
- Tests are `*.test.ts` under a `__tests__/` dir, transformed by `@swc/jest` (`jest.config.js`); run with `yarn test`.

---

## Dependency seam (read before starting)

This plan is written against fixed contracts for two sibling issues planned in the same run. The implementer of #36 executes **after** #35 and #33 have landed (this issue is blocked-by #35 and depends on #33), so their real code is on disk when these tasks run. The contracts below are what #36 builds on:

**From #35 — the route at `src/api/ongoing/webhooks/[credentialKey]/route.ts` and its seam module `dispatch-shipment.ts`:**
- The route exports an `async POST(req: MedusaRequest, res: MedusaResponse)` handler.
- It verifies `X-Auth-Token` against the integration's `webhookSecret`, cross-checks `goodsOwnerId`, parses the body into a `WebhookOrderPayload`, resolves the `OngoingIntegration` for `credential_key = req.params.credentialKey` (for `shipped_status_codes`), and gates on `payload.orderStatus.number ∈ shipped_status_codes`.
- It returns a uniform `401` for unknown key / bad token, and `200` otherwise.
- #35 extracts the in-band branch into a **seam module**: `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts` exports `async function dispatchVerifiedShipment(scope, verified: VerifiedShipmentWebhook)` where `VerifiedShipmentWebhook = { payload, integrationId, credentialKey }`. #35 ships it as a **no-op stub** (a single `logger.debug` line) and the route's in-band branch already calls `await dispatchVerifiedShipment(req.scope, verified)` immediately before returning `200`. **#36 fills the body of `dispatchVerifiedShipment` only** — the route, its auth, its credential/integration resolution, and #35's `route.test.ts` are untouched.
- The verified-payload shape this issue consumes (a structural subset of #35's `WebhookOrderPayload`, matching its optionality): `payload.goodsOwnerOrderId?: string`, `payload.orderStatus.number: number`, and an optional `payload.tracking?: Array<{ trackingUrl?: string; waybill?: string; isReturn?: boolean }>`.

**From #33 — exported from `src/workflows` (`src/workflows/index.ts`):**
- `syncOngoingShipmentWorkflow` — a workflow factory: `syncOngoingShipmentWorkflow(scope).run({ input })`.
- `SyncOngoingShipmentInput` — the input type: `{ ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] }`. (#33's plan co-exports this type from `src/workflows/index.ts`, matching the existing co-export pattern for `PushOrderToOngoingInput`, `SyncOrderEditResult`, etc.)

**Payload → input mapping owned by this issue:**
- `ongoing_order_number = payload.goodsOwnerOrderId ?? ""` — Ongoing's "external order identifier" is the client ref we set as `orderNumber` when pushing the order, i.e. our `ongoing_order_number`. #35's field is optional; a missing value coalesces to `""`, which #33's `loadSyncForShipmentStep` resolves to `no_sync_row` (a safe no-op), consistent with the always-200, downstream-idempotent contract.
- `status_code = payload.orderStatus.number`.
- `tracking_numbers = (payload.tracking ?? []).filter(t => !t.isReturn).map(t => t.waybill ?? "")` — exclude return parcels; `waybill` is the carrier tracking number, coalesced to `""` when absent (it is optional in #35's type).
- `status_text = ''` — **known gap, documented intentionally:** the Ongoing webhook payload carries no human-readable status text. The poll job (#34) supplies real status text; `syncOngoingShipmentWorkflow` tolerates an empty `status_text`. We pass `''` here rather than fabricating text. Do not invent a value.

**Why two tasks:** the mapping is a pure, exhaustively-testable function (Task 1) kept separate from the side-effecting seam fill (Task 2 — the body of `dispatchVerifiedShipment` in `dispatch-shipment.ts`), mirroring the codebase's split between pure deciders/mappers (e.g. `src/workflows/steps/decide-ongoing-cancel.ts`, `src/lib/ongoing/order-mapper.ts`) and the handlers/subscribers that call them.

---

## File Structure

- `src/api/ongoing/webhooks/[credentialKey]/map-payload-to-shipment-input.ts` — **new.** Pure function `mapWebhookPayloadToShipmentInput`. One responsibility: derive `SyncOngoingShipmentInput` from the verified webhook payload. No I/O.
- `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts` — **modified (#35's stub).** #35 ships this file exporting `async function dispatchVerifiedShipment(scope, verified: VerifiedShipmentWebhook)` as a no-op stub (where `VerifiedShipmentWebhook = { payload, integrationId, credentialKey }`). #36 fills its body: build the input via the mapper, invoke `syncOngoingShipmentWorkflow(scope).run({ input })` in a try/catch that logs and swallows errors. **`route.ts` is NOT touched by #36** — #35's route already calls `await dispatchVerifiedShipment(req.scope, verified)` and stays byte-for-byte as #35 left it; #35's `route.test.ts` keeps passing untouched.
- `src/api/ongoing/webhooks/[credentialKey]/__tests__/map-payload-to-shipment-input.test.ts` — **new.** Unit tests for the pure mapper.
- `src/api/ongoing/webhooks/[credentialKey]/__tests__/dispatch-shipment.test.ts` — **new.** Tests `dispatchVerifiedShipment` directly with a mocked `syncOngoingShipmentWorkflow` (no route, no auth/credential/integration re-derivation).

Relative-import reference (Node16, explicit paths):
- `dispatch-shipment.ts` and `map-payload-to-shipment-input.ts` sit in the same `[credentialKey]/` directory; from `dispatch-shipment.ts` the mapper is `./map-payload-to-shipment-input` and `src/workflows` is `../../../../workflows` (both unchanged from #35's stub depth).
- From `[credentialKey]/__tests__/*.test.ts` → `src/workflows` is `../../../../../workflows`; the mapper under test is `../map-payload-to-shipment-input`, and the dispatch seam under test is `../dispatch-shipment`.

---

### Task 1: Pure webhook-payload → shipment-input mapper

**Files:**
- Create: `src/api/ongoing/webhooks/[credentialKey]/map-payload-to-shipment-input.ts`
- Test: `src/api/ongoing/webhooks/[credentialKey]/__tests__/map-payload-to-shipment-input.test.ts`

**Interfaces:**
- Consumes (from #33, via `src/workflows`): `type SyncOngoingShipmentInput = { ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] }`.
- Produces (for the dispatch seam): a structural source type and the mapper:
  ```ts
  export type WebhookShipmentSource = {
    goodsOwnerOrderId?: string
    orderStatus: { number: number }
    tracking?: Array<{ waybill?: string; isReturn?: boolean }>
  }
  export function mapWebhookPayloadToShipmentInput(
    payload: WebhookShipmentSource
  ): SyncOngoingShipmentInput
  ```
  The structural `WebhookShipmentSource` **mirrors the optionality of #35's real `WebhookOrderPayload`** (`goodsOwnerOrderId?: string`, `tracking?: Array<{ trackingUrl?; waybill?; isReturn? }>`) so the mapper accepts the real payload without a TS2345 assignability error at `yarn build`. It declares exactly the fields consumed, decoupling the mapper from #35's full type. A missing `goodsOwnerOrderId` coalesces to `ongoing_order_number: ""` (see Step 3) — #33's `loadSyncForShipmentStep` resolves `""` to `no_sync_row`, a safe no-op, consistent with the always-200, downstream-idempotent contract.

- [ ] **Step 1: Write the failing test**

Create `src/api/ongoing/webhooks/[credentialKey]/__tests__/map-payload-to-shipment-input.test.ts`:

```ts
import {
  mapWebhookPayloadToShipmentInput,
  type WebhookShipmentSource,
} from "../map-payload-to-shipment-input"

describe("mapWebhookPayloadToShipmentInput", () => {
  it("maps goodsOwnerOrderId, status code, and non-return waybills", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1001-abc",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-1", isReturn: false },
        { waybill: "WB-RET", isReturn: true },
        { waybill: "WB-2", isReturn: false },
      ],
    }

    expect(mapWebhookPayloadToShipmentInput(payload)).toEqual({
      ongoing_order_number: "1001-abc",
      status_code: 200,
      status_text: "",
      tracking_numbers: ["WB-1", "WB-2"],
    })
  })

  it("always sets status_text to '' (webhook payload has no status text)", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1002-def",
      orderStatus: { number: 210 },
    }
    expect(mapWebhookPayloadToShipmentInput(payload).status_text).toBe("")
  })

  it("returns an empty tracking_numbers array when tracking is undefined", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1003-ghi",
      orderStatus: { number: 200 },
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([])
  })

  it("returns an empty tracking_numbers array when every parcel is a return", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1004-jkl",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-RET-1", isReturn: true },
        { waybill: "WB-RET-2", isReturn: true },
      ],
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([])
  })

  it("preserves outbound parcel order", () => {
    const payload: WebhookShipmentSource = {
      goodsOwnerOrderId: "1005-mno",
      orderStatus: { number: 200 },
      tracking: [
        { waybill: "WB-A", isReturn: false },
        { waybill: "WB-B", isReturn: false },
      ],
    }
    expect(mapWebhookPayloadToShipmentInput(payload).tracking_numbers).toEqual([
      "WB-A",
      "WB-B",
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test map-payload-to-shipment-input`
Expected: FAIL — `Cannot find module '../map-payload-to-shipment-input'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/api/ongoing/webhooks/[credentialKey]/map-payload-to-shipment-input.ts`:

```ts
import type { SyncOngoingShipmentInput } from "../../../../workflows"

/**
 * The subset of the verified Ongoing webhook payload (#35's WebhookOrderPayload)
 * that the shipment mapping consumes. Declared structurally so this mapper does
 * not depend on #35's full payload type; field optionality mirrors #35's real
 * type (goodsOwnerOrderId?, tracking[].waybill?, tracking[].isReturn?) so the
 * real payload is assignable without a TS2345 error at build.
 */
export type WebhookShipmentSource = {
  goodsOwnerOrderId?: string
  orderStatus: { number: number }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
}

/**
 * Derive the idempotent shipment-sync input from a verified, in-band ("shipped"
 * status) Ongoing webhook payload.
 *
 * - ongoing_order_number := goodsOwnerOrderId ?? "" (Ongoing's external order id =
 *   the client ref we set as orderNumber when pushing the order). A missing id
 *   yields "", which #33's loadSyncForShipmentStep resolves to no_sync_row — a
 *   safe no-op under the always-200, downstream-idempotent contract.
 * - status_code := orderStatus.number.
 * - tracking_numbers := outbound parcel waybills only (return parcels excluded);
 *   a missing waybill coalesces to "".
 * - status_text := "" — the webhook payload carries no status text; the poll job
 *   (#34) supplies real text and syncOngoingShipmentWorkflow tolerates empty.
 */
export function mapWebhookPayloadToShipmentInput(
  payload: WebhookShipmentSource
): SyncOngoingShipmentInput {
  return {
    ongoing_order_number: payload.goodsOwnerOrderId ?? "",
    status_code: payload.orderStatus.number,
    status_text: "",
    tracking_numbers: (payload.tracking ?? [])
      .filter((parcel) => !parcel.isReturn)
      .map((parcel) => parcel.waybill ?? ""),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test map-payload-to-shipment-input`
Expected: PASS — 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add "src/api/ongoing/webhooks/[credentialKey]/map-payload-to-shipment-input.ts" "src/api/ongoing/webhooks/[credentialKey]/__tests__/map-payload-to-shipment-input.test.ts"
git commit -m "feat(ongoing-webhook): map verified webhook payload to shipment-sync input"
```

---

### Task 2: Fill #35's `dispatchVerifiedShipment` seam to invoke syncOngoingShipmentWorkflow

**Files:**
- Modify: `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts` (#35's no-op stub — fill the `dispatchVerifiedShipment` body)
- Test: `src/api/ongoing/webhooks/[credentialKey]/__tests__/dispatch-shipment.test.ts`

**Interfaces:**
- Consumes (Task 1): `mapWebhookPayloadToShipmentInput(payload)` from `./map-payload-to-shipment-input`.
- Consumes (#33): `syncOngoingShipmentWorkflow` from `../../../../workflows`, invoked as `syncOngoingShipmentWorkflow(scope).run({ input })`.
- Fills (#35): the body of `async function dispatchVerifiedShipment(scope, verified: VerifiedShipmentWebhook)`, where `VerifiedShipmentWebhook = { payload, integrationId, credentialKey }`. No new exports, no signature change. Behavior contract: the workflow is invoked once with the input derived from `verified.payload`; any workflow error is logged via the container LOGGER and swallowed (the function resolves normally so the route's existing `200` always runs). `route.ts` is **not** edited — #35 already `await`s `dispatchVerifiedShipment(req.scope, verified)`.

**Why test the seam directly:** #35 owns the route, its auth, its credential/integration resolution, and `route.test.ts`, and promises "#36 needs only to edit `dispatch-shipment.ts`." So #36's test targets `dispatchVerifiedShipment` directly with a stubbed `syncOngoingShipmentWorkflow` and a minimal `scope` mock — it does **not** re-derive #35's full token/goods-owner/integration verifier (that is #35's tested concern and would be a fragile duplicate). `jest.config.js` has `clearMocks: true`, so mock call counts reset between tests; assertions below assume a clean count per `it`.

- [ ] **Step 1: Write the failing test**

Create `src/api/ongoing/webhooks/[credentialKey]/__tests__/dispatch-shipment.test.ts`:

```ts
// Mock #33's workflow factory: syncOngoingShipmentWorkflow(scope) => { run }.
const run = jest.fn().mockResolvedValue({ result: { applied: true } })
const factory = jest.fn(() => ({ run }))
jest.mock("../../../../../workflows", () => ({
  __esModule: true,
  syncOngoingShipmentWorkflow: factory,
}))

import { dispatchVerifiedShipment } from "../dispatch-shipment"

type Payload = {
  goodsOwnerOrderId?: string
  goodsOwnerId: number
  orderStatus: { number: number; text?: string }
  tracking?: Array<{ waybill?: string; isReturn?: boolean }>
}

const CREDENTIAL_KEY = "wh-a"
const INTEGRATION_ID = "oint_123"
const GOODS_OWNER_ID = 7

const inBandPayload = (): Payload => ({
  goodsOwnerOrderId: "1001-abc",
  goodsOwnerId: GOODS_OWNER_ID,
  orderStatus: { number: 200, text: "Sent" },
  tracking: [
    { waybill: "WB-1", isReturn: false },
    { waybill: "WB-RET", isReturn: true },
    { waybill: "WB-2", isReturn: false },
  ],
})

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

// Minimal container scope: only LOGGER is resolved by dispatchVerifiedShipment.
const makeScope = () =>
  ({
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      return undefined
    }),
  } as unknown as Parameters<typeof dispatchVerifiedShipment>[0])

const makeVerified = (payload: Payload = inBandPayload()) => ({
  payload,
  integrationId: INTEGRATION_ID,
  credentialKey: CREDENTIAL_KEY,
})

describe("dispatchVerifiedShipment -> syncOngoingShipmentWorkflow wiring", () => {
  it("invokes the workflow once with the derived input", async () => {
    const scope = makeScope()

    await dispatchVerifiedShipment(scope, makeVerified())

    expect(factory).toHaveBeenCalledWith(scope)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-abc",
        status_code: 200,
        status_text: "",
        tracking_numbers: ["WB-1", "WB-2"],
      },
    })
  })

  it("swallows and logs a workflow error (Ongoing must not see non-2xx)", async () => {
    run.mockRejectedValueOnce(new Error("ongoing 500"))
    const scope = makeScope()

    await expect(
      dispatchVerifiedShipment(scope, makeVerified())
    ).resolves.toBeUndefined()

    expect(run).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test dispatch-shipment`
Expected: FAIL — the workflow is never invoked (`run` has 0 calls), because #35's `dispatchVerifiedShipment` is still a no-op stub.

- [ ] **Step 3: Fill the `dispatchVerifiedShipment` body in `dispatch-shipment.ts`**

Open `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts` (#35's stub). Add these imports alongside #35's existing imports (skip any already present — #35 already imports `ContainerRegistrationKeys` for its stub's `logger.debug`):

```ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncOngoingShipmentWorkflow } from "../../../../workflows"
import { mapWebhookPayloadToShipmentInput } from "./map-payload-to-shipment-input"
```

Replace the stub body (drop its `logger.debug` line) with the workflow invocation, keeping #35's existing `async function dispatchVerifiedShipment(scope, verified: VerifiedShipmentWebhook)` signature unchanged:

```ts
// Fill #35's seam: hand the verified "shipped" payload to the idempotent
// shipment-sync workflow (#33). Swallow workflow errors so the route still
// returns 200 — Ongoing floods retries on non-2xx, and the workflow's
// shipped_at guard makes a later retry safe.
const input = mapWebhookPayloadToShipmentInput(verified.payload)
try {
  await syncOngoingShipmentWorkflow(scope).run({ input })
} catch (error) {
  scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .error(
      `[ongoing] webhook: syncOngoingShipmentWorkflow failed for ${input.ongoing_order_number}: ${
        (error as Error).message
      }`
    )
}
```

`route.ts` stays byte-for-byte as #35 left it (it already `await`s `dispatchVerifiedShipment(req.scope, verified)` before its `200`), so #35's `route.test.ts` keeps passing.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test dispatch-shipment`
Expected: PASS — 2 passing tests.

- [ ] **Step 5: Run the full webhook suite**

Run: `yarn test src/api/ongoing/webhooks/`
Expected: PASS — Task 1's mapper tests, this task's seam tests, and #35's existing `route.test.ts` all green (`route.ts` is untouched, and the filled seam runs only on the verified in-band path, so #35's auth/gate tests are unaffected).

- [ ] **Step 6: Commit**

```bash
git add "src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts" "src/api/ongoing/webhooks/[credentialKey]/__tests__/dispatch-shipment.test.ts"
git commit -m "feat(ongoing-webhook): invoke syncOngoingShipmentWorkflow from verified webhook (#36)"
```

---

## Final Verification

Run all four and confirm clean output before considering the issue done (superpowers:verification-before-completion — paste the real output, do not assert from memory):

- [ ] `yarn lint` — no errors.
- [ ] `yarn build` — `medusa plugin:build` compiles `src/` to `.medusa/server` with no TypeScript errors (this is where the `SyncOngoingShipmentInput` and `syncOngoingShipmentWorkflow` imports from #33 are type-checked across the seam).
- [ ] `yarn test src/api/ongoing/webhooks/` — the webhook suite is green.
- [ ] `yarn test` — the full suite is green (filling the seam must not regress #35's `route.test.ts` or any other suite; `route.ts` is untouched).

## Self-Review (completed during planning)

- **Spec coverage (§7):** "Webhook route … calls the same `syncOngoingShipment`" and "both paths converge on the idempotent `syncOngoingShipment`, guarded by `OngoingOrderSync.shipped_at`" — Task 2 fills `dispatchVerifiedShipment` to invoke `syncOngoingShipmentWorkflow`; idempotency is the workflow's (#33's) responsibility, relied on here to justify swallowing errors and returning `200`. Auth/gate (§7) belongs to #35. The `status_text = ''` gap (poll job #34 supplies real text) is documented in the Dependency seam and in the mapper's doc comment.
- **Seam conformance (#35):** #36 edits only `dispatch-shipment.ts` (filling the stub body) and adds two test files; it does not touch `route.ts`, its auth, or `route.test.ts` — matching #35's promise "#36 needs only to edit `dispatch-shipment.ts`." The seam test stubs `syncOngoingShipmentWorkflow` and calls `dispatchVerifiedShipment` directly, so it does not re-derive #35's verifier.
- **Placeholder scan:** no deferral markers (TODO/TBD/FIXME) or "handle later" stubs anywhere; the stub being filled is #35's, not a #36 deferral.
- **Type consistency:** `mapWebhookPayloadToShipmentInput` returns `SyncOngoingShipmentInput` (`{ ongoing_order_number; status_code; status_text; tracking_numbers }`) in both tasks; its `WebhookShipmentSource` mirrors #35's optional `goodsOwnerOrderId?`, `waybill?`, `isReturn?` so the real `WebhookOrderPayload` is assignable at `yarn build` (no TS2345), with `?? ""` coalescing; the seam invokes `syncOngoingShipmentWorkflow(scope).run({ input })` consistently; import depths (`../../../../workflows` and `./map-payload-to-shipment-input` from `dispatch-shipment.ts`/mapper, `../../../../../workflows` and `../dispatch-shipment` from tests) are verified against the `src/api/ongoing/webhooks/[credentialKey]/` path.

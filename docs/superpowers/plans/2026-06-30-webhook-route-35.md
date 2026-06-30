# Ongoing Webhook Route Implementation Plan (#35)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Business-logic tasks follow superpowers:test-driven-development — the failing test is written and run-to-fail **before** the implementation.

**Goal:** Add the public `POST /ongoing/webhooks/:credentialKey` route that authenticates an inbound Ongoing webhook, parses and validates the order payload, gates on `shipped_status_codes`, and acknowledges with `200` / a uniform `401` / `400`. The actual shipment-sync workflow invocation is **issue #36's job**; this route stops at a single, clearly-labeled extension seam (`dispatchVerifiedShipment`) that #36 fills.

---

## CRITICAL: spec correction — Ongoing does NOT HMAC-sign webhooks

The spec (§7, lines 219-223) and issue #35's title both say the webhook is authenticated by an **"HMAC signature over the body"**. **This is wrong and this plan deliberately does not implement it.** Stage-6 research against the live Ongoing Warehouse integration confirmed Ongoing offers only these webhook auth schemes: **None, HTTP Basic, a static `X-Auth-Token` header, and mTLS** — it never computes an HMAC of the body.

This plan therefore authenticates by a **timing-safe comparison of the inbound `X-Auth-Token` header against the integration's `webhookSecret`** (the optional field already present on `OngoingCredentials`, `src/lib/ongoing/types.ts:7`).

Consequences of the correction, baked into this plan:
- **No raw-body capture and no HMAC computation.** Medusa's default JSON body parser (`req.body`) is sufficient. **Do NOT add `src/api/middlewares.ts`** and do **not** touch `preserveRawBody` — none is needed.
- The spec is **immutable** (per `docs/superpowers/process.md` — "ADRs are immutable", durable docs own content but decisions are not edited in place). **Do not edit the spec file.** This correction lives here in the plan; a follow-up ADR superseding the §7 "HMAC" framing may be opened separately, but is out of scope for #35.

---

**Architecture:** A single Medusa file-based route at `src/api/ongoing/webhooks/[credentialKey]/route.ts` exporting `export async function POST(req, res)`. Because the path is outside `/admin` and `/store`, it is a **public** endpoint — **no `AUTHENTICATE` export** is needed (Medusa only auto-protects the admin/store namespaces). The handler:

1. Resolves the `ongoing` module service from `req.scope` and reads `req.params.credentialKey`.
2. **Authenticates (uniform `401`)** in this order, with no distinguishing messages or warehouse enumeration: unknown `credentialKey` → missing `webhookSecret` → `X-Auth-Token` mismatch → (after parsing) `goodsOwnerId` mismatch.
3. **Parses + validates** the JSON body into `WebhookOrderPayload`; an unparseable/malformed body returns `400` (only after auth passes).
4. **Status-gates:** if `payload.orderStatus.number` is not in the integration's `shipped_status_codes`, acknowledges `200` with a debug log and does nothing (Ongoing retries on non-2xx, so `200` is the correct "received, no action" ack).
5. **In-band:** calls the `dispatchVerifiedShipment` seam (a no-op stub in #35, owned by #36) and acknowledges `200`.

The handler logic ships as the exported `POST` function so it is unit-testable directly with a mocked `req.scope` (the same named-handler discipline as `src/subscribers/order-canceled.ts`). The #36 seam lives in its **own module** (`./dispatch-shipment`) so tests can `jest.mock` it and #36 can replace its body without touching the route.

**Replay protection (locked decision — intentionally minimal):** **No `webhookEventId` dedup store and no timestamp/clock-skew window.** Ongoing retries a failed delivery with the **same `timestamp`** (at 1/5/15/30 min, then every 2h for 24h), so a skew window would reject legitimate retries. Idempotency is owned downstream by `syncOngoingShipment`'s `OngoingOrderSync.shipped_at` guard (spec §7 lines 225-226, §11 "Idempotency"). The route stays stateless.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution, decorators enabled), yarn 4.6, Jest + `@swc/jest` for unit tests (already wired: `jest.config.js`, `package.json` `"test": "jest"`). Node `>= 20` (built-in `crypto.timingSafeEqual`).

## Global Constraints

- Medusa version floor **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Package manager **yarn 4.6.0**, Node **>= 20**.
- Module id is `"ongoing"`; import the constant `ONGOING_MODULE` from `src/modules/ongoing/index.ts` (`ONGOING_MODULE = "ongoing"`, line 5). Resolve the logger via `ContainerRegistrationKeys.LOGGER` (matches `src/subscribers/order-updated.ts:34`).
- **No PUT/PATCH routes** — this is a `POST`-only handler (Medusa rule: mutations are `POST`/`DELETE`).
- Use **`MedusaError`** for thrown errors, never generic `Error` — though this route catches Medusa's thrown `MedusaError` and converts to HTTP status codes rather than re-throwing (a webhook must return a status, not surface a stack).
- **Module isolation:** the route talks to the `ongoing` module only through its resolved service (`getCredentials`, `listOngoingIntegrations`); no cross-module service reach-around and no direct repository access.
- `service.getCredentials(credentialKey)` (`src/modules/ongoing/service.ts:35-44`) is **synchronous** and **throws `MedusaError(INVALID_DATA)`** on an unknown key — wrap it in try/catch and convert to the uniform `401`.
- `shipped_status_codes` is a `model.json()` column (`src/modules/ongoing/models/integration.ts:15`), read off the `OngoingIntegration` row as a `number[]` (may be `null`/absent → treat as empty).
- **Uniform `401`** for every auth failure (unknown key, missing secret, token mismatch, goodsOwnerId mismatch): `res.sendStatus(401)` with a server-side `logger.warn`, never a body that distinguishes the cause.
- Tests are **pure unit tests** (mock the module service, logger, and the `dispatch-shipment` seam); there is no local Postgres/Medusa instance in this plugin.
- Plugin build output is `.medusa/server`; the route must compile under **`yarn build`** and pass **`yarn lint`**.

---

## File Structure

**Create:**
- `src/api/ongoing/webhooks/[credentialKey]/route.ts` — the `POST` handler.
- `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts` — the #36 extension seam (no-op stub in #35).
- `src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts` — unit tests.

**Edit:**
- `src/lib/ongoing/types.ts` — add the `WebhookOrderPayload` type family (and nested types).

**Depends on (already exists):**
- `src/modules/ongoing/index.ts` — `ONGOING_MODULE = "ongoing"`.
- `src/modules/ongoing/service.ts` — `getCredentials(credentialKey): OngoingCredentials` (sync, throws on unknown key); `listOngoingIntegrations(filter)` (auto-CRUD).
- `src/modules/ongoing/models/integration.ts` — `credential_key`, `shipped_status_codes` (json).
- `src/lib/ongoing/types.ts` — `OngoingCredentials` with optional `webhookSecret`.

---

## Task 1: Webhook payload types + the #36 dispatch seam (scaffolding)

Type additions and a no-op seam stub are **pure scaffolding with no business logic**, so they are exempt from TDD (per `docs/superpowers/process.md` workflow spine). They are verified by `yarn lint` + `yarn build`, and exercised by Task 2's tests.

**Files:**
- Edit: `src/lib/ongoing/types.ts`
- Create: `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts`

- [ ] **Step 1: Add the `WebhookOrderPayload` types**

Append to `src/lib/ongoing/types.ts` (these mirror the verified Ongoing webhook order shape; `timestamp` is ISO-8601 with 7 fractional digits, kept as a string):
```ts
// --- Inbound webhook payload (Ongoing -> POST /ongoing/webhooks/:credentialKey) ---
// Auth is a static X-Auth-Token header compared against webhookSecret (NOT HMAC;
// see plan 2026-06-30-webhook-route-35.md). These fields are the subset the route
// parses/validates and that #36's syncOngoingShipment consumes.

export interface WebhookOrderStatus {
  number: number
  text?: string
}

export interface WebhookOrderTracking {
  trackingUrl?: string
  waybill?: string
  isReturn?: boolean
}

export interface WebhookOrderParcelTracking {
  trackingUrl?: string
}

export interface WebhookOrderParcel {
  id?: number
  parcelNumber?: string
  isReturnParcel?: boolean
  tracking?: WebhookOrderParcelTracking
}

export interface WebhookOrderPayload {
  webhookOrdersId?: number
  webhookEventId?: number
  orderId?: number
  orderNumber?: string
  // Our client reference (= ongoing_order_number / goodsOwnerOrderId).
  goodsOwnerOrderId?: string
  goodsOwnerId: number
  orderStatus: WebhookOrderStatus
  tracking?: WebhookOrderTracking[]
  parcels?: WebhookOrderParcel[]
  // ISO-8601 with 7 fractional digits, e.g. "2026-06-30T12:00:00.0000000Z".
  timestamp?: string
}
```

- [ ] **Step 2: Create the #36 dispatch seam stub**

Create `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts`:
```ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { WebhookOrderPayload } from "../../../../lib/ongoing/types"

export type VerifiedShipmentWebhook = {
  payload: WebhookOrderPayload
  integrationId: string
  credentialKey: string
}

// Extension seam owned by #36. A verified, in-band shipment webhook lands here.
// #35 ships it as an acknowledged no-op so the route can return 200; #36 replaces
// the body with the idempotent syncOngoingShipment workflow invocation (guarded by
// OngoingOrderSync.shipped_at). Keep this signature stable for #36.
export async function dispatchVerifiedShipment(
  scope: MedusaContainer,
  verified: VerifiedShipmentWebhook
): Promise<void> {
  const logger = scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.debug(
    `[ongoing] webhook: verified in-band shipment for order ` +
      `${verified.payload.orderNumber ?? verified.payload.orderId} ` +
      `(integration ${verified.integrationId}); shipment dispatch is wired in #36`
  )
}
```

- [ ] **Step 3: Lint + build**

Run: `yarn lint && yarn build`
Expected: both pass; `.medusa/server` includes the compiled `dispatch-shipment.js` and the updated types. (No test for scaffolding — Task 2 exercises the seam.)

---

## Task 2: `POST /ongoing/webhooks/:credentialKey` route (TDD)

The handler is business logic (auth, validation, status-gating) → **test-driven**: write the failing test first, watch it fail, then implement.

**Files:**
- Create: `src/api/ongoing/webhooks/[credentialKey]/route.ts`
- Test: `src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts`

**Interfaces:**
- Consumes:
  - `ONGOING_MODULE` (`"ongoing"`) from `../../../../modules/ongoing`.
  - `OngoingModuleService.getCredentials(credentialKey: string): OngoingCredentials` (sync; throws `MedusaError(INVALID_DATA)` on unknown key).
  - `OngoingModuleService.listOngoingIntegrations(filter: { credential_key: string }): Promise<Array<{ id: string; shipped_status_codes: number[] | null }>>` (auto-CRUD).
  - `dispatchVerifiedShipment(scope, verified)` from `./dispatch-shipment` (Task 1).
- Produces:
  - `export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void>`.
  - Status contract: `200` on success/no-op, uniform `401` on any auth failure, `400` on unparseable/malformed body.

- [ ] **Step 1: Write the failing tests**

Create `src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts`:
```ts
import { MedusaError } from "@medusajs/framework/utils"

// Mock the #36 seam so the in-band path is observable and side-effect-free.
const dispatchVerifiedShipment = jest.fn().mockResolvedValue(undefined)
jest.mock("../dispatch-shipment", () => ({
  __esModule: true,
  dispatchVerifiedShipment,
}))

import { POST } from "../route"

const SECRET = "s3cret-token"
const GOODS_OWNER = 42

const validBody = () => ({
  webhookOrdersId: 1,
  webhookEventId: 2,
  orderId: 1001,
  orderNumber: "SO-1001",
  goodsOwnerOrderId: "1001-aaa",
  goodsOwnerId: GOODS_OWNER,
  orderStatus: { number: 320, text: "Shipped" },
  tracking: [{ trackingUrl: "https://t/1", waybill: "WB1", isReturn: false }],
  parcels: [
    {
      id: 5,
      parcelNumber: "P1",
      isReturnParcel: false,
      tracking: { trackingUrl: "https://t/1" },
    },
  ],
  timestamp: "2026-06-30T12:00:00.0000000Z",
})

const makeCreds = (overrides: Record<string, unknown> = {}) => ({
  key: "wh-1",
  baseUrl: "https://api.ongoing",
  username: "u",
  password: "p",
  goodsOwnerId: GOODS_OWNER,
  webhookSecret: SECRET,
  ...overrides,
})

const makeService = (opts: {
  credentials?: ReturnType<typeof makeCreds> | null
  integrations?: Array<{ id: string; shipped_status_codes: number[] | null }>
}) => ({
  getCredentials: jest.fn(() => {
    if (opts.credentials === null || opts.credentials === undefined) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] no credentials configured for credential_key "wh-1"`
      )
    }
    return opts.credentials
  }),
  listOngoingIntegrations: jest
    .fn()
    .mockResolvedValue(opts.integrations ?? []),
})

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

const makeReq = (opts: {
  credentialKey?: string
  token?: string
  body?: unknown
  service: ReturnType<typeof makeService>
}) =>
  ({
    params: { credentialKey: opts.credentialKey ?? "wh-1" },
    headers:
      opts.token === undefined ? {} : { "x-auth-token": opts.token },
    body: opts.body ?? validBody(),
    scope: {
      resolve: jest.fn((key: string) =>
        key === "ongoing" ? opts.service : logger
      ),
    },
  }) as any

const makeRes = () => ({ sendStatus: jest.fn() }) as any

describe("POST /ongoing/webhooks/:credentialKey", () => {
  it("returns 401 for an unknown credentialKey (uniform, no enumeration)", async () => {
    const service = makeService({ credentials: null })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 when no webhookSecret is configured for the integration", async () => {
    const service = makeService({
      credentials: makeCreds({ webhookSecret: undefined }),
    })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 on X-Auth-Token mismatch", async () => {
    const service = makeService({ credentials: makeCreds() })
    const res = makeRes()
    await POST(makeReq({ token: "wrong-token", service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 401 on goodsOwnerId mismatch (defense in depth)", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = { ...validBody(), goodsOwnerId: 999 }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(401)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 400 on an unparseable/malformed body (after auth passes)", async () => {
    const service = makeService({ credentials: makeCreds() })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, body: { foo: "bar" }, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(400)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 200 no-op when the status is out of band (not in shipped_status_codes)", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    const body = { ...validBody(), orderStatus: { number: 210, text: "Picking" } }
    await POST(makeReq({ token: SECRET, body, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).not.toHaveBeenCalled()
  })

  it("returns 200 and reaches the #36 seam for a valid, in-band webhook", async () => {
    const service = makeService({
      credentials: makeCreds(),
      integrations: [{ id: "int_1", shipped_status_codes: [320] }],
    })
    const res = makeRes()
    await POST(makeReq({ token: SECRET, service }), res)
    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(dispatchVerifiedShipment).toHaveBeenCalledTimes(1)
    expect(dispatchVerifiedShipment).toHaveBeenCalledWith(expect.anything(), {
      payload: expect.objectContaining({
        goodsOwnerId: GOODS_OWNER,
        orderStatus: { number: 320, text: "Shipped" },
      }),
      integrationId: "int_1",
      credentialKey: "wh-1",
    })
  })

  it("does not reveal which auth check failed (uniform 401 across causes)", async () => {
    const res1 = makeRes()
    await POST(
      makeReq({ token: SECRET, service: makeService({ credentials: null }) }),
      res1
    )
    const res2 = makeRes()
    await POST(
      makeReq({ token: "wrong", service: makeService({ credentials: makeCreds() }) }),
      res2
    )
    expect(res1.sendStatus).toHaveBeenCalledWith(401)
    expect(res2.sendStatus).toHaveBeenCalledWith(401)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/ongoing/webhooks/`
Expected: FAIL — cannot find module `../route` (the route file does not exist yet). The `jest.mock("../dispatch-shipment", ...)` factory resolves regardless (Task 1 created it; even if it had not, the factory stands in).

- [ ] **Step 3: Implement the route**

Create `src/api/ongoing/webhooks/[credentialKey]/route.ts`:
```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { timingSafeEqual } from "crypto"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import type {
  OngoingCredentials,
  WebhookOrderPayload,
} from "../../../../lib/ongoing/types"
import { dispatchVerifiedShipment } from "./dispatch-shipment"

// Timing-safe equality. timingSafeEqual throws on unequal-length buffers, so we
// guard byteLength first; an early length-difference return is acceptable here
// (it does not leak the secret, only that the token is the wrong length).
function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(presented, "utf8")
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

function parsePayload(body: unknown): WebhookOrderPayload | null {
  if (!body || typeof body !== "object") {
    return null
  }
  const b = body as Record<string, unknown>
  const status = b.orderStatus as Record<string, unknown> | undefined
  if (
    typeof b.goodsOwnerId !== "number" ||
    !status ||
    typeof status.number !== "number"
  ) {
    return null
  }
  return b as unknown as WebhookOrderPayload
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const credentialKey = req.params.credentialKey
  const ongoing = req.scope.resolve(ONGOING_MODULE) as {
    getCredentials: (key: string) => OngoingCredentials
    listOngoingIntegrations: (filter: {
      credential_key: string
    }) => Promise<Array<{ id: string; shipped_status_codes: number[] | null }>>
  }

  // --- Auth: unknown credentialKey -> uniform 401 ---
  let credentials: OngoingCredentials
  try {
    credentials = ongoing.getCredentials(credentialKey)
  } catch {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Auth: missing webhookSecret -> uniform 401 (force explicit config) ---
  const secret = credentials.webhookSecret
  if (!secret) {
    logger.warn(
      `[ongoing] webhook: rejected request — no webhookSecret configured for "${credentialKey}"`
    )
    res.sendStatus(401)
    return
  }

  // --- Auth: X-Auth-Token timing-safe compare -> uniform 401 ---
  const header = req.headers["x-auth-token"]
  const presented = Array.isArray(header) ? header[0] : header
  if (typeof presented !== "string" || !tokensMatch(secret, presented)) {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Parse body -> 400 on unparseable/malformed (after auth) ---
  const payload = parsePayload(req.body)
  if (!payload) {
    logger.warn(
      `[ongoing] webhook: unparseable payload for "${credentialKey}"`
    )
    res.sendStatus(400)
    return
  }

  // --- Auth (defense in depth): goodsOwnerId must match -> uniform 401 ---
  if (payload.goodsOwnerId !== credentials.goodsOwnerId) {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Status gate: only in-band statuses proceed; everything else acks 200 ---
  const [integration] = await ongoing.listOngoingIntegrations({
    credential_key: credentialKey,
  })
  const shippedCodes = (integration?.shipped_status_codes ?? []) as number[]
  if (!integration || !shippedCodes.includes(payload.orderStatus.number)) {
    logger.debug(
      `[ongoing] webhook: status ${payload.orderStatus.number} not in ` +
        `shipped_status_codes for "${credentialKey}"; acknowledging no-op`
    )
    res.sendStatus(200)
    return
  }

  // --- In-band: hand off to the #36 shipment-sync seam, then ack 200 ---
  await dispatchVerifiedShipment(req.scope, {
    payload,
    integrationId: integration.id,
    credentialKey,
  })
  res.sendStatus(200)
}
```

Notes the implementer must honour:
- **No `AUTHENTICATE` export** and **no `src/api/middlewares.ts`** — the route is intentionally public and uses the default JSON body parser.
- The status-gate `if (!integration || ...)` both handles the missing-integration row and narrows `integration` to defined for the seam call below (so `integration.id` type-checks).
- Replay/dedup is **deliberately absent** here (see plan header) — do not add a `webhookEventId` store or a timestamp window.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/api/ongoing/webhooks/`
Expected: PASS — all 8 cases (unknown key 401, missing secret 401, token mismatch 401, goodsOwnerId mismatch 401, malformed body 400, out-of-band 200 no-op, in-band 200 reaching the mocked seam, uniform-401 across causes).

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (existing lib/module/workflow/subscriber suites + the new route suite).

- [ ] **Step 6: Lint + build**

Run: `yarn lint && yarn build`
Expected: `medusa lint` clean and `medusa plugin:build` completes without TypeScript errors; `.medusa/server` includes the compiled route and seam.

- [ ] **Step 7: Commit**

```bash
git add src/api/ongoing/webhooks src/lib/ongoing/types.ts
git commit -m "feat(ongoing-api): POST /ongoing/webhooks/:credentialKey — X-Auth-Token auth, status-gated ack (#35)"
```

---

## Scope boundary with #36

This issue (#35) delivers the **authenticated, parsing, status-gating** route that returns `200`/`401`/`400`. The route hands a verified, in-band payload to `dispatchVerifiedShipment` (`./dispatch-shipment`), which ships in #35 as an acknowledged no-op. **Issue #36** replaces that seam's body with the idempotent `syncOngoingShipment` workflow invocation. #36 needs only to edit `dispatch-shipment.ts` (the signature and the `VerifiedShipmentWebhook` shape are the stable contract); the route, its auth, and its tests are untouched.

---

## Self-Review (completed during planning)

- **Spec correction is prominent and load-bearing:** the §7 "HMAC" framing is explicitly contradicted in the plan header with the research-backed reason (Ongoing offers None/Basic/`X-Auth-Token`/mTLS only). The plan implements `X-Auth-Token` vs `webhookSecret` timing-safe compare, adds **no** middlewares/raw-body capture, and does **not** edit the immutable spec.
- **Spec coverage:** §7 webhook route — public `POST /ongoing/webhooks/:credentialKey` ✓; `crypto.timingSafeEqual` ✓ (with the mandatory equal-length guard before the call); uniform `401` for unknown key + bad auth, no enumeration ✓; "basic replay protection" reinterpreted per locked research as downstream `shipped_at` idempotency (no skew window, because Ongoing retries with the same timestamp) ✓; converges on the same `syncOngoingShipment` via the #36 seam ✓.
- **Locked decisions honoured:** missing secret → 401 + warning ✓; equal-byteLength guard before `timingSafeEqual` ✓; `goodsOwnerId` cross-validation → 401 ✓; uniform 401 across all four causes (asserted by the "does not reveal which auth check failed" test) ✓; out-of-band status → 200 + debug log ✓; 200 on success/no-op, 400 on unparseable ✓.
- **Real symbols:** `ONGOING_MODULE = "ongoing"` (`src/modules/ongoing/index.ts:5`), `getCredentials` sync-throws `MedusaError(INVALID_DATA)` (`service.ts:35-44`), `shipped_status_codes` json column (`models/integration.ts:15`), `webhookSecret?` (`lib/ongoing/types.ts:7`), `MedusaRequest/MedusaResponse` from `@medusajs/framework/http`, `MedusaContainer` from `@medusajs/framework/types`, `ContainerRegistrationKeys.LOGGER` (matches `subscribers/order-updated.ts:34`).
- **Real test command:** `yarn test src/api/ongoing/webhooks/` (jest `roots: <rootDir>/src`, `testMatch **/__tests__/**/*.test.ts` per `jest.config.js`); full suite `yarn test`; gates `yarn lint`, `yarn build`.
- **Medusa rules:** `POST` only (no PUT/PATCH); module isolation (route uses only the resolved `ongoing` service); `MedusaError` is caught-and-converted not re-thrown (a webhook must return a status code); route handler is `async`. No mutation occurs in #35 (the seam is a no-op), so no workflow-composition rules apply here; #36 introduces the workflow.
- **Named-handler / mockability discipline:** `POST` is the exported, directly unit-testable handler (mocked `req.scope`), mirroring `src/subscribers/order-canceled.ts`; the #36 seam is an independently `jest.mock`-able module.
- **No forbidden tokens:** every code block is complete; the #36 hand-off is described in prose and a stable, compiling no-op stub — there are no `TODO`/`TBD`/`FIXME` literals to trip `scripts/verify-plan.sh`.

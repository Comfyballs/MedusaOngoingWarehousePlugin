# Order Widget — Status, Parcel Tracking, Re-push/Retry (#42)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Business-logic tasks (the two API routes) follow superpowers:test-driven-development — the failing test is written and run-to-fail **before** the implementation. The widget itself is UI composition with no branching business logic of its own (state derivation is a one-line map); it is exempt from TDD per `docs/superpowers/process.md` ("Config, scripts, infra, and pure scaffolding are exempt") and is verified by `npx tsc -p src/admin/tsconfig.json --noEmit` (the admin type-gate) plus `yarn build` (the packaging/bundle check) instead.

**Goal:** Give operators, on the Medusa admin order detail page, visibility into every `OngoingOrderSync` row for that order — Ongoing order number, current status code/text, per-parcel tracking numbers, last sync/error — plus a state-aware re-push/retry action that calls the existing idempotent `pushOrderToOngoing` workflow. Two new admin-only routes back the widget: a `GET` that reads+enriches sync rows, and a `POST` that validates and re-triggers the push.

**Out of scope (explicitly, do not implement here):**
- **Edit-blocked surfacing is deferred to #91.** `ongoing.sync.edit_blocked` (emitted by `src/subscribers/order-edit-confirmed.ts:75-84`) is not persisted anywhere today — there is no column on `OngoingOrderSync` for it. The widget in this plan renders **only persisted `OngoingOrderSync` fields**; it does not show an "edit blocked" banner. #91 will add the persistence + surfacing once scoped.
- Bulk retry / dashboard-wide view (spec §10 "Dashboard page") — separate issue.
- `retryFailedSyncs` is a **scheduled job**, not callable from a route (spec §6); the button always calls `pushOrderToOngoing` directly, never the job.
- Settings page, integration CRUD, test-connection, `page.tsx` — owned by #40.
- Emitting any `ongoing.sync.*` events — owned by #44.

---

## Research and code already read (cited, load-bearing)

- **`src/modules/ongoing/models/order-sync.ts:3-22`** — `OngoingOrderSync` fields: `id`, `integration_id`, `medusa_order_id`, `medusa_fulfillment_id` (nullable), `ongoing_order_number` (unique), `ongoing_order_id` (nullable number), `latest_status_code`/`latest_status_text` (nullable), `sync_state` (`"pending"|"sent"|"shipped"|"cancelled"|"error"`, default `"pending"`), `error_class` (`"retryable"|"terminal"|null`), `last_synced_at`, `last_error`, `retry_count` (default 0), `shipped_at`. **No tracking fields on this model** — tracking must be resolved from the linked Medusa `fulfillment.labels`.
- **`src/modules/ongoing/service.ts:63-78`** — `recordSync(input)` upserts by `ongoing_order_number`: if a row exists it updates it (clearing `error_class`/`last_error` when the caller passes `null`), otherwise creates it. This means **re-push self-heals**: calling `pushOrderToOngoing` again overwrites `sync_state`/`error_class`/`last_error` on the same row (see `src/workflows/steps/push-order-record-sync.ts:34-42` — clears error columns and sets `sync_state: "pending"` before the PUT). The POST route in this plan does not need to reset any sync-row state itself; the workflow already does it.
- **`src/workflows/push-order-to-ongoing.ts:1-49`** — `export const pushOrderToOngoing = createWorkflow("push-order-to-ongoing", ...)`. Input type `PushOrderToOngoingInput = { fulfillment_id: string }` (line 8). Output `PushOrderToOngoingOutput = { ongoingOrderId: number; orderNumber: string }` (line 9). Invocation pattern used elsewhere in this repo: `pushOrderToOngoing(container).run({ input })` (mirrors `src/api/ongoing/webhooks/[credentialKey]/dispatch-shipment.ts:27`, which calls `syncOngoingShipmentWorkflow(scope).run({ input })`). Also re-exported from the barrel `src/workflows/index.ts:7` as `export { pushOrderToOngoing } from "./push-order-to-ongoing"`.
- **`src/workflows/steps/apply-order-shipment.ts:36-40`** — when a shipment is applied, `labels` are built as `{ tracking_number: tn, tracking_url: "", label_url: "" }` — **`tracking_url` is currently always the empty string** on labels created by this plugin's shipment-apply step. The GET route in this plan must not assume `tracking_url` is populated; it degrades to plain (non-link) text when empty, which is exactly what happens today. **Do not treat this as a bug to fix in #42** — it's #33's documented current behavior; fixing it (e.g. threading Ongoing's `parcelTracking` URL through) is out of scope here.
- **`src/subscribers/order-edit-confirmed.ts`** — confirms `ongoing.sync.edit_blocked` is only an **emitted event** (lines 75-84), never written to `OngoingOrderSync` or any other persisted row. This is the basis for the "#91 deferred" scope line above.
- **`src/modules/ongoing/index.ts:5`** — `export const ONGOING_MODULE = "ongoing"`.
- **`src/lib/ongoing/re-query-fulfillment-order.ts:37-62`** — confirms the `query.graph({ entity, fields, filters })` call shape used throughout this codebase (resolve `ContainerRegistrationKeys.QUERY` from the scope, `fields` as dotted paths, `filters: { id: ... }`, response is `{ data: [...] }`).
- **`src/api/ongoing/webhooks/[credentialKey]/route.ts`** and its test **`.../route.test.ts`** — the established pattern for a directly-unit-testable, named-export route handler (`export async function POST(req, res)`) with a hand-rolled `req.scope.resolve` mock and no supertest/Medusa-app bootstrap. This plan's two routes and tests follow the same shape.
- **Verified against installed packages (`node_modules`), not memory:**
  - `@medusajs/types/dist/admin/extensions.d.ts:25` exports `DetailWidgetProps<TData>`; `@medusajs/framework/dist/types/index.d.ts` re-exports all of `@medusajs/types`, so `import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"` resolves.
  - `@medusajs/admin-shared/dist/index.d.ts:63` lists `"order.details.side.before"` as a valid `InjectionZone` literal.
  - `@medusajs/utils/dist/common/container.d.ts:7` — `ContainerRegistrationKeys.QUERY = "query"`.
  - `@medusajs/ui` ships `Container`, `Heading`, `Text`, `Badge` (`badge.d.ts`: `color` accepts `"green"|"red"|"blue"|"orange"|"grey"|"purple"`), `Button` (`button.d.ts`: `variant` accepts `"primary"|"transparent"|"secondary"|"danger"`, `size` accepts `"small"|"base"|"large"|"xlarge"`, has `isLoading?: boolean`).
  - `@tanstack/react-query@5.64.2` is installed — v5 object-form `useQuery({ queryKey, queryFn })` / `useMutation({ mutationFn, onSuccess })` / `useQueryClient().invalidateQueries({ queryKey })`.
  - `@medusajs/js-sdk@2.16.0` is present in `node_modules` (resolves transitively via `@medusajs/admin-sdk`) — `Client.fetch<T>(input, init)` (`node_modules/@medusajs/js-sdk/dist/client.d.ts:43`) is the method `sdk.client.fetch<T>(path, init)` used below.
  - `@medusajs/framework/dist/http/types.d.ts:93-95` — `MedusaRequest<Body, QueryFields>` extends Express `Request<Params, ResBody, Body>`, so `req.body` is typed by the `Body` generic.
- **Import-depth arithmetic (verified with `node -e "path.relative(...)"`)**: from `src/api/admin/ongoing/orders/[orderId]/sync/route.ts` (and the sibling `repush/route.ts`), both `src/modules/ongoing` and `src/workflows` are **6 levels up**: `../../../../../../modules/ongoing` and `../../../../../../workflows`. The `__tests__` directory nests one level deeper than its sibling `route.ts`, so a `jest.mock(...)` path resolved *from a test file* is **one level further**: `src/api/admin/ongoing/orders/[orderId]/repush/__tests__/route.test.ts` mocking `src/workflows` is **7 levels up** (`../../../../../../../workflows`), not 6 — verified with `node -e "console.log(require('path').relative('src/api/admin/ongoing/orders/[orderId]/repush/__tests__','src/workflows'))"` → `../../../../../../../workflows`. Task 2 Step 1's test uses the 7-level path; only `route.ts` itself (Task 2 Step 3) uses the 6-level path.

---

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6** (`Node16` module resolution for the server, `bundler` resolution for `src/admin` — see `src/admin/tsconfig.json`); yarn **4.6.0**; Node **>= 20**.
- **Admin routes are auto-authenticated** — no `AUTHENTICATE` export needed for anything under `src/api/admin/**`.
- **No PUT/PATCH routes** (Medusa rule): the re-push endpoint is `POST`, not `PUT`/`PATCH`.
- **Module isolation**: routes talk to the `ongoing` module only via its resolved service (`ONGOING_MODULE`) and to core order/fulfillment data only via `ContainerRegistrationKeys.QUERY`'s `query.graph`. No repository reach-around, no cross-module service imports.
- **`MedusaError`**, never a generic `Error`, for validation failures (`MedusaError.Types.INVALID_DATA` for the missing/invalid `fulfillment_id` case), imported from `@medusajs/framework/utils`.
- Both routes are `async` named exports (`GET`, `POST`) so they are directly unit-testable with a hand-built `req`/`res` mock — no supertest, no live Postgres/Medusa app (matches `src/api/ongoing/webhooks/[credentialKey]/route.test.ts`).
- The widget file lives under `src/admin/**`, which is **excluded from the server `tsconfig`** (root `tsconfig.json`) and bundled separately by the admin Vite/esbuild pipeline. **`yarn build` (`medusa plugin:build`) does NOT type-check `src/admin` TSX** — `medusa plugin:build` excludes `src/admin` from the `tsc` server compile and bundles the widget via Vite/esbuild, which transpiles but does not type-check; a wrong `Badge`/`Button` prop, a `DetailWidgetProps<AdminOrder>` mismatch, or an unused local would pass `yarn build` silently. The **actual type-gate** for the widget is `npx tsc -p src/admin/tsconfig.json --noEmit` (`src/admin/tsconfig.json`: `strict: true`, `noUnusedLocals`/`noUnusedParameters: true`, `jsx: "react-jsx"`, `moduleResolution: "bundler"`). The widget task therefore runs **both**: the `tsc --noEmit` type-gate, then `yarn build` as the separate packaging/bundle check.
- `jest.config.js`: `testEnvironment: "node"`, `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`, `@swc/jest` transform. Route tests are plain `.ts` (no JSX), so no jsdom/React test setup is required or added.
- **Shared admin scaffolding ownership (do not violate):**
  - `src/admin/lib/sdk.ts` is owned by **#40**. Import it. **Create it only if it does not already exist** in this branch, and if you do create it, it must be **byte-identical** to the snippet in Task 3 Step 1 below — do not add fields, comments, or reformat it.
  - Do **not** add `@medusajs/js-sdk` to `package.json` — it resolves transitively (already confirmed present in `node_modules`).
  - Do not touch `page.tsx`, any settings route, integration CRUD, or test-connection code (#40).
  - Do not emit or subscribe to any `ongoing.sync.*` event (#44).
  - This plan's routes live at `/admin/ongoing/orders/[orderId]/sync` and `/admin/ongoing/orders/[orderId]/repush` — a path distinct from #40's `/admin/ongoing/integrations` tree, so there is no route collision.

---

## File Structure

**Create:**
- `src/api/admin/ongoing/orders/[orderId]/sync/route.ts` — `GET` handler.
- `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts` — unit tests.
- `src/api/admin/ongoing/orders/[orderId]/repush/route.ts` — `POST` handler.
- `src/api/admin/ongoing/orders/[orderId]/repush/__tests__/route.test.ts` — unit tests.
- `src/admin/widgets/ongoing-order-sync.tsx` — the order-detail widget.
- `src/admin/lib/sdk.ts` — **only if absent** (see Task 3 Step 1; owned by #40).

**Depends on (already exists, unmodified):**
- `src/modules/ongoing/index.ts` — `ONGOING_MODULE = "ongoing"`.
- `src/modules/ongoing/service.ts` — auto-CRUD `listOngoingOrderSyncs(filter)` (from `MedusaService({ OngoingOrderSync, ... })`).
- `src/modules/ongoing/models/order-sync.ts` — field shapes (cited above).
- `src/workflows/push-order-to-ongoing.ts` / `src/workflows/index.ts` — `pushOrderToOngoing` workflow.

---

## Task 1: `GET /admin/ongoing/orders/:orderId/sync` (TDD)

Lists every `OngoingOrderSync` row for the order and enriches rows that have a linked Medusa fulfillment with that fulfillment's tracking labels (multi-parcel: N labels → N tracking entries).

**Files:**
- Create: `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`
- Test: `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts`

**Interface:**
- Consumes: `ONGOING_MODULE` service `listOngoingOrderSyncs({ medusa_order_id: string }): Promise<OngoingOrderSyncRow[]>`; `ContainerRegistrationKeys.QUERY`'s `query.graph({ entity: "fulfillment", fields: ["id", "labels.tracking_number", "labels.tracking_url"], filters: { id: string[] } }): Promise<{ data: Array<{ id: string; labels: Array<{ tracking_number: string | null; tracking_url: string | null }> }> }>`.
- Produces: `export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void>`, responding `res.status(200).json({ syncs: OngoingOrderSyncWithTracking[] })`, where an order with no sync rows returns `{ syncs: [] }`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts`:

```ts
import { GET } from "../route"

const QUERY_KEY = "query"
const MODULE_KEY = "ongoing"

const makeSyncRow = (overrides: Record<string, unknown> = {}) => ({
  id: "osync_1",
  integration_id: "int_1",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  ongoing_order_number: "1001-ful_1",
  ongoing_order_id: 555,
  latest_status_code: 320,
  latest_status_text: "Shipped",
  sync_state: "shipped",
  error_class: null,
  last_synced_at: "2026-07-01T00:00:00.000Z",
  last_error: null,
  retry_count: 0,
  shipped_at: "2026-07-01T00:00:00.000Z",
  ...overrides,
})

const makeOngoingService = (syncs: Array<Record<string, unknown>>) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(syncs),
})

const makeQuery = (data: Array<Record<string, unknown>>) => ({
  graph: jest.fn().mockResolvedValue({ data }),
})

const makeReq = (opts: {
  orderId?: string
  ongoingService: ReturnType<typeof makeOngoingService>
  query: ReturnType<typeof makeQuery>
}) =>
  ({
    params: { orderId: opts.orderId ?? "order_1" },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === MODULE_KEY) return opts.ongoingService
        if (key === QUERY_KEY) return opts.query
        throw new Error(`unexpected resolve key: ${key}`)
      }),
    },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /admin/ongoing/orders/:orderId/sync", () => {
  it("returns { syncs: [] } and never queries fulfillments when there are no sync rows", async () => {
    const ongoingService = makeOngoingService([])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(ongoingService.listOngoingOrderSyncs).toHaveBeenCalledWith({
      medusa_order_id: "order_1",
    })
    expect(query.graph).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ syncs: [] })
  })

  it("returns tracking: [] for a sync row with no medusa_fulfillment_id, without calling query.graph", async () => {
    const row = makeSyncRow({ medusa_fulfillment_id: null, sync_state: "pending" })
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      syncs: [{ ...row, tracking: [] }],
    })
  })

  it("enriches a sync row with multi-parcel tracking numbers from fulfillment.labels", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([
      {
        id: "ful_1",
        labels: [
          { tracking_number: "TRACK-A", tracking_url: "https://carrier/A" },
          { tracking_number: "TRACK-B", tracking_url: "" },
        ],
      },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).toHaveBeenCalledWith({
      entity: "fulfillment",
      fields: ["id", "labels.tracking_number", "labels.tracking_url"],
      filters: { id: ["ful_1"] },
    })
    expect(res.json).toHaveBeenCalledWith({
      syncs: [
        {
          ...row,
          tracking: [
            { tracking_number: "TRACK-A", tracking_url: "https://carrier/A" },
            { tracking_number: "TRACK-B", tracking_url: null },
          ],
        },
      ],
    })
  })

  it("filters out labels with an empty or missing tracking_number", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([
      {
        id: "ful_1",
        labels: [
          { tracking_number: "", tracking_url: "" },
          { tracking_number: null, tracking_url: null },
          { tracking_number: "TRACK-C", tracking_url: null },
        ],
      },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(res.json).toHaveBeenCalledWith({
      syncs: [{ ...row, tracking: [{ tracking_number: "TRACK-C", tracking_url: null }] }],
    })
  })

  it("returns tracking: [] when the fulfillment id is set but query.graph finds no match", async () => {
    const row = makeSyncRow()
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(res.json).toHaveBeenCalledWith({ syncs: [{ ...row, tracking: [] }] })
  })

  it("dedupes fulfillment ids into a single batched query.graph call across multiple sync rows", async () => {
    const rowA = makeSyncRow({ id: "osync_1", medusa_fulfillment_id: "ful_1" })
    const rowB = makeSyncRow({ id: "osync_2", medusa_fulfillment_id: "ful_1" })
    const rowC = makeSyncRow({ id: "osync_3", medusa_fulfillment_id: "ful_2" })
    const ongoingService = makeOngoingService([rowA, rowB, rowC])
    const query = makeQuery([
      { id: "ful_1", labels: [{ tracking_number: "T1", tracking_url: null }] },
      { id: "ful_2", labels: [{ tracking_number: "T2", tracking_url: null }] },
    ])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(query.graph).toHaveBeenCalledTimes(1)
    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { id: ["ful_1", "ful_2"] } })
    )
    expect(res.json).toHaveBeenCalledWith({
      syncs: [
        { ...rowA, tracking: [{ tracking_number: "T1", tracking_url: null }] },
        { ...rowB, tracking: [{ tracking_number: "T1", tracking_url: null }] },
        { ...rowC, tracking: [{ tracking_number: "T2", tracking_url: null }] },
      ],
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/admin/ongoing/orders`
Expected: FAIL — `Cannot find module '../route'` (the route file does not exist yet).

- [ ] **Step 3: Implement the route**

Create `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../../../../../modules/ongoing"

export type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | Date | null
  last_error: string | null
  retry_count: number
  shipped_at: string | Date | null
}

export type OngoingOrderSyncTracking = {
  tracking_number: string
  tracking_url: string | null
}

export type OngoingOrderSyncWithTracking = OngoingOrderSyncRow & {
  tracking: OngoingOrderSyncTracking[]
}

type OngoingServiceLike = {
  listOngoingOrderSyncs: (filter: {
    medusa_order_id: string
  }) => Promise<OngoingOrderSyncRow[]>
}

type QueryLike = {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }) => Promise<{
    data: Array<{
      id: string
      labels?: Array<{ tracking_number: string | null; tracking_url: string | null }>
    }>
  }>
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingServiceLike

  const syncs = await ongoing.listOngoingOrderSyncs({
    medusa_order_id: req.params.orderId,
  })

  if (syncs.length === 0) {
    res.status(200).json({ syncs: [] })
    return
  }

  const fulfillmentIds = Array.from(
    new Set(
      syncs
        .map((s) => s.medusa_fulfillment_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  )

  const trackingByFulfillment = new Map<string, OngoingOrderSyncTracking[]>()

  if (fulfillmentIds.length > 0) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as QueryLike
    const { data } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "labels.tracking_number", "labels.tracking_url"],
      filters: { id: fulfillmentIds },
    })

    for (const fulfillment of data) {
      const tracking = (fulfillment.labels ?? [])
        .filter(
          (label): label is { tracking_number: string; tracking_url: string | null } =>
            typeof label.tracking_number === "string" && label.tracking_number.length > 0
        )
        .map((label) => ({
          tracking_number: label.tracking_number,
          tracking_url: label.tracking_url || null,
        }))
      trackingByFulfillment.set(fulfillment.id, tracking)
    }
  }

  const enriched: OngoingOrderSyncWithTracking[] = syncs.map((s) => ({
    ...s,
    tracking: s.medusa_fulfillment_id
      ? trackingByFulfillment.get(s.medusa_fulfillment_id) ?? []
      : [],
  }))

  res.status(200).json({ syncs: enriched })
}
```

Notes the implementer must honour:
- The fulfillment-id dedupe (`Array.from(new Set(...))`) means one `query.graph` call regardless of how many sync rows share a fulfillment — this is a deliberate improvement over a per-row call (it's Medusa's own DB via `query.graph`, not an Ongoing API call, so there is no Ongoing rate-limit concern in doing it this way).
- `label.tracking_url || null` treats both `""` and `null`/`undefined` as "no URL" — this matches `apply-order-shipment.ts:36-40`, which currently always writes `tracking_url: ""`. Do not "fix" that upstream behavior here; the widget (Task 3) already renders plain text when `tracking_url` is falsy.
- **Verify at implementation time**: run this route against a live dev order with a shipped fulfillment and confirm `labels.tracking_number` / `labels.tracking_url` is a valid `query.graph` field path on `fulfillment` in 2.16.0 (it is the same relation `apply-order-shipment.ts` writes `labels` through, but this plan has not executed a live `query.graph` call against it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/api/admin/ongoing/orders`
Expected: PASS — all 6 cases (empty syncs / no query call, null-fulfillment row, multi-parcel enrichment, empty-tracking_number filtering, no-match fulfillment, dedupe-into-one-call).

---

## Task 2: `POST /admin/ongoing/orders/:orderId/repush` (TDD)

Validates `fulfillment_id` and re-invokes the idempotent `pushOrderToOngoing` workflow. Relies entirely on the workflow's own `recordSync` self-healing (cited above) to reset `sync_state`/`error_class`/`last_error` on the existing row — this route does no direct writes to `OngoingOrderSync`.

**Files:**
- Create: `src/api/admin/ongoing/orders/[orderId]/repush/route.ts`
- Test: `src/api/admin/ongoing/orders/[orderId]/repush/__tests__/route.test.ts`

**Interface:**
- Consumes: `pushOrderToOngoing` from `../../../../../../workflows` (`pushOrderToOngoing(container): { run(args: { input: { fulfillment_id: string } }): Promise<{ result: { ongoingOrderId: number; orderNumber: string } }> }`).
- Produces: `export async function POST(req: MedusaRequest<{ fulfillment_id?: unknown }>, res: MedusaResponse): Promise<void>`. `200` with `{ ongoing_order_id, ongoing_order_number }` on success; throws `MedusaError(MedusaError.Types.INVALID_DATA)` (caught by Medusa's global error middleware, not by this route) when `fulfillment_id` is missing/empty/non-string; **propagates** (does not catch) any error thrown by the workflow so Medusa's error middleware renders the correct HTTP status for e.g. a terminal validation failure recorded by `push-order-record-sync.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/orders/[orderId]/repush/__tests__/route.test.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"

const workflowRun = jest.fn()
const pushOrderToOngoing = jest.fn(() => ({ run: workflowRun }))

jest.mock("../../../../../../../workflows", () => ({
  __esModule: true,
  pushOrderToOngoing: (...args: unknown[]) => pushOrderToOngoing(...args),
}))

import { POST } from "../route"

const makeReq = (body: unknown, orderId = "order_1") =>
  ({
    params: { orderId },
    body,
    scope: { resolve: jest.fn() },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("POST /admin/ongoing/orders/:orderId/repush", () => {
  it("throws MedusaError(INVALID_DATA) when fulfillment_id is missing", async () => {
    const res = makeRes()
    await expect(POST(makeReq({}), res)).rejects.toThrow(MedusaError)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when fulfillment_id is an empty string", async () => {
    const res = makeRes()
    await expect(POST(makeReq({ fulfillment_id: "   " }), res)).rejects.toThrow(
      MedusaError
    )
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when fulfillment_id is not a string", async () => {
    const res = makeRes()
    await expect(POST(makeReq({ fulfillment_id: 123 }), res)).rejects.toThrow(
      MedusaError
    )
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("invokes pushOrderToOngoing(req.scope).run with the fulfillment_id and returns the result", async () => {
    workflowRun.mockResolvedValueOnce({
      result: { ongoingOrderId: 555, orderNumber: "1001-ful_1" },
    })
    const req = makeReq({ fulfillment_id: "ful_1" })
    const res = makeRes()

    await POST(req, res)

    expect(pushOrderToOngoing).toHaveBeenCalledWith(req.scope)
    expect(workflowRun).toHaveBeenCalledWith({ input: { fulfillment_id: "ful_1" } })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      ongoing_order_id: 555,
      ongoing_order_number: "1001-ful_1",
    })
  })

  it("propagates a workflow failure instead of swallowing it", async () => {
    const failure = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] SKU resolves to more than one variant"
    )
    workflowRun.mockRejectedValueOnce(failure)
    const res = makeRes()

    await expect(POST(makeReq({ fulfillment_id: "ful_1" }), res)).rejects.toBe(failure)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/admin/ongoing/orders`
Expected: FAIL — `Cannot find module '../route'` for the `repush` suite (Task 1's `sync` suite still passes).

- [ ] **Step 3: Implement the route**

Create `src/api/admin/ongoing/orders/[orderId]/repush/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { pushOrderToOngoing } from "../../../../../../workflows"

export type RepushRequestBody = { fulfillment_id?: unknown }

export async function POST(
  req: MedusaRequest<RepushRequestBody>,
  res: MedusaResponse
): Promise<void> {
  const fulfillmentId = req.body?.fulfillment_id

  if (typeof fulfillmentId !== "string" || fulfillmentId.trim().length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] fulfillment_id is required to re-push an order to Ongoing"
    )
  }

  const { result } = await pushOrderToOngoing(req.scope).run({
    input: { fulfillment_id: fulfillmentId },
  })

  res.status(200).json({
    ongoing_order_id: result.ongoingOrderId,
    ongoing_order_number: result.orderNumber,
  })
}
```

Notes the implementer must honour:
- **Do not wrap the `pushOrderToOngoing(...).run(...)` call in try/catch.** Letting it reject lets Medusa's error middleware convert the underlying `MedusaError`/`OngoingApiError` into the correct HTTP status; the route's job is validation + delegation, not error translation. (`push-order-record-sync.ts` already records the failure on the `OngoingOrderSync` row before re-throwing — the GET route's next poll will show it.)
- `req.params.orderId` is accepted by the route (needed for the URL shape / future authorization-by-order checks) but is **not otherwise used** in this handler — the re-push is entirely keyed by `fulfillment_id` from the body, matching `PushOrderToOngoingInput`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/api/admin/ongoing/orders`
Expected: PASS — both `sync` and `repush` suites (11 cases total).

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test`
Expected: all suites pass (existing lib/module/workflow/subscriber/webhook suites + the two new route suites).

---

## Task 3: Order detail widget

Renders one card per `OngoingOrderSync` row on the order detail page's side-before zone: Ongoing order number, status badge, status code/text, per-parcel tracking, last error, and a state-aware re-push/retry button. Hidden entirely (`return null`) when there are no sync rows for the order (e.g. no fulfillment has been created yet).

**Files:**
- Create (only if absent — owned by #40; see constraint above): `src/admin/lib/sdk.ts`
- Create: `src/admin/widgets/ongoing-order-sync.tsx`

- [ ] **Step 1: Ensure `src/admin/lib/sdk.ts` exists**

Check first: if `src/admin/lib/sdk.ts` already exists in this branch (e.g. #40 merged first), **skip this step and just import from it** — do not edit it. Otherwise create it, **byte-for-byte identical to the canonical text below** (#42 is not blocked-by #40, so both land in the same wave and both add this file — a divergent body causes an add/add merge conflict; this exact text is #40's owned canonical version):

```ts
import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})
```

- [ ] **Step 2: Create the widget**

Create `src/admin/widgets/ongoing-order-sync.tsx`:

```tsx
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/sdk"

type OngoingSyncState = "pending" | "sent" | "shipped" | "cancelled" | "error"

type OngoingOrderSyncTracking = {
  tracking_number: string
  tracking_url: string | null
}

type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: OngoingSyncState
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | null
  last_error: string | null
  retry_count: number
  tracking: OngoingOrderSyncTracking[]
}

type SyncResponse = { syncs: OngoingOrderSyncRow[] }

type RepushResponse = { ongoing_order_id: number; ongoing_order_number: string }

const STATE_BADGE_COLOR: Record<
  OngoingSyncState,
  "grey" | "blue" | "green" | "red" | "orange"
> = {
  pending: "grey",
  sent: "blue",
  shipped: "green",
  cancelled: "grey",
  error: "red",
}

const queryKeyFor = (orderId: string) => ["ongoing", "order-sync", orderId]

function RepushButton({ orderId, sync }: { orderId: string; sync: OngoingOrderSyncRow }) {
  const queryClient = useQueryClient()
  const fulfillmentId = sync.medusa_fulfillment_id

  const mutation = useMutation<RepushResponse, Error, string>({
    mutationFn: (fulfillment_id) =>
      sdk.client.fetch<RepushResponse>(`/admin/ongoing/orders/${orderId}/repush`, {
        method: "POST",
        body: { fulfillment_id },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyFor(orderId) })
    },
  })

  const terminalState = sync.sync_state === "shipped" || sync.sync_state === "cancelled"
  const disabled = !fulfillmentId || terminalState || mutation.isPending
  const label = sync.sync_state === "error" ? "Retry" : "Re-push"

  return (
    <Button
      size="small"
      variant="secondary"
      disabled={disabled}
      isLoading={mutation.isPending}
      onClick={() => fulfillmentId && mutation.mutate(fulfillmentId)}
    >
      {label}
    </Button>
  )
}

const OngoingOrderSyncWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const { data: response } = useQuery<SyncResponse>({
    queryKey: queryKeyFor(data.id),
    queryFn: () => sdk.client.fetch<SyncResponse>(`/admin/ongoing/orders/${data.id}/sync`),
  })

  const syncs = response?.syncs ?? []

  if (syncs.length === 0) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Ongoing Warehouse</Heading>
      </div>
      {syncs.map((sync) => (
        <div key={sync.id} className="flex flex-col gap-y-2 px-6 py-4">
          <div className="flex items-center justify-between">
            <Text size="small" weight="plus">
              {sync.ongoing_order_number}
            </Text>
            <Badge color={STATE_BADGE_COLOR[sync.sync_state]}>{sync.sync_state}</Badge>
          </div>

          <Text size="small" className="text-ui-fg-subtle">
            Status: {sync.latest_status_text ?? "—"}
            {sync.latest_status_code != null ? ` (${sync.latest_status_code})` : ""}
          </Text>

          <Text size="small" className="text-ui-fg-subtle">
            Last synced: {sync.last_synced_at ? new Date(sync.last_synced_at).toLocaleString() : "—"}
          </Text>

          {sync.tracking.length > 0 && (
            <div className="flex flex-col gap-y-1">
              {sync.tracking.map((t) => (
                <Text size="small" key={t.tracking_number}>
                  Tracking:{" "}
                  {t.tracking_url ? (
                    <a href={t.tracking_url} target="_blank" rel="noreferrer">
                      {t.tracking_number}
                    </a>
                  ) : (
                    t.tracking_number
                  )}
                </Text>
              ))}
            </div>
          )}

          {sync.last_error && (
            <Text size="small" className="text-ui-fg-error">
              {sync.last_error}
            </Text>
          )}

          <div className="flex justify-end">
            <RepushButton orderId={data.id} sync={sync} />
          </div>
        </div>
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default OngoingOrderSyncWidget
```

Notes the implementer must honour:
- **Row type is deliberately duplicated here, not imported from `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`.** The admin bundle (`src/admin/tsconfig.json`, `moduleResolution: "bundler"`) and the server bundle (root `tsconfig.json`, `Node16`) are compiled/bundled separately; keeping the widget's DTO local avoids pulling a server-route file into the admin Vite bundle.
- Button label/disabled logic matches the baked-in decision exactly: `"Retry"` iff `sync_state === "error"`, else `"Re-push"`; **disabled** when `sync_state` is `"shipped"` or `"cancelled"`, or (defensive addition beyond the baked decision — a sync row's `medusa_fulfillment_id` can theoretically be `null`, which `pushOrderToOngoing` cannot accept) when `medusa_fulfillment_id` is `null`.
- No edit-blocked banner, no dashboard aggregation, no `ongoing.sync.*` subscription — all out of scope per the header.

- [ ] **Step 3: Type-check and build**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: no TypeScript errors — this is the **actual** type-gate for the widget (`yarn build`/`medusa plugin:build` excludes `src/admin` from `tsc` and bundles it via Vite/esbuild without type-checking, so it would silently pass a wrong `Badge`/`Button` prop, a `DetailWidgetProps<AdminOrder>` mismatch, or an unused local under `noUnusedLocals`/`noUnusedParameters`).

Then run: `yarn build`
Expected: `medusa plugin:build` completes (server compile + admin Vite bundle, packaging/bundle check only — not a type-check for `src/admin`); `.medusa/server` includes the compiled `sync`/`repush` routes and the bundled widget.

---

## Task 4: Final verification and commit

- [ ] **Step 1: Full test suite**

Run: `yarn test`
Expected: all suites pass, including the two new route suites from Tasks 1 and 2.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: `medusa lint` (eslint flat config, `@medusajs/eslint-plugin` recommended) reports no errors on the new files.

- [ ] **Step 3: Admin type-gate, then build**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: no TypeScript errors (repeats Task 3 Step 3's type-gate as a final confirmation).

Then run: `yarn build`
Expected: `medusa plugin:build` succeeds (server compile + admin bundle), per Task 3 Step 3.

- [ ] **Step 4: Commit**

```bash
git add src/api/admin/ongoing/orders src/admin/widgets/ongoing-order-sync.tsx
# only if Task 3 Step 1 created it:
git add src/admin/lib/sdk.ts
git commit -m "feat(ongoing-admin): order detail widget + re-push route (#42)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (§10, §8):** "Ongoing order number/id, current status code/text, tracking (parcels), last sync/error, re-push / retry button" — all rendered by the widget in Task 3, sourced from the GET route in Task 1: order number/id and status code/text in the header/status line, tracking in the per-parcel list, `last_synced_at` in its own "Last synced: …" line and `last_error` in the error line, and the re-push/retry button via `RepushButton`. Multi-parcel tracking (spec §6 "Handles multiple parcel tracking numbers") is satisfied by mapping `fulfillment.labels[]` (N labels → N `tracking[]` entries), verified by the "multi-parcel" and "dedupe" test cases in Task 1.
- **#91 deferral is explicit**, not implied: called out in the "Out of scope" header with the exact code citation (`order-edit-confirmed.ts:75-84`) showing `ongoing.sync.edit_blocked` is an emitted-only event today.
- **Ownership map respected:** `src/admin/lib/sdk.ts` created only if absent, byte-identical; `@medusajs/js-sdk` not added to `package.json`; no touch to `page.tsx`/settings/integration CRUD/test-connection; no `ongoing.sync.*` emission; routes live under a path (`/admin/ongoing/orders/...`) distinct from #40's tree.
- **`retryFailedSyncs` is never called from a route** — the button always calls `pushOrderToOngoing` directly (Task 2), matching the explicit baked-in instruction that the job is not route-callable.
- **Real symbols only, all verified against `node_modules` or existing source, no placeholders:** `OngoingOrderSync` fields (`models/order-sync.ts:3-22`), `recordSync` upsert-and-self-heal (`service.ts:63-78`, `push-order-record-sync.ts:34-42`), `PushOrderToOngoingInput`/`Output` (`push-order-to-ongoing.ts:8-9`), `pushOrderToOngoing` barrel export (`workflows/index.ts:7`), `ONGOING_MODULE` (`modules/ongoing/index.ts:5`), `query.graph` shape (`re-query-fulfillment-order.ts:37-62`), `DetailWidgetProps`/`AdminOrder` (`@medusajs/types/dist/admin/extensions.d.ts:25`, re-exported by `@medusajs/framework/types`), `"order.details.side.before"` zone (`@medusajs/admin-shared/dist/index.d.ts:63`), `ContainerRegistrationKeys.QUERY = "query"` (`@medusajs/utils/dist/common/container.d.ts:7`), `@medusajs/ui` `Badge`/`Button` prop unions (installed `.d.ts` files), `@tanstack/react-query@5.64.2` v5 object-form hooks, `@medusajs/js-sdk` `Client.fetch<T>` (`dist/client.d.ts:43`).
- **Import-depth arithmetic verified with `node -e "path.relative(...)"`**, not eyeballed: both `../../../../../../modules/ongoing` and `../../../../../../workflows` (6 levels) from `src/api/admin/ongoing/orders/[orderId]/{sync,repush}/route.ts` itself, **and separately** the one-level-deeper `../../../../../../../workflows` (7 levels) used by the `jest.mock(...)` call in `repush/__tests__/route.test.ts` (the `__tests__` directory nests one level below `route.ts`) — both depths verified independently, not assumed equal.
- **TDD honoured for both routes**: each has a Step 1 (write failing tests) / Step 2 (run, confirm fail on missing module) / Step 3 (implement) / Step 4 (run, confirm pass) cycle. The widget is explicitly scoped out of TDD per `docs/superpowers/process.md`'s "pure scaffolding" exemption and is instead gated by `npx tsc -p src/admin/tsconfig.json --noEmit` (the real type-gate — `yarn build`/`medusa plugin:build` excludes `src/admin` from `tsc` and bundles it via Vite/esbuild without type-checking) plus `yarn build` as the separate packaging/bundle check, consistent with this repo having no jsdom/React Testing Library setup (`jest.config.js` `testEnvironment: "node"`).
- **Medusa rules honoured:** `POST`-only mutation route (no PUT/PATCH); module isolation (routes use only `ONGOING_MODULE`'s resolved service, `query.graph`, and the `pushOrderToOngoing` workflow — no repository reach-around); `MedusaError` (not generic `Error`) for the validation failure; the POST route does not catch-and-swallow the workflow's own error (lets Medusa's error middleware translate it); both route handlers are `async` named exports mirroring `src/api/ongoing/webhooks/[credentialKey]/route.ts`'s directly-unit-testable discipline.
- **Known, called-out non-fix:** `apply-order-shipment.ts:36-40` always writes `tracking_url: ""` on shipment labels today; the GET route and widget both already degrade gracefully (`|| null` / plain-text fallback) rather than "fixing" that upstream behavior, which is explicitly out of scope for #42.
- **Flagged verify-at-implementation item:** the `labels.tracking_number`/`labels.tracking_url` `query.graph` field path on `fulfillment` has not been exercised against a live Medusa 2.16.0 instance in this research pass; Task 1 Step 3 calls this out for the implementer to confirm during a dev run.
- **Real test commands:** `yarn test src/api/admin/ongoing/orders` (jest `roots: <rootDir>/src`, `testMatch **/__tests__/**/*.test.ts`, substring `testPathPattern` match — same invocation style as the existing `yarn test src/api/ongoing/webhooks/` precedent); full suite `yarn test`; gates `yarn lint`, `npx tsc -p src/admin/tsconfig.json --noEmit` (widget type-gate), `yarn build` (packaging/bundle check).
- **No forbidden tokens** — every code block above is complete (no `TODO`/`TBD`/`FIXME`/elisions); the two "verify at implementation" notes are prose call-outs about live-environment confirmation, not unresolved plan gaps.

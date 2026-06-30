# Ongoing Status Poll Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a once-a-minute Medusa scheduled job that, per enabled Ongoing integration on its own `status_poll_interval`, sweeps Ongoing's active orders via `GetOrdersByQuery`, refreshes `latest_status_code`/`latest_status_text` on tracked sync rows (for edit-gating), and routes newly-shipped orders to the idempotent `syncOngoingShipmentWorkflow` (#33).

**Architecture:** One job file `src/jobs/status-poll.ts` exporting a default dispatcher `ongoingStatusPollJob(container)` plus a `config` (`{ name, schedule }`). The dispatcher runs every minute and is itself the cadence gate: it lists enabled integrations and, per integration, computes whether the integration is *due* (`now - last_status_poll_at >= interval`), takes a best-effort advisory lock (`acquireSyncLock`), polls Ongoing once with that integration's credentials, cross-references the result against this integration's non-terminal `OngoingOrderSync` rows, writes the latest status onto matched rows, and invokes `syncOngoingShipmentWorkflow` only for in-band-and-not-yet-shipped orders. The job **never rethrows** — each integration is wrapped so one failure cannot kill the tick — and always releases the lock + advances the cadence in a `finally`. Three new `OngoingModuleService` methods (`acquireSyncLock`, `releaseSyncLock`, `getDefaultStatusPollIntervalMs`) back the lock/cadence, plus a one-line `OngoingClient.getOrdersByStatus` fix to send an explicit `pageSize`.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests (already wired: `jest.config.js`, `yarn test`).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes); import the constant `ONGOING_MODULE` from `src/modules/ongoing/index.ts`.
- A scheduled job exports a default async `handler(container: MedusaContainer)` plus `export const config = { name, schedule }` (Medusa v2 jobs API; see `src/jobs/README.md`).
- Mutations that touch core Medusa data go through workflows; this job mutates only the **plugin's own** `OngoingOrderSync`/`OngoingIntegration` rows (via the module service's auto-CRUD) and delegates the one core-data mutation (mark fulfillment shipped) to `syncOngoingShipmentWorkflow` (#33). **Module isolation:** the job resolves only the `ongoing` module service + that one workflow — no cross-module service calls.
- Service methods that do DB I/O are **async**; the one pure in-memory accessor (`getDefaultStatusPollIntervalMs`) carries the same `// eslint-disable-next-line @medusajs/service-methods-must-be-async` comment used by `getCredentials`/`getClient` in `src/modules/ongoing/service.ts`.
- **Interval string format (locked):** milliseconds as an integer string (e.g. `"300000"`); parse with `parseInt(v, 10)`. No `ms`/duration dependency.
- The job handler **never throws**: catch + log per integration so one warehouse's failure does not abort the tick. The lock is **always** released in a `finally`.
- `sync_lock_until` already exists on the `ongoing_integration` model + its migration (`src/modules/ongoing/models/integration.ts:19`, `Migration20260623211927.ts`) — **NO new migration**.
- Plugin build output is `.medusa/server`; verify the plugin compiles with **`yarn build`**.
- Tests are **pure unit tests** (mock the module service, the Ongoing client, and the workflow); there is no local Postgres/Medusa instance wired in this plugin.

---

## File Structure

**Create:**
- `src/jobs/status-poll.ts` — the dispatcher job: default `ongoingStatusPollJob` handler + `config`, plus private helpers (`resolveIntervalMs`, `isDue`, `pollIntegration`, `pollAndApply`).
- `src/jobs/__tests__/status-poll.test.ts` — unit tests for the dispatcher (mocked service + client + workflow).
- `src/modules/ongoing/__tests__/sync-lock.test.ts` — unit tests for the three new service methods.
- `src/lib/ongoing/__tests__/client.orders-by-status.test.ts` — unit test for the `getOrdersByStatus` URL + mapping.

**Modify:**
- `src/modules/ongoing/service.ts` — add `acquireSyncLock`, `releaseSyncLock`, `getDefaultStatusPollIntervalMs`.
- `src/lib/ongoing/client.ts:104-112` — `getOrdersByStatus` sends an explicit `pageSize` query param so the paginate sentinel matches the server page size.

**Depends on (must already exist):**
- `src/modules/ongoing/index.ts` — exports `ONGOING_MODULE = "ongoing"` (exists).
- `src/modules/ongoing/service.ts` — `OngoingModuleService` with auto-CRUD `listOngoingIntegrations`, `retrieveOngoingIntegration`, `updateOngoingIntegrations`, `listOngoingOrderSyncs`, `updateOngoingOrderSyncs`, plus `getClient(credentialKey)` and the protected `this.options_` (exists).
- `src/lib/ongoing/client.ts` — `OngoingClient.getOrdersByStatus(from, to): Promise<OngoingTrackedOrder[]>` (exists; modified in Task 1).
- `src/lib/ongoing/types.ts` — `OngoingTrackedOrder = { ongoingOrderId; orderNumber; statusNumber; statusText; trackingNumbers }` (exists, lines 37-43).
- `src/workflows/index.ts` (barrel) — **`syncOngoingShipmentWorkflow`** (**#33 — dependency, must be merged first**), invoked as `syncOngoingShipmentWorkflow(container).run({ input })`.

**Consumed interface from #33 (`syncOngoingShipmentWorkflow`) — call EXACTLY this:**
- Import: `import { syncOngoingShipmentWorkflow } from "../workflows"` (barrel `src/workflows/index.ts`).
- Invocation: `syncOngoingShipmentWorkflow(container).run({ input: { ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] } })`.
- Called **once per polled order that is in-band-and-not-yet-shipped** (status code ∈ `shipped_status_codes` AND the matched sync row's `shipped_at` is `null`). The workflow's own load-step re-checks `shipped_at` idempotency, so a redundant call is a safe no-op.

---

## Task 1: `OngoingClient.getOrdersByStatus` sends an explicit `pageSize`

`paginate` stops when a page returns fewer than `ONGOING_PAGE_SIZE` (50) rows (`src/lib/ongoing/client.ts:138`). `getOrdersByStatus` currently omits `pageSize` from the query, so the sentinel is only correct if Ongoing's *default* page size happens to be 50. Send `pageSize` explicitly so the request and the sentinel agree.

**Files:**
- Modify: `src/lib/ongoing/client.ts:104-112`
- Test: `src/lib/ongoing/__tests__/client.orders-by-status.test.ts`

**Interfaces:**
- Consumes: `OngoingCredentials` from `../types`; the private module const `ONGOING_PAGE_SIZE = 50` (`src/lib/ongoing/client.ts:146`).
- Produces: `OngoingClient.getOrdersByStatus(from: number, to: number): Promise<OngoingTrackedOrder[]>` (signature unchanged; URL now includes `&pageSize=50`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/client.orders-by-status.test.ts`:
```ts
import { OngoingClient } from "../client"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "wh-a",
  baseUrl: "https://api.example.test/api/v1",
  username: "u",
  password: "p",
  goodsOwnerId: 7,
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("OngoingClient.getOrdersByStatus", () => {
  it("requests the status range with an explicit pageSize and maps tracked orders", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      json([
        {
          orderInfo: {
            orderId: 555,
            orderNumber: "1001-abc",
            orderStatus: { number: 400, text: "Sent" },
          },
          parcels: [
            { parcelTracking: { code: "TRACK1" } },
            { trackingNumber: "TRACK2" },
          ],
        },
      ])
    )
    const client = new OngoingClient(creds, { fetchImpl })

    const orders = await client.getOrdersByStatus(100, 999)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain("/orders?goodsOwnerId=7")
    expect(url).toContain("orderStatusFrom=100")
    expect(url).toContain("orderStatusTo=999")
    expect(url).toContain("pageSize=50")
    expect(orders).toEqual([
      {
        ongoingOrderId: 555,
        orderNumber: "1001-abc",
        statusNumber: 400,
        statusText: "Sent",
        trackingNumbers: ["TRACK1", "TRACK2"],
      },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.orders-by-status.test.ts`
Expected: FAIL on `expect(url).toContain("pageSize=50")` — the current URL has no `pageSize` param (the mapping assertions already pass).

- [ ] **Step 3: Add `pageSize` to the request URL**

In `src/lib/ongoing/client.ts`, replace the `getOrdersByStatus` body (lines 104-112):
```ts
  async getOrdersByStatus(from: number, to: number): Promise<OngoingTrackedOrder[]> {
    const rows = await this.paginate((page) =>
      this.request<any[]>(
        "GET",
        `/orders?goodsOwnerId=${this.creds.goodsOwnerId}&orderStatusFrom=${from}&orderStatusTo=${to}&page=${page}&pageSize=${ONGOING_PAGE_SIZE}`
      )
    )
    return rows.map(mapTrackedOrder)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.orders-by-status.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the existing client suite to confirm no regression**

Run: `yarn test src/lib/ongoing`
Expected: all client/lib suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.orders-by-status.test.ts
git commit -m "fix(ongoing-client): send explicit pageSize on getOrdersByStatus (#34)"
```

---

## Task 2: `OngoingModuleService` lock + default-interval methods

Add the advisory lock and default-interval accessor the dispatcher relies on. `acquireSyncLock` is a best-effort advisory lock (read-then-write, fine for a single-instance cron); true atomicity would need a conditional UPDATE and is out of scope. `sync_lock_until` already exists on the model + migration.

**Files:**
- Modify: `src/modules/ongoing/service.ts` (add three methods inside the `OngoingModuleService` class).
- Test: `src/modules/ongoing/__tests__/sync-lock.test.ts`

**Interfaces:**
- Consumes (auto-CRUD generated by `MedusaService({ OngoingIntegration, OngoingOrderSync })`): `retrieveOngoingIntegration(id: string): Promise<{ id: string; sync_lock_until: Date | null }>`, `updateOngoingIntegrations(data: { id: string; sync_lock_until: Date | null }): Promise<unknown>`; the protected `this.options_: OngoingPluginOptions` (has optional `defaultStatusPollInterval?: string`, see `src/lib/ongoing/types.ts:13`).
- Produces:
  - `acquireSyncLock(integrationId: string, ttlMs: number): Promise<boolean>` — `false` if the current `sync_lock_until` is still in the future; otherwise stamps `sync_lock_until = now + ttlMs` and returns `true`.
  - `releaseSyncLock(integrationId: string): Promise<void>` — sets `sync_lock_until = null`.
  - `getDefaultStatusPollIntervalMs(): number` — `parseInt(this.options_.defaultStatusPollInterval ?? "60000", 10)`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/ongoing/__tests__/sync-lock.test.ts`:
```ts
import OngoingModuleService from "../service"

const baseIntegrations = [
  { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
]

// Build a service with the auto-CRUD methods this task uses stubbed (no DB).
function makeService(options: Record<string, unknown> = {}) {
  const svc = new OngoingModuleService({} as any, {
    integrations: baseIntegrations,
    ...options,
  } as any)
  ;(svc as any).retrieveOngoingIntegration = jest.fn()
  ;(svc as any).updateOngoingIntegrations = jest.fn().mockResolvedValue({})
  return svc
}

describe("OngoingModuleService sync lock + default interval", () => {
  describe("getDefaultStatusPollIntervalMs", () => {
    it("parses the configured interval string into a number of ms", () => {
      const svc = makeService({ defaultStatusPollInterval: "300000" })
      expect(svc.getDefaultStatusPollIntervalMs()).toBe(300000)
    })

    it("falls back to 60000 when no default interval is configured", () => {
      const svc = makeService()
      expect(svc.getDefaultStatusPollIntervalMs()).toBe(60000)
    })
  })

  describe("acquireSyncLock", () => {
    it("acquires and stamps sync_lock_until when no lock is held", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: null,
      })

      const before = Date.now()
      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(true)
      const update = (svc as any).updateOngoingIntegrations.mock.calls[0][0]
      expect(update.id).toBe("int_1")
      expect(update.sync_lock_until).toBeInstanceOf(Date)
      expect((update.sync_lock_until as Date).getTime()).toBeGreaterThanOrEqual(before + 60000)
    })

    it("refuses the lock when sync_lock_until is still in the future", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() + 30000),
      })

      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(false)
      expect((svc as any).updateOngoingIntegrations).not.toHaveBeenCalled()
    })

    it("acquires when a previously held lock has already expired", async () => {
      const svc = makeService()
      ;(svc as any).retrieveOngoingIntegration.mockResolvedValue({
        id: "int_1",
        sync_lock_until: new Date(Date.now() - 1000),
      })

      const got = await svc.acquireSyncLock("int_1", 60000)

      expect(got).toBe(true)
      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledTimes(1)
    })
  })

  describe("releaseSyncLock", () => {
    it("clears sync_lock_until", async () => {
      const svc = makeService()

      await svc.releaseSyncLock("int_1")

      expect((svc as any).updateOngoingIntegrations).toHaveBeenCalledWith({
        id: "int_1",
        sync_lock_until: null,
      })
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/modules/ongoing/__tests__/sync-lock.test.ts`
Expected: FAIL — `svc.getDefaultStatusPollIntervalMs`, `svc.acquireSyncLock`, and `svc.releaseSyncLock` are not functions / do not exist on the service.

- [ ] **Step 3: Implement the three methods**

In `src/modules/ongoing/service.ts`, add these methods inside the `OngoingModuleService` class body (place them after `recordSync`, before the closing brace `}` of the class on line 79):
```ts
  // Pure synchronous config accessor (parses an in-memory option, no I/O) — kept
  // sync on purpose, same rationale as getCredentials/getClient above.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  getDefaultStatusPollIntervalMs(): number {
    return parseInt(this.options_.defaultStatusPollInterval ?? "60000", 10)
  }

  // Best-effort advisory lock so two ticks can't poll the same integration at
  // once. Read-then-write is fine for a single-instance cron; the TTL is a crash
  // safety net (the dispatcher also releases it in a finally).
  async acquireSyncLock(integrationId: string, ttlMs: number): Promise<boolean> {
    const integration = await this.retrieveOngoingIntegration(integrationId)
    const lockedUntil = integration?.sync_lock_until
      ? new Date(integration.sync_lock_until).getTime()
      : 0
    if (lockedUntil > Date.now()) {
      return false
    }
    await this.updateOngoingIntegrations({
      id: integrationId,
      sync_lock_until: new Date(Date.now() + ttlMs),
    })
    return true
  }

  async releaseSyncLock(integrationId: string): Promise<void> {
    await this.updateOngoingIntegrations({ id: integrationId, sync_lock_until: null })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/modules/ongoing/__tests__/sync-lock.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full module suite to confirm no regression**

Run: `yarn test src/modules/ongoing`
Expected: all module suites PASS (existing `options`/`record-sync` suites + the new `sync-lock` suite).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ongoing/service.ts src/modules/ongoing/__tests__/sync-lock.test.ts
git commit -m "feat(ongoing-module): advisory sync lock + default status-poll interval accessor (#34)"
```

---

## Task 3: Status-poll dispatcher job

The dispatcher runs every minute and gates per-integration cadence itself. For each enabled integration: resolve interval, skip if not due, take the lock (skip if held), poll Ongoing once, refresh matched non-terminal rows, ship in-band-not-yet-shipped orders via `syncOngoingShipmentWorkflow` (#33), then always stamp `last_status_poll_at` + release the lock in a `finally`. One integration's error is logged and swallowed.

**Files:**
- Create: `src/jobs/status-poll.ts`
- Test: `src/jobs/__tests__/status-poll.test.ts`

**Interfaces:**
- Consumes:
  - `ONGOING_MODULE` (`"ongoing"`) from `../modules/ongoing`.
  - `ContainerRegistrationKeys.LOGGER` from `@medusajs/framework/utils`; `MedusaContainer` from `@medusajs/framework/types`.
  - `OngoingModuleService` methods: `listOngoingIntegrations({ enabled: true })`, `getClient(credentialKey)`, `getDefaultStatusPollIntervalMs()`, `acquireSyncLock(id, ttlMs)`, `releaseSyncLock(id)`, `listOngoingOrderSyncs({ integration_id })`, `updateOngoingOrderSyncs({ id, latest_status_code, latest_status_text, last_synced_at })`, `updateOngoingIntegrations({ id, last_status_poll_at })`.
  - `OngoingClient.getOrdersByStatus(from, to): Promise<OngoingTrackedOrder[]>` (Task 1).
  - `syncOngoingShipmentWorkflow(container).run({ input: { ongoing_order_number: string; status_code: number; status_text: string; tracking_numbers: string[] } })` from `../workflows` (**#33**).
- Produces:
  - Default export `async function ongoingStatusPollJob(container: MedusaContainer): Promise<void>` — never throws.
  - `export const config = { name: "ongoing-status-poll", schedule: "* * * * *" }`.

- [ ] **Step 1: Write the failing tests**

The job imports `syncOngoingShipmentWorkflow` from the `../workflows` barrel; we `jest.mock` that path so the test is pure and so it runs even before #33 has populated the barrel (the factory resolves a non-existent named export). The Ongoing client and the module service are plain mocks.

Create `src/jobs/__tests__/status-poll.test.ts`:
```ts
import type { MedusaContainer } from "@medusajs/framework/types"

// Mock the #33 workflow (barrel): named export is a factory (container) => { run }.
const run = jest.fn().mockResolvedValue({ result: {} })
jest.mock("../../workflows", () => ({
  __esModule: true,
  syncOngoingShipmentWorkflow: jest.fn(() => ({ run })),
}))

import ongoingStatusPollJob, { config } from "../status-poll"

type TrackedOrder = {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
}

type Integration = {
  id: string
  credential_key: string
  enabled: boolean
  status_poll_interval: string | null
  last_status_poll_at: Date | null
  shipped_status_codes: number[] | null
}

type Row = {
  id: string
  integration_id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | null
}

function makeHarness(opts: {
  integrations: Integration[]
  rowsByIntegration?: Record<string, Row[]>
  ordersByKey?: Record<string, TrackedOrder[]>
  getOrdersImpl?: (credentialKey: string) => Promise<TrackedOrder[]>
  acquireImpl?: (id: string, ttlMs: number) => Promise<boolean>
  defaultIntervalMs?: number
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }

  const clients: Record<string, { getOrdersByStatus: jest.Mock }> = {}
  for (const integ of opts.integrations) {
    clients[integ.credential_key] = {
      getOrdersByStatus: jest.fn(async () =>
        opts.getOrdersImpl
          ? opts.getOrdersImpl(integ.credential_key)
          : opts.ordersByKey?.[integ.credential_key] ?? []
      ),
    }
  }

  const service = {
    listOngoingIntegrations: jest.fn(async () => opts.integrations),
    getClient: jest.fn((key: string) => clients[key]),
    getDefaultStatusPollIntervalMs: jest.fn(() => opts.defaultIntervalMs ?? 60000),
    acquireSyncLock: jest.fn(opts.acquireImpl ?? (async () => true)),
    releaseSyncLock: jest.fn(async () => undefined),
    listOngoingOrderSyncs: jest.fn(
      async ({ integration_id }: { integration_id: string }) =>
        opts.rowsByIntegration?.[integration_id] ?? []
    ),
    updateOngoingOrderSyncs: jest.fn(async () => ({})),
    updateOngoingIntegrations: jest.fn(async () => ({})),
  }

  const container = {
    resolve: jest.fn((key: string) => (key === "logger" ? logger : service)),
  } as unknown as MedusaContainer

  return { container, service, logger, clients }
}

const integ = (over: Partial<Integration> = {}): Integration => ({
  id: "int_1",
  credential_key: "wh-a",
  enabled: true,
  status_poll_interval: "60000",
  last_status_poll_at: null,
  shipped_status_codes: [400],
  ...over,
})

describe("ongoing status-poll job", () => {
  it("registers the dispatcher to run once a minute", () => {
    expect(config).toEqual({ name: "ongoing-status-poll", schedule: "* * * * *" })
  })

  it("skips a locked integration without polling or releasing", async () => {
    const h = makeHarness({ integrations: [integ()], acquireImpl: async () => false })

    await ongoingStatusPollJob(h.container)

    expect(h.service.acquireSyncLock).toHaveBeenCalledWith("int_1", 60000)
    expect(h.clients["wh-a"].getOrdersByStatus).not.toHaveBeenCalled()
    expect(h.service.releaseSyncLock).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("skips an integration that is not due yet", async () => {
    const notDue = integ({
      status_poll_interval: "300000",
      last_status_poll_at: new Date(Date.now() - 1000),
    })
    const h = makeHarness({ integrations: [notDue] })

    await ongoingStatusPollJob(h.container)

    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
    expect(h.clients["wh-a"].getOrdersByStatus).not.toHaveBeenCalled()
  })

  it("polls a due integration, refreshes matched non-terminal rows, and ships only in-band not-yet-shipped orders", async () => {
    const due = integ({ last_status_poll_at: new Date(Date.now() - 120000) })
    const rows: Row[] = [
      { id: "r_open", integration_id: "int_1", ongoing_order_number: "1001-aaa", sync_state: "sent", shipped_at: null },
      { id: "r_ship_unshipped", integration_id: "int_1", ongoing_order_number: "1001-bbb", sync_state: "sent", shipped_at: null },
      { id: "r_ship_already", integration_id: "int_1", ongoing_order_number: "1001-ccc", sync_state: "sent", shipped_at: new Date() },
      { id: "r_terminal", integration_id: "int_1", ongoing_order_number: "1001-ddd", sync_state: "shipped", shipped_at: new Date() },
    ]
    const orders: TrackedOrder[] = [
      { ongoingOrderId: 1, orderNumber: "1001-aaa", statusNumber: 200, statusText: "Open", trackingNumbers: [] },
      { ongoingOrderId: 2, orderNumber: "1001-bbb", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T1", "T2"] },
      { ongoingOrderId: 3, orderNumber: "1001-ccc", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T3"] },
      { ongoingOrderId: 4, orderNumber: "1001-ddd", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T4"] },
      { ongoingOrderId: 9, orderNumber: "9999-zzz", statusNumber: 400, statusText: "Sent", trackingNumbers: ["T9"] },
    ]
    const h = makeHarness({
      integrations: [due],
      rowsByIntegration: { int_1: rows },
      ordersByKey: { "wh-a": orders },
    })

    await ongoingStatusPollJob(h.container)

    // Every matched non-terminal row gets its latest status refreshed.
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "r_open", latest_status_code: 200, latest_status_text: "Open", last_synced_at: expect.any(Date),
    })
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "r_ship_unshipped", latest_status_code: 400, latest_status_text: "Sent", last_synced_at: expect.any(Date),
    })
    expect(h.service.updateOngoingOrderSyncs).toHaveBeenCalledWith({
      id: "r_ship_already", latest_status_code: 400, latest_status_text: "Sent", last_synced_at: expect.any(Date),
    })
    // Terminal row (sync_state "shipped") and the untracked order are ignored.
    const updatedIds = h.service.updateOngoingOrderSyncs.mock.calls.map((c) => c[0].id)
    expect(updatedIds).toHaveLength(3)
    expect(updatedIds).not.toContain("r_terminal")

    // Shipment workflow only for the shipped-code + not-yet-shipped row.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "1001-bbb",
        status_code: 400,
        status_text: "Sent",
        tracking_numbers: ["T1", "T2"],
      },
    })

    // Cadence advanced + lock released.
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_status_poll_at: expect.any(Date),
    })
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
  })

  it("releases the lock, advances cadence, and never throws when the poll fails", async () => {
    const h = makeHarness({
      integrations: [integ()],
      getOrdersImpl: async () => {
        throw new Error("ongoing 503")
      },
    })

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_1")
    expect(h.service.updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "int_1",
      last_status_poll_at: expect.any(Date),
    })
    expect(h.logger.error).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("never throws and does no work when listing integrations fails", async () => {
    const h = makeHarness({ integrations: [] })
    ;(h.service.listOngoingIntegrations as jest.Mock).mockRejectedValue(new Error("db down"))

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.acquireSyncLock).not.toHaveBeenCalled()
  })

  it("does not let one integration's failure stop the others", async () => {
    const a = integ({ id: "int_a", credential_key: "wh-a" })
    const b = integ({ id: "int_b", credential_key: "wh-b" })
    const rowsB: Row[] = [
      { id: "rb", integration_id: "int_b", ongoing_order_number: "2001-bbb", sync_state: "sent", shipped_at: null },
    ]
    const ordersB: TrackedOrder[] = [
      { ongoingOrderId: 5, orderNumber: "2001-bbb", statusNumber: 400, statusText: "Sent", trackingNumbers: ["TB"] },
    ]
    const h = makeHarness({
      integrations: [a, b],
      rowsByIntegration: { int_b: rowsB },
      ordersByKey: { "wh-b": ordersB },
      getOrdersImpl: (key) =>
        key === "wh-a" ? Promise.reject(new Error("boom")) : Promise.resolve(ordersB),
    })

    await expect(ongoingStatusPollJob(h.container)).resolves.toBeUndefined()

    expect(h.logger.error).toHaveBeenCalled()
    expect(h.service.releaseSyncLock).toHaveBeenCalledWith("int_b")
    expect(run).toHaveBeenCalledWith({
      input: {
        ongoing_order_number: "2001-bbb",
        status_code: 400,
        status_text: "Sent",
        tracking_numbers: ["TB"],
      },
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/jobs/__tests__/status-poll.test.ts`
Expected: FAIL — cannot find module `../status-poll`. (The `jest.mock("../../workflows", …)` factory resolves even though #33 has not yet added `syncOngoingShipmentWorkflow` to the real barrel, so the only failure is the missing job file.)

- [ ] **Step 3: Implement the dispatcher job**

Create `src/jobs/status-poll.ts`:
```ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ONGOING_MODULE } from "../modules/ongoing"
import { syncOngoingShipmentWorkflow } from "../workflows"

// Ongoing order-status sweep. Wide on purpose: the poll keeps latest_status_code
// fresh for order-edit gating AND detects shipment, so it must see every active
// order — not only shipped ones. 100 (preliminary) .. 999 spans Ongoing's active
// + shipped status range. (Spec §7.)
const ONGOING_ACTIVE_STATUS_FROM = 100
const ONGOING_ACTIVE_STATUS_TO = 999

// Sync states for which polling is finished: no further status refresh / shipment.
const TERMINAL_SYNC_STATES = new Set(["shipped", "cancelled"])

type TrackedOrder = {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
}

type OngoingClientLike = {
  getOrdersByStatus: (from: number, to: number) => Promise<TrackedOrder[]>
}

type IntegrationRow = {
  id: string
  credential_key: string
  status_poll_interval: string | null
  last_status_poll_at: Date | string | null
  shipped_status_codes: number[] | null
}

type OrderSyncRow = {
  id: string
  ongoing_order_number: string
  sync_state: string
  shipped_at: Date | string | null
}

type OngoingServiceLike = {
  listOngoingIntegrations: (filter: { enabled: boolean }) => Promise<IntegrationRow[]>
  getClient: (credentialKey: string) => OngoingClientLike
  getDefaultStatusPollIntervalMs: () => number
  acquireSyncLock: (integrationId: string, ttlMs: number) => Promise<boolean>
  releaseSyncLock: (integrationId: string) => Promise<void>
  listOngoingOrderSyncs: (filter: { integration_id: string }) => Promise<OrderSyncRow[]>
  updateOngoingOrderSyncs: (data: {
    id: string
    latest_status_code: number
    latest_status_text: string
    last_synced_at: Date
  }) => Promise<unknown>
  updateOngoingIntegrations: (data: { id: string; last_status_poll_at: Date }) => Promise<unknown>
}

type Logger = {
  info: (message: string) => void
  error: (message: string) => void
  debug?: (message: string) => void
}

function resolveIntervalMs(service: OngoingServiceLike, integration: IntegrationRow): number {
  if (integration.status_poll_interval != null) {
    const parsed = parseInt(integration.status_poll_interval, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return service.getDefaultStatusPollIntervalMs()
}

function isDue(integration: IntegrationRow, intervalMs: number, now: number): boolean {
  if (integration.last_status_poll_at == null) {
    return true
  }
  const last = new Date(integration.last_status_poll_at).getTime()
  return now - last >= intervalMs
}

async function pollAndApply(
  container: MedusaContainer,
  service: OngoingServiceLike,
  integration: IntegrationRow
): Promise<void> {
  const client = service.getClient(integration.credential_key)
  const orders = await client.getOrdersByStatus(
    ONGOING_ACTIVE_STATUS_FROM,
    ONGOING_ACTIVE_STATUS_TO
  )

  // Limit in-memory work to this integration's still-open tracked orders.
  const rows = await service.listOngoingOrderSyncs({ integration_id: integration.id })
  const tracked = new Map<string, OrderSyncRow>()
  for (const row of rows) {
    if (!TERMINAL_SYNC_STATES.has(row.sync_state)) {
      tracked.set(row.ongoing_order_number, row)
    }
  }

  const shippedCodes = Array.isArray(integration.shipped_status_codes)
    ? integration.shipped_status_codes
    : []

  for (const order of orders) {
    const row = tracked.get(order.orderNumber)
    if (!row) {
      continue
    }

    await service.updateOngoingOrderSyncs({
      id: row.id,
      latest_status_code: order.statusNumber,
      latest_status_text: order.statusText,
      last_synced_at: new Date(),
    })

    if (shippedCodes.includes(order.statusNumber) && row.shipped_at == null) {
      // #33 owns the shipped_at idempotency re-check; a redundant call is a no-op.
      await syncOngoingShipmentWorkflow(container).run({
        input: {
          ongoing_order_number: order.orderNumber,
          status_code: order.statusNumber,
          status_text: order.statusText,
          tracking_numbers: order.trackingNumbers,
        },
      })
    }
  }
}

async function pollIntegration(
  container: MedusaContainer,
  service: OngoingServiceLike,
  logger: Logger,
  integration: IntegrationRow,
  now: number
): Promise<void> {
  const intervalMs = resolveIntervalMs(service, integration)
  if (!isDue(integration, intervalMs, now)) {
    return
  }

  const acquired = await service.acquireSyncLock(integration.id, intervalMs)
  if (!acquired) {
    logger.debug?.(
      `[ongoing] status-poll: integration ${integration.id} is locked by another run, skipping`
    )
    return
  }

  try {
    await pollAndApply(container, service, integration)
  } finally {
    try {
      await service.updateOngoingIntegrations({
        id: integration.id,
        last_status_poll_at: new Date(),
      })
    } catch (error) {
      logger.error(
        `[ongoing] status-poll: failed to stamp last_status_poll_at for ${integration.id}: ${
          (error as Error).message
        }`
      )
    }
    await service.releaseSyncLock(integration.id)
  }
}

export default async function ongoingStatusPollJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const service = container.resolve(ONGOING_MODULE) as OngoingServiceLike

  let integrations: IntegrationRow[]
  try {
    integrations = await service.listOngoingIntegrations({ enabled: true })
  } catch (error) {
    logger.error(
      `[ongoing] status-poll: failed to list integrations: ${(error as Error).message}`
    )
    return
  }

  const now = Date.now()
  for (const integration of integrations) {
    try {
      await pollIntegration(container, service, logger, integration, now)
    } catch (error) {
      logger.error(
        `[ongoing] status-poll: integration ${integration.id} (${integration.credential_key}) failed: ${
          (error as Error).message
        }`
      )
      // Never rethrow: one integration's failure must not kill the tick.
    }
  }
}

export const config = {
  name: "ongoing-status-poll",
  schedule: "* * * * *",
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/jobs/__tests__/status-poll.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS (existing lib/module/workflow/subscriber suites + the three new suites from Tasks 1-3).

- [ ] **Step 6: Lint the changed files**

Run: `yarn lint`
Expected: no errors. (The `getDefaultStatusPollIntervalMs` `eslint-disable` comment keeps `@medusajs/service-methods-must-be-async` quiet; the job uses typed `*Like` interfaces, not `any`.)

- [ ] **Step 7: Build the plugin to validate it compiles**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; `.medusa/server` includes the compiled job. **If the build errors because `../workflows` does not export `syncOngoingShipmentWorkflow` (#33 not yet merged), the build is the gate that confirms the dependency: do not merge this job until #33 adds `syncOngoingShipmentWorkflow` to `src/workflows/index.ts`.**

- [ ] **Step 8: Commit**

```bash
git add src/jobs/status-poll.ts src/jobs/__tests__/status-poll.test.ts
git commit -m "feat(ongoing-jobs): per-integration status poll dispatcher (#34)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (§7 Poll job):** "per integration on its `status_poll_interval`" → `resolveIntervalMs` + `isDue` per-integration gate (Task 3, Step 3) ✓. "`GetOrdersByQuery` updates `latest_status_code`" → `updateOngoingOrderSyncs({ latest_status_code, latest_status_text, last_synced_at })` on every matched non-terminal row (the wide sweep keeps status fresh for edit-gating, not only shipment) ✓. "when the code ∈ `shipped_status_codes`, calls `syncOngoingShipment`" → guarded `syncOngoingShipmentWorkflow(container).run(...)` for `shippedCodes.includes(statusNumber) && shipped_at == null` ✓. §7 "both paths converge on the idempotent `syncOngoingShipment`, guarded by `shipped_at`" → the job passes the exact #33 contract input and relies on #33's own `shipped_at` re-check ✓.
- **Dependency contract (#33):** invoked EXACTLY as `syncOngoingShipmentWorkflow(container).run({ input: { ongoing_order_number, status_code, status_text, tracking_numbers } })`, imported from the `../workflows` barrel; `status_text` = `order.statusText`, `tracking_numbers` = `order.trackingNumbers` (Task 3 interfaces + Step 3). The test mocks the barrel so Task 3 is implementable/testable before #33 merges; `yarn build` (Step 7) is the hard gate.
- **Research facts honored:** job file `src/jobs/status-poll.ts` with default `ongoingStatusPollJob(container)` + `config = { name: "ongoing-status-poll", schedule: "* * * * *" }` ✓; dispatcher uses `listOngoingIntegrations({ enabled: true })` ✓; interval = `integration.status_poll_interval` (parsed) else `getDefaultStatusPollIntervalMs()` ✓; new service methods `acquireSyncLock`/`releaseSyncLock`/`getDefaultStatusPollIntervalMs` with NO new migration (`sync_lock_until` already on model) ✓; `client.getOrdersByStatus` now sends explicit `pageSize=ONGOING_PAGE_SIZE` ✓; wide status sweep (not shipped-only) ✓; cross-reference Map keyed by `ongoing_order_number` filtered to non-`shipped`/`cancelled` rows ✓; `last_status_poll_at` stamp + `releaseSyncLock` in `finally` ✓; never rethrows ✓; interval format = integer-ms string parsed with `parseInt(v, 10)` ✓.
- **Placeholder scan:** every code step contains complete code; no `TBD`/`TODO`/`FIXME`/"handle edge cases". The only deferred concrete value — the status sweep bounds — is pinned (`100`..`999`) with a documented rationale, and `acquireSyncLock` atomicity is explicitly scoped as best-effort.
- **Type consistency across tasks:** `OngoingTrackedOrder` field names (`ongoingOrderId`, `orderNumber`, `statusNumber`, `statusText`, `trackingNumbers`) match `src/lib/ongoing/types.ts:37-43` and are used identically in Task 1's mapping test, Task 3's `TrackedOrder` type, the `pollAndApply` loop, and every `run`/`updateOngoingOrderSyncs` assertion. `acquireSyncLock(integrationId, ttlMs): Promise<boolean>`, `releaseSyncLock(integrationId): Promise<void>`, `getDefaultStatusPollIntervalMs(): number` are defined identically in Task 2's implementation, Task 2's tests, and Task 3's `OngoingServiceLike`. The `{ ongoing_order_number, status_code, status_text, tracking_numbers }` workflow input is byte-identical in the job and in every Task 3 test expectation.
- **Module isolation / Medusa rules:** the job resolves only the `ongoing` module service + the one `../workflows` workflow — no cross-module service calls; the single core-data mutation (mark shipped) is delegated to the #33 workflow, not done inline; the one sync service method carries the `@medusajs/service-methods-must-be-async` disable used elsewhere in `service.ts`; the job never throws (try/catch per integration, lock released in `finally`).
- **Dependency note:** #33 (`syncOngoingShipmentWorkflow` exported from `src/workflows/index.ts`) must be merged before this builds; Tasks 1 and 2 are fully independent of #33 and land cleanly on their own.

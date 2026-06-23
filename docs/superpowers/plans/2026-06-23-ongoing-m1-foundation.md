# Ongoing Warehouse Plugin — Milestone 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation layer — the `ongoing` data module (models, service, links), plugin-option/credential plumbing with boot-time validation, and a typed, throttled, error-classified Ongoing REST client — so later milestones (fulfillment, inbound sync, stock sync, admin UI) have everything they consume.

**Architecture:** Pure-TS Ongoing REST client (`src/lib/ongoing/`) with no Medusa dependency, unit-tested against a mocked `fetch`. A Medusa custom module (`src/modules/ongoing/`) holds the `OngoingIntegration` and `OngoingOrderSync` data models, a service that wraps auto-CRUD plus credential/lock helpers, and a loader that validates plugin options at boot. Three module links connect sync rows and integrations to core entities. Credentials live in plugin options (sourced from env in the consuming app), never in the DB.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests, native `fetch` (Node ≥20) for HTTP.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Copy from `package.json`.
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module names MUST be **camelCase**, never dashes: module id is `"ongoing"`.
- Never add `.linkable()` to data models — it is auto-added.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100.
- Plugin build output is `.medusa/server`; migrations for plugin models are generated with **`npx medusa plugin:db:generate`** (not the app-level `db:generate`), and applied by the consuming app with `npx medusa db:migrate`.
- One `defineLink` per file under `src/links/`.
- Credentials are NEVER persisted in the DB in this milestone.
- This is a **plugin**, not an app: there is no local Postgres/Medusa instance wired here, so Milestone-1 tests are **pure unit tests** (mocked `fetch`, no DB). Module/model/link correctness is verified via `plugin:db:generate` + `yarn build` succeeding. DB-backed integration tests arrive with later milestones once a test app is available.

---

## File Structure

**Create:**
- `src/lib/ongoing/types.ts` — Ongoing API DTOs + plugin-option/credential types.
- `src/lib/ongoing/errors.ts` — `OngoingApiError` + retryable/terminal classification.
- `src/lib/ongoing/throttle.ts` — per-key concurrency limiter.
- `src/lib/ongoing/client.ts` — `OngoingClient`: auth, request core, 429 retry, pagination, typed operations.
- `src/lib/ongoing/index.ts` — barrel re-export of the lib.
- `src/modules/ongoing/models/integration.ts` — `OngoingIntegration` model.
- `src/modules/ongoing/models/order-sync.ts` — `OngoingOrderSync` model.
- `src/modules/ongoing/service.ts` — `OngoingModuleService` (auto-CRUD + helpers).
- `src/modules/ongoing/loaders/validate-options.ts` — boot-time option validation.
- `src/modules/ongoing/index.ts` — `Module("ongoing", { service, loaders })`.
- `src/modules/ongoing/options.ts` — option-validation pure helper (shared by loader + tests).
- `src/links/ongoing-order-sync-order.ts`
- `src/links/ongoing-order-sync-fulfillment.ts`
- `src/links/ongoing-integration-stock-location.ts`
- `jest.config.js`, test files under `src/**/__tests__/`.

**Modify:**
- `package.json` — add `test` script + dev deps (`jest`, `@swc/jest`, `@types/jest`).

---

## Task 0: Test tooling + dev dependencies (scaffolding — verify by running)

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`

**Interfaces:**
- Produces: a `yarn test` script running Jest with SWC TS transform; later tasks add `*.test.ts` files under `src/`.

- [ ] **Step 1: Add dev dependencies**

Run:
```bash
yarn add -D jest@^29 @swc/jest@^0.2 @types/jest@^29
```
Expected: `package.json` devDependencies gains `jest`, `@swc/jest`, `@types/jest`; `yarn.lock` updates.

- [ ] **Step 2: Create Jest config**

Create `jest.config.js`:
```js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.(t|j)s$": ["@swc/jest"],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
}
```

- [ ] **Step 3: Add the test script**

In `package.json` `scripts`, add:
```json
"test": "jest"
```

- [ ] **Step 4: Verify Jest runs (no tests yet)**

Run: `yarn test --passWithNoTests`
Expected: exits 0, "No tests found, exiting with code 0".

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock jest.config.js
git commit -m "chore: add jest + swc unit-test tooling"
```

---

## Task 1: Ongoing types + error taxonomy

**Files:**
- Create: `src/lib/ongoing/types.ts`
- Create: `src/lib/ongoing/errors.ts`
- Test: `src/lib/ongoing/__tests__/errors.test.ts`

**Interfaces:**
- Produces:
  - `type OngoingCredentials = { key: string; baseUrl: string; username: string; password: string; goodsOwnerId: number; webhookSecret?: string }`
  - `type OngoingPluginOptions = { integrations: OngoingCredentials[]; defaultStockSyncInterval?: string; defaultStatusPollInterval?: string; rateLimitConcurrency?: number }`
  - `interface OngoingInventoryRow { articleNumber: string; articleSystemId?: number; numberOfItems: number; allocatedNumberOfItems: number; sellableNumberOfItems: number; toReceiveNumberOfItems: number }`
  - `interface OngoingOrderStatus { number: number; text: string }`
  - `interface OngoingParcelTracking { code?: string; carrier?: string; url?: string }`
  - `interface OngoingTrackedOrder { ongoingOrderId: number; orderNumber: string; statusNumber: number; statusText: string; trackingNumbers: string[] }`
  - `type PostOrderModel = Record<string, unknown>` (full mapping lands in Milestone 2; foundation only needs the type alias)
  - `class OngoingApiError extends Error` with `status?: number`, `kind: "retryable" | "terminal"`, `retryAfterMs?: number`, `body?: unknown`
  - `function classifyHttpStatus(status: number): "retryable" | "terminal"`

- [ ] **Step 1: Write the failing test for classification**

Create `src/lib/ongoing/__tests__/errors.test.ts`:
```ts
import { OngoingApiError, classifyHttpStatus } from "../errors"

describe("classifyHttpStatus", () => {
  it("treats 429 and 5xx as retryable", () => {
    expect(classifyHttpStatus(429)).toBe("retryable")
    expect(classifyHttpStatus(500)).toBe("retryable")
    expect(classifyHttpStatus(503)).toBe("retryable")
  })

  it("treats 4xx (except 429) as terminal", () => {
    expect(classifyHttpStatus(400)).toBe("terminal")
    expect(classifyHttpStatus(401)).toBe("terminal")
    expect(classifyHttpStatus(404)).toBe("terminal")
    expect(classifyHttpStatus(422)).toBe("terminal")
  })
})

describe("OngoingApiError", () => {
  it("carries status, kind, and body", () => {
    const err = new OngoingApiError("boom", { status: 500, kind: "retryable", body: { e: 1 } })
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(500)
    expect(err.kind).toBe("retryable")
    expect(err.body).toEqual({ e: 1 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/errors.test.ts`
Expected: FAIL — cannot find module `../errors`.

- [ ] **Step 3: Create the types file**

Create `src/lib/ongoing/types.ts`:
```ts
export type OngoingCredentials = {
  key: string
  baseUrl: string
  username: string
  password: string
  goodsOwnerId: number
  webhookSecret?: string
}

export type OngoingPluginOptions = {
  integrations: OngoingCredentials[]
  defaultStockSyncInterval?: string
  defaultStatusPollInterval?: string
  rateLimitConcurrency?: number
}

export interface OngoingInventoryRow {
  articleNumber: string
  articleSystemId?: number
  numberOfItems: number
  allocatedNumberOfItems: number
  sellableNumberOfItems: number
  toReceiveNumberOfItems: number
}

export interface OngoingOrderStatus {
  number: number
  text: string
}

export interface OngoingParcelTracking {
  code?: string
  carrier?: string
  url?: string
}

export interface OngoingTrackedOrder {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
}

// Full Medusa->Ongoing order mapping is implemented in Milestone 2.
export type PostOrderModel = Record<string, unknown>
```

- [ ] **Step 4: Create the errors file**

Create `src/lib/ongoing/errors.ts`:
```ts
export type OngoingErrorKind = "retryable" | "terminal"

export function classifyHttpStatus(status: number): OngoingErrorKind {
  if (status === 429 || status >= 500) {
    return "retryable"
  }
  return "terminal"
}

export class OngoingApiError extends Error {
  status?: number
  kind: OngoingErrorKind
  retryAfterMs?: number
  body?: unknown

  constructor(
    message: string,
    opts: { status?: number; kind: OngoingErrorKind; retryAfterMs?: number; body?: unknown }
  ) {
    super(message)
    this.name = "OngoingApiError"
    this.status = opts.status
    this.kind = opts.kind
    this.retryAfterMs = opts.retryAfterMs
    this.body = opts.body
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/errors.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ongoing/types.ts src/lib/ongoing/errors.ts src/lib/ongoing/__tests__/errors.test.ts
git commit -m "feat(ongoing-client): add API types and retryable/terminal error taxonomy"
```

---

## Task 2: Concurrency throttle

**Files:**
- Create: `src/lib/ongoing/throttle.ts`
- Test: `src/lib/ongoing/__tests__/throttle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Throttle { constructor(maxConcurrent: number); run<T>(fn: () => Promise<T>): Promise<T> }` — caps in-flight `fn` executions at `maxConcurrent`, queuing the rest FIFO. Used by `OngoingClient` to honor Ongoing's parallel-request limits.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/throttle.test.ts`:
```ts
import { Throttle } from "../throttle"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("Throttle", () => {
  it("never runs more than maxConcurrent at once", async () => {
    const throttle = new Throttle(2)
    let active = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]

    const tasks = gates.map((g) =>
      throttle.run(async () => {
        active++
        peak = Math.max(peak, active)
        await g.promise
        active--
      })
    )

    // Let the first batch start.
    await Promise.resolve()
    expect(active).toBe(2)

    // Release all gates, allowing the queue to drain.
    gates.forEach((g) => g.resolve())
    await Promise.all(tasks)

    expect(peak).toBe(2)
  })

  it("returns each task's resolved value", async () => {
    const throttle = new Throttle(1)
    const results = await Promise.all([
      throttle.run(async () => "a"),
      throttle.run(async () => "b"),
    ])
    expect(results).toEqual(["a", "b"])
  })

  it("frees a slot when a task rejects", async () => {
    const throttle = new Throttle(1)
    await expect(throttle.run(async () => { throw new Error("x") })).rejects.toThrow("x")
    await expect(throttle.run(async () => "ok")).resolves.toBe("ok")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/throttle.test.ts`
Expected: FAIL — cannot find module `../throttle`.

- [ ] **Step 3: Implement the throttle**

Create `src/lib/ongoing/throttle.ts`:
```ts
export class Throttle {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error("Throttle maxConcurrent must be >= 1")
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      next()
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/throttle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ongoing/throttle.ts src/lib/ongoing/__tests__/throttle.test.ts
git commit -m "feat(ongoing-client): add FIFO concurrency throttle"
```

---

## Task 3: REST client request core (auth, error mapping, 429 retry)

**Files:**
- Create: `src/lib/ongoing/client.ts`
- Test: `src/lib/ongoing/__tests__/client.request.test.ts`

**Interfaces:**
- Consumes: `OngoingCredentials`, `OngoingApiError`, `classifyHttpStatus`, `Throttle`.
- Produces: `class OngoingClient` with:
  - `constructor(creds: OngoingCredentials, opts?: { concurrency?: number; maxRetries?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> })`
  - private `request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T>` — adds Basic auth header, JSON content-type, throttles, parses JSON, throws `OngoingApiError` on non-2xx (mapping status via `classifyHttpStatus`, honoring `Retry-After`), retries `retryable` errors up to `maxRetries` with backoff.
  - operation methods are added in Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/client.request.test.ts`:
```ts
import { OngoingClient } from "../client"
import { OngoingApiError } from "../errors"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "wh-a",
  baseUrl: "https://api.example.test/api/v1",
  username: "user",
  password: "pass",
  goodsOwnerId: 42,
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("OngoingClient.request", () => {
  it("sends Basic auth and parses JSON on success", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error exercising the private method directly in a unit test
    const data = await client.request("GET", "/articles")

    expect(data).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/articles")
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("user:pass").toString("base64"))
  })

  it("throws terminal OngoingApiError on 400 without retrying", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(400, { error: "bad" }))
    const client = new OngoingClient(creds, { fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({ kind: "terminal", status: 400 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("retries retryable 503 then succeeds", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { fetchImpl, sleep, maxRetries: 2 })
    // @ts-expect-error private
    const data = await client.request("GET", "/x")
    expect(data).toEqual({ ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it("honors Retry-After seconds on 429 and gives up as retryable after maxRetries", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(429, { error: "slow" }, { "retry-after": "2" }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { fetchImpl, sleep, maxRetries: 1 })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(OngoingApiError)
    // initial try + 1 retry = 2 calls
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2000)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.request.test.ts`
Expected: FAIL — cannot find module `../client`.

- [ ] **Step 3: Implement the request core**

Create `src/lib/ongoing/client.ts`:
```ts
import { OngoingApiError, classifyHttpStatus } from "./errors"
import { Throttle } from "./throttle"
import type { OngoingCredentials } from "./types"

type ClientOpts = {
  concurrency?: number
  maxRetries?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class OngoingClient {
  private readonly authHeader: string
  private readonly throttle: Throttle
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly creds: OngoingCredentials, opts: ClientOpts = {}) {
    this.authHeader =
      "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64")
    this.throttle = new Throttle(opts.concurrency ?? 2)
    this.maxRetries = opts.maxRetries ?? 3
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? defaultSleep
  }

  protected async request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
    let attempt = 0
    // attempts = initial try + up to maxRetries retries
    for (;;) {
      try {
        return await this.throttle.run(() => this.doFetch<T>(method, path, body))
      } catch (err) {
        const retryable = err instanceof OngoingApiError && err.kind === "retryable"
        if (!retryable || attempt >= this.maxRetries) {
          throw err
        }
        const backoff = (err as OngoingApiError).retryAfterMs ?? 250 * 2 ** attempt
        await this.sleep(backoff)
        attempt++
      }
    }
  }

  private async doFetch<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
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
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined
  }
  const seconds = Number(header)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.request.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/__tests__/client.request.test.ts
git commit -m "feat(ongoing-client): request core with basic auth, error mapping, retry/backoff"
```

---

## Task 4: Typed operations + pagination + lib barrel

**Files:**
- Modify: `src/lib/ongoing/client.ts`
- Create: `src/lib/ongoing/index.ts`
- Test: `src/lib/ongoing/__tests__/client.operations.test.ts`

**Interfaces:**
- Consumes: the `request` core from Task 3; DTOs from Task 1.
- Produces, on `OngoingClient`:
  - `getOrderStatuses(): Promise<OngoingOrderStatus[]>` — `GET /orders/statuses`.
  - `getInventory(articleNumbers?: string[]): Promise<OngoingInventoryRow[]>` — `GET /articles/inventory`, transparently paginated.
  - `getOrdersByStatus(from: number, to: number): Promise<OngoingTrackedOrder[]>` — `GET /orders`, paginated, mapped to `OngoingTrackedOrder`.
  - `putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number; orderNumber: string }>` — `PUT /orders` upsert.
  - `testConnection(): Promise<boolean>` — calls `getOrderStatuses`, returns true on success.
- `src/lib/ongoing/index.ts` re-exports `OngoingClient`, `OngoingApiError`, `Throttle`, and all types.

Note on shapes: Ongoing list endpoints accept `page`/`goodsOwnerId` query params and return arrays; we paginate by incrementing `page` until a short/empty page. Exact response envelope is confirmed against the live OpenAPI in Milestone 2; this milestone codes against the documented field names (`NumberOfItemsDecimal`, `AllocatedNumberOfItems`, `SellableNumberOfItems`, `ToReceiveNumberOfItems`, status `Number`/`Text`, parcel tracking) and isolates parsing in mapper functions so a shape change is a one-spot edit.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/client.operations.test.ts`:
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
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

describe("OngoingClient operations", () => {
  it("maps inventory fields and stops paginating on a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      article: { articleNumber: `A${i}`, articleSystemId: i },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 2,
        SellableNumberOfItems: 8,
        ToReceiveNumberOfItems: 3,
      },
    }))
    const page2 = [
      {
        article: { articleNumber: "A50", articleSystemId: 50 },
        totalItems: {
          NumberOfItemsDecimal: 1,
          AllocatedNumberOfItems: 0,
          SellableNumberOfItems: 1,
          ToReceiveNumberOfItems: 0,
        },
      },
    ]
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(page1))
      .mockResolvedValueOnce(json(page2))
    const client = new OngoingClient(creds, { fetchImpl })

    const rows = await client.getInventory()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(51)
    expect(rows[0]).toEqual({
      articleNumber: "A0",
      articleSystemId: 0,
      numberOfItems: 10,
      allocatedNumberOfItems: 2,
      sellableNumberOfItems: 8,
      toReceiveNumberOfItems: 3,
    })
  })

  it("maps order statuses", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([{ Number: 200, Text: "Open" }, { Number: 400, Text: "Sent" }]))
    const client = new OngoingClient(creds, { fetchImpl })
    const statuses = await client.getOrderStatuses()
    expect(statuses).toEqual([{ number: 200, text: "Open" }, { number: 400, text: "Sent" }])
  })

  it("upserts an order and returns the ongoing id + orderNumber", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ orderInfo: { orderId: 999, orderNumber: "1001-abc" } }))
    const client = new OngoingClient(creds, { fetchImpl })
    const result = await client.putOrder({ orderNumber: "1001-abc", goodsOwnerId: 7 })
    expect(result).toEqual({ ongoingOrderId: 999, orderNumber: "1001-abc" })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/orders")
    expect(init.method).toBe("PUT")
  })

  it("testConnection returns true when statuses load", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json([{ Number: 200, Text: "Open" }]))
    const client = new OngoingClient(creds, { fetchImpl })
    await expect(client.testConnection()).resolves.toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: FAIL — `client.getInventory is not a function`.

- [ ] **Step 3: Add operations + mappers to the client**

In `src/lib/ongoing/client.ts`, add imports at the top:
```ts
import type {
  OngoingInventoryRow,
  OngoingOrderStatus,
  OngoingTrackedOrder,
  PostOrderModel,
} from "./types"
```

Add these methods inside the `OngoingClient` class (after `request`), plus the page size constant and mappers at the bottom of the file:
```ts
  // --- public operations ---

  async getOrderStatuses(): Promise<OngoingOrderStatus[]> {
    const raw = await this.request<any[]>("GET", `/orders/statuses?goodsOwnerId=${this.creds.goodsOwnerId}`)
    return (raw ?? []).map(mapStatus)
  }

  async getInventory(articleNumbers?: string[]): Promise<OngoingInventoryRow[]> {
    const filter = articleNumbers?.length ? `&articleNumber=${articleNumbers.map(encodeURIComponent).join(",")}` : ""
    return this.paginate((page) =>
      this.request<any[]>("GET", `/articles/inventory?goodsOwnerId=${this.creds.goodsOwnerId}&page=${page}${filter}`)
    ).then((rows) => rows.map(mapInventoryRow))
  }

  async getOrdersByStatus(from: number, to: number): Promise<OngoingTrackedOrder[]> {
    const rows = await this.paginate((page) =>
      this.request<any[]>(
        "GET",
        `/orders?goodsOwnerId=${this.creds.goodsOwnerId}&orderStatusFrom=${from}&orderStatusTo=${to}&page=${page}`
      )
    )
    return rows.map(mapTrackedOrder)
  }

  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number; orderNumber: string }> {
    const res = await this.request<any>("PUT", "/orders", order)
    return {
      ongoingOrderId: res?.orderInfo?.orderId,
      orderNumber: res?.orderInfo?.orderNumber,
    }
  }

  async testConnection(): Promise<boolean> {
    await this.getOrderStatuses()
    return true
  }

  private async paginate<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
    const all: T[] = []
    let page = 1
    for (;;) {
      const batch = (await fetchPage(page)) ?? []
      all.push(...batch)
      if (batch.length < ONGOING_PAGE_SIZE) {
        return all
      }
      page++
    }
  }
```

At the bottom of the file (module scope), add:
```ts
const ONGOING_PAGE_SIZE = 50

function mapStatus(raw: any): OngoingOrderStatus {
  return { number: raw.Number, text: raw.Text }
}

function mapInventoryRow(raw: any): OngoingInventoryRow {
  const t = raw.totalItems ?? {}
  return {
    articleNumber: raw.article?.articleNumber,
    articleSystemId: raw.article?.articleSystemId,
    numberOfItems: t.NumberOfItemsDecimal ?? 0,
    allocatedNumberOfItems: t.AllocatedNumberOfItems ?? 0,
    sellableNumberOfItems: t.SellableNumberOfItems ?? 0,
    toReceiveNumberOfItems: t.ToReceiveNumberOfItems ?? 0,
  }
}

function mapTrackedOrder(raw: any): OngoingTrackedOrder {
  const parcels: any[] = raw.parcels ?? []
  const trackingNumbers = parcels
    .map((p) => p.parcelTracking?.code ?? p.trackingNumber)
    .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
  return {
    ongoingOrderId: raw.orderInfo?.orderId,
    orderNumber: raw.orderInfo?.orderNumber,
    statusNumber: raw.orderInfo?.orderStatus?.number,
    statusText: raw.orderInfo?.orderStatus?.text,
    trackingNumbers,
  }
}
```

> NOTE: `ONGOING_PAGE_SIZE` (50) is the assumed Ongoing default page size; confirm against the OpenAPI in Milestone 2 and adjust the constant if needed. Pagination stops on the first page shorter than this size.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/client.operations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the lib barrel**

Create `src/lib/ongoing/index.ts`:
```ts
export { OngoingClient } from "./client"
export { OngoingApiError, classifyHttpStatus } from "./errors"
export { Throttle } from "./throttle"
export * from "./types"
```

- [ ] **Step 6: Run the whole lib test suite + commit**

Run: `yarn test src/lib/ongoing`
Expected: PASS (all lib tests green).

```bash
git add src/lib/ongoing/client.ts src/lib/ongoing/index.ts src/lib/ongoing/__tests__/client.operations.test.ts
git commit -m "feat(ongoing-client): typed operations, pagination, lib barrel"
```

---

## Task 5: Data models (scaffolding — verify by generate + build)

**Files:**
- Create: `src/modules/ongoing/models/integration.ts`
- Create: `src/modules/ongoing/models/order-sync.ts`

**Interfaces:**
- Produces two Medusa data models consumed by the service in Task 6:
  - `OngoingIntegration` fields: `id`, `credential_key` (unique), `enabled` (default true), `stock_location_id` (unique), `stock_sync_enabled` (default true), `stock_sync_interval` (nullable), `status_poll_interval` (nullable), `stock_reconcile_mode` (enum, default `sellable_plus_reserved`), `edit_sync_rules` (json nullable), `shipped_status_codes` (json nullable), `cancellable_status_codes` (json nullable), `last_stock_sync_at` (dateTime nullable), `last_status_poll_at` (dateTime nullable), `sync_lock_until` (dateTime nullable).
  - `OngoingOrderSync` fields: `id`, `integration_id`, `medusa_order_id`, `medusa_fulfillment_id` (nullable), `ongoing_order_number` (unique), `ongoing_order_id` (nullable number), `latest_status_code` (nullable number), `latest_status_text` (nullable), `sync_state` (enum, default `pending`), `error_class` (enum nullable), `last_synced_at` (dateTime nullable), `last_error` (text nullable), `retry_count` (number default 0), `shipped_at` (dateTime nullable).

- [ ] **Step 1: Create the integration model**

Create `src/modules/ongoing/models/integration.ts`:
```ts
import { model } from "@medusajs/framework/utils"

const OngoingIntegration = model.define("ongoing_integration", {
  id: model.id().primaryKey(),
  credential_key: model.text().unique(),
  enabled: model.boolean().default(true),
  stock_location_id: model.text().unique(),
  stock_sync_enabled: model.boolean().default(true),
  stock_sync_interval: model.text().nullable(),
  status_poll_interval: model.text().nullable(),
  stock_reconcile_mode: model
    .enum(["sellable_plus_reserved", "precise", "onhand"])
    .default("sellable_plus_reserved"),
  edit_sync_rules: model.json().nullable(),
  shipped_status_codes: model.json().nullable(),
  cancellable_status_codes: model.json().nullable(),
  last_stock_sync_at: model.dateTime().nullable(),
  last_status_poll_at: model.dateTime().nullable(),
  sync_lock_until: model.dateTime().nullable(),
})

export default OngoingIntegration
```

- [ ] **Step 2: Create the order-sync model**

Create `src/modules/ongoing/models/order-sync.ts`:
```ts
import { model } from "@medusajs/framework/utils"

const OngoingOrderSync = model.define("ongoing_order_sync", {
  id: model.id().primaryKey(),
  integration_id: model.text(),
  medusa_order_id: model.text().index(),
  medusa_fulfillment_id: model.text().nullable().index(),
  ongoing_order_number: model.text().unique(),
  ongoing_order_id: model.number().nullable(),
  latest_status_code: model.number().nullable(),
  latest_status_text: model.text().nullable(),
  sync_state: model
    .enum(["pending", "sent", "shipped", "cancelled", "error"])
    .default("pending"),
  error_class: model.enum(["retryable", "terminal"]).nullable(),
  last_synced_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  retry_count: model.number().default(0),
  shipped_at: model.dateTime().nullable(),
})

export default OngoingOrderSync
```

- [ ] **Step 3: Commit (model migration is generated in Task 7 after the service + module exist)**

```bash
git add src/modules/ongoing/models/integration.ts src/modules/ongoing/models/order-sync.ts
git commit -m "feat(ongoing-module): add OngoingIntegration and OngoingOrderSync data models"
```

---

## Task 6: Module service, option validation, and module export

**Files:**
- Create: `src/modules/ongoing/options.ts`
- Create: `src/modules/ongoing/service.ts`
- Create: `src/modules/ongoing/loaders/validate-options.ts`
- Create: `src/modules/ongoing/index.ts`
- Test: `src/modules/ongoing/__tests__/options.test.ts`

**Interfaces:**
- Consumes: models from Task 5; `OngoingPluginOptions`, `OngoingCredentials` from `src/lib/ongoing/types`.
- Produces:
  - `function validateOngoingOptions(options: unknown): OngoingPluginOptions` — throws `Error` with a clear message on malformed options; returns the typed options on success.
  - `const ONGOING_MODULE = "ongoing"`.
  - `class OngoingModuleService` (extends `MedusaService({ OngoingIntegration, OngoingOrderSync })`) with:
    - `getCredentials(credentialKey: string): OngoingCredentials` — looks up the plugin-option entry; throws if missing.
    - `getClient(credentialKey: string): OngoingClient` — builds a client from the credentials + `rateLimitConcurrency`.
    - `getIntegrationByLocation(stockLocationId: string)` — returns the single enabled integration row for a location or `undefined`.
  - Default export `Module(ONGOING_MODULE, { service, loaders })`.

- [ ] **Step 1: Write the failing test for option validation**

Create `src/modules/ongoing/__tests__/options.test.ts`:
```ts
import { validateOngoingOptions } from "../options"

const valid = {
  integrations: [
    { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

describe("validateOngoingOptions", () => {
  it("accepts a well-formed options object", () => {
    expect(validateOngoingOptions(valid).integrations[0].key).toBe("wh-a")
  })

  it("rejects missing integrations array", () => {
    expect(() => validateOngoingOptions({})).toThrow(/integrations/)
  })

  it("rejects an integration missing required fields", () => {
    expect(() =>
      validateOngoingOptions({ integrations: [{ key: "wh-a", baseUrl: "https://x" }] })
    ).toThrow(/wh-a/)
  })

  it("rejects duplicate credential keys", () => {
    expect(() =>
      validateOngoingOptions({ integrations: [valid.integrations[0], valid.integrations[0]] })
    ).toThrow(/duplicate/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/modules/ongoing/__tests__/options.test.ts`
Expected: FAIL — cannot find module `../options`.

- [ ] **Step 3: Implement option validation**

Create `src/modules/ongoing/options.ts`:
```ts
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

const REQUIRED: (keyof OngoingCredentials)[] = ["key", "baseUrl", "username", "password", "goodsOwnerId"]

export function validateOngoingOptions(options: unknown): OngoingPluginOptions {
  const opts = options as Partial<OngoingPluginOptions> | undefined
  if (!opts || !Array.isArray(opts.integrations)) {
    throw new Error("[ongoing] plugin options must include an `integrations` array")
  }

  const seen = new Set<string>()
  for (const integration of opts.integrations) {
    const key = (integration as Partial<OngoingCredentials>)?.key ?? "<missing key>"
    for (const field of REQUIRED) {
      if (integration[field] === undefined || integration[field] === null || integration[field] === "") {
        throw new Error(`[ongoing] integration "${key}" is missing required option "${field}"`)
      }
    }
    if (seen.has(integration.key)) {
      throw new Error(`[ongoing] duplicate credential key "${integration.key}" in integrations`)
    }
    seen.add(integration.key)
  }

  return opts as OngoingPluginOptions
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/ongoing/__tests__/options.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the service**

Create `src/modules/ongoing/service.ts`:
```ts
import { MedusaService } from "@medusajs/framework/utils"
import OngoingIntegration from "./models/integration"
import OngoingOrderSync from "./models/order-sync"
import { validateOngoingOptions } from "./options"
import { OngoingClient } from "../../lib/ongoing/client"
import type { OngoingCredentials, OngoingPluginOptions } from "../../lib/ongoing/types"

class OngoingModuleService extends MedusaService({
  OngoingIntegration,
  OngoingOrderSync,
}) {
  protected readonly options_: OngoingPluginOptions

  // Medusa injects (container, moduleOptions) into the module service constructor.
  constructor(_: unknown, options: OngoingPluginOptions) {
    super(...arguments)
    this.options_ = validateOngoingOptions(options)
  }

  getCredentials(credentialKey: string): OngoingCredentials {
    const found = this.options_.integrations.find((i) => i.key === credentialKey)
    if (!found) {
      throw new Error(`[ongoing] no credentials configured for credential_key "${credentialKey}"`)
    }
    return found
  }

  getClient(credentialKey: string): OngoingClient {
    return new OngoingClient(this.getCredentials(credentialKey), {
      concurrency: this.options_.rateLimitConcurrency ?? 2,
    })
  }

  async getIntegrationByLocation(stockLocationId: string) {
    const [integration] = await this.listOngoingIntegrations({
      stock_location_id: stockLocationId,
      enabled: true,
    })
    return integration
  }
}

export default OngoingModuleService
```

- [ ] **Step 6: Implement the boot-time validation loader**

Create `src/modules/ongoing/loaders/validate-options.ts`:
```ts
import { LoaderOptions } from "@medusajs/framework/types"
import { validateOngoingOptions } from "../options"

export default async function validateOptionsLoader({ options, container }: LoaderOptions) {
  const logger = container.resolve("logger")
  const validated = validateOngoingOptions(options)
  logger.info(`[ongoing] validated ${validated.integrations.length} warehouse integration(s)`)
}
```

- [ ] **Step 7: Export the module**

Create `src/modules/ongoing/index.ts`:
```ts
import { Module } from "@medusajs/framework/utils"
import OngoingModuleService from "./service"
import validateOptionsLoader from "./loaders/validate-options"

export const ONGOING_MODULE = "ongoing"

export default Module(ONGOING_MODULE, {
  service: OngoingModuleService,
  loaders: [validateOptionsLoader],
})
```

- [ ] **Step 8: Run module tests + commit**

Run: `yarn test src/modules/ongoing`
Expected: PASS.

```bash
git add src/modules/ongoing/options.ts src/modules/ongoing/service.ts src/modules/ongoing/loaders/validate-options.ts src/modules/ongoing/index.ts src/modules/ongoing/__tests__/options.test.ts
git commit -m "feat(ongoing-module): service with credential/client/location helpers + boot option validation"
```

---

## Task 7: Module links + migration generation (scaffolding — verify by generate + build)

**Files:**
- Create: `src/links/ongoing-order-sync-order.ts`
- Create: `src/links/ongoing-order-sync-fulfillment.ts`
- Create: `src/links/ongoing-integration-stock-location.ts`

**Interfaces:**
- Produces three links: `OngoingOrderSync ⇄ order`, `OngoingOrderSync ⇄ fulfillment`, `OngoingIntegration ⇄ stock_location`. Consumed by later milestones for graph queries and cascade cleanup.

- [ ] **Step 1: Link OngoingOrderSync ⇄ order**

Create `src/links/ongoing-order-sync-order.ts`:
```ts
import { defineLink } from "@medusajs/framework/utils"
import OrderModule from "@medusajs/medusa/order"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  OngoingModule.linkable.ongoingOrderSync,
  OrderModule.linkable.order
)
```

- [ ] **Step 2: Link OngoingOrderSync ⇄ fulfillment**

Create `src/links/ongoing-order-sync-fulfillment.ts`:
```ts
import { defineLink } from "@medusajs/framework/utils"
import FulfillmentModule from "@medusajs/medusa/fulfillment"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  OngoingModule.linkable.ongoingOrderSync,
  FulfillmentModule.linkable.fulfillment
)
```

- [ ] **Step 3: Link OngoingIntegration ⇄ stock_location (cascade on location delete)**

Create `src/links/ongoing-integration-stock-location.ts`:
```ts
import { defineLink } from "@medusajs/framework/utils"
import StockLocationModule from "@medusajs/medusa/stock-location"
import OngoingModule from "../modules/ongoing"

export default defineLink(
  StockLocationModule.linkable.stockLocation,
  {
    linkable: OngoingModule.linkable.ongoingIntegration,
    deleteCascade: true,
  }
)
```

> NOTE: confirm the exact `linkable` accessor names by inspecting the generated module link metadata — model `ongoing_integration` → `OngoingModule.linkable.ongoingIntegration`, `ongoing_order_sync` → `OngoingModule.linkable.ongoingOrderSync`. If `plugin:db:generate` errors on an unknown linkable, read the error: it lists the available accessor keys.

- [ ] **Step 4: Generate plugin migrations for the module models**

Run: `npx medusa plugin:db:generate`
Expected: creates a migration file under `src/modules/ongoing/migrations/` for the two tables. Confirm the file exists and references `ongoing_integration` and `ongoing_order_sync`.

- [ ] **Step 5: Build the plugin to validate everything compiles**

Run: `yarn build`
Expected: `medusa plugin:build` completes without TypeScript errors; output appears under `.medusa/server`.

- [ ] **Step 6: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/links src/modules/ongoing/migrations
git commit -m "feat(ongoing-module): module links to order, fulfillment, stock_location + generated migrations"
```

---

## Task 8: Consuming-app integration docs

**Files:**
- Create: `docs/README.md` section or `docs/integration-setup.md` (append if `docs/README.md` exists)

**Interfaces:**
- Produces: the `medusa-config` snippet a consuming app needs to register the plugin, its module, and the Ongoing fulfillment provider (provider lands in Milestone 2 — note it as "coming next"), with env-sourced credentials.

- [ ] **Step 1: Document registration**

Create `docs/integration-setup.md`:
````markdown
# Consuming-app setup (Ongoing Warehouse plugin)

Register the plugin and pass per-warehouse credentials from environment variables:

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: "MedusaOngoingWarehousePlugin",
      options: {
        integrations: [
          {
            key: "warehouse-a",
            baseUrl: process.env.ONGOING_A_URL,
            username: process.env.ONGOING_A_USER,
            password: process.env.ONGOING_A_PASS,
            goodsOwnerId: Number(process.env.ONGOING_A_GOODS_OWNER),
            webhookSecret: process.env.ONGOING_A_WEBHOOK_SECRET,
          },
        ],
        rateLimitConcurrency: 2,
      },
    },
  ],
})
```

After installing/updating the plugin, apply migrations in the app:

```bash
npx medusa db:migrate
```

The fulfillment provider registration (under `@medusajs/medusa/fulfillment` → `providers`) is added in Milestone 2.
````

- [ ] **Step 2: Commit**

```bash
git add docs/integration-setup.md
git commit -m "docs: consuming-app registration + env credential setup for ongoing plugin"
```

---

## Self-Review (completed during planning)

- **Spec coverage (M1 slice):** module + `OngoingIntegration`/`OngoingOrderSync` models (Tasks 5–6) ✓; links to order/fulfillment/stock_location with cascade (Task 7) ✓; credentials in plugin options, no DB secrets, boot validation (Tasks 1, 6) ✓; REST client with Basic auth + `goodsOwnerId`, pagination, throttle, 429/Retry-After, retryable-vs-terminal taxonomy (Tasks 1–4) ✓; `.unique()` on `credential_key`/`stock_location_id`/`ongoing_order_number` (Task 5) ✓; `stock_reconcile_mode` field present for Milestone 4 ✓. Provider, workflows, jobs, subscribers, admin UI are later milestones (out of M1 scope) — intentionally deferred.
- **Placeholder scan:** every code step contains full code; the two NOTE callouts (page size, linkable accessor names) are explicit verify-points with the resolution method stated, not missing content.
- **Type consistency:** `OngoingClient` constructor/methods, `OngoingCredentials`/`OngoingPluginOptions`, `validateOngoingOptions`, model field names, and `ONGOING_MODULE` are used identically across tasks. Mapper field names (`numberOfItems`, `sellableNumberOfItems`, …) match the `OngoingInventoryRow` interface in Task 1.

## Known verify-points carried into Milestone 2
- Exact Ongoing list response envelopes + default page size (Task 4 NOTE) — confirm against live OpenAPI; mappers isolate the change.
- `*.linkable.*` accessor names (Task 7 NOTE).
- These do not block M1: the unit tests pin behavior against the documented field names, and the build/migration steps validate the Medusa wiring.

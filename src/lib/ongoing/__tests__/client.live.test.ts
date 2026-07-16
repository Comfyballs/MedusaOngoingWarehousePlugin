/**
 * LIVE integration tests — these hit the REAL Ongoing REST API. They do NOT run in
 * the default suite (jest.config.js ignores *.live.test.ts). Run explicitly:
 *
 *   cp .env.integration.example .env.integration   # fill in sandbox creds
 *   yarn test:live                                  # read-only paths
 *   ONGOING_LIVE_WRITES=1 yarn test:live            # + order round-trip (sandbox only!)
 *
 * The whole suite self-skips unless ONGOING_LIVE === "1", so it's a no-op without secrets.
 * Value over the mocked unit tests: proves Ongoing's real payloads satisfy our zod schemas
 * (getInventory / getOrdersByStatus validate internally), that auth + the /api/v1 base URL
 * are right, and that cursor pagination terminates against live data.
 */
import { OngoingClient } from "../client"
import type { OngoingCredentials, PostArticleModel, PostOrderModel } from "../types"

const live = process.env.ONGOING_LIVE === "1"
const writesEnabled = process.env.ONGOING_LIVE_WRITES === "1"

function credsFromEnv(): OngoingCredentials {
  const { ONGOING_URL, ONGOING_USER, ONGOING_PASS, ONGOING_GOODS_OWNER } = process.env
  const missing = ["ONGOING_URL", "ONGOING_USER", "ONGOING_PASS", "ONGOING_GOODS_OWNER"].filter(
    (k) => !process.env[k]
  )
  if (missing.length) {
    throw new Error(
      `ONGOING_LIVE=1 but missing env: ${missing.join(", ")}. See .env.integration.example.`
    )
  }
  return {
    key: "live",
    baseUrl: ONGOING_URL!.replace(/\/$/, ""), // tolerate a trailing slash in the env value
    username: ONGOING_USER!,
    password: ONGOING_PASS!,
    goodsOwnerId: Number(ONGOING_GOODS_OWNER),
  }
}

const describeLive = live ? describe : describe.skip

describeLive("Ongoing live API — read paths", () => {
  let client: OngoingClient

  beforeAll(() => {
    client = new OngoingClient(credsFromEnv())
  })

  it("authenticates and returns order statuses", async () => {
    // testConnection() === getOrderStatuses(); this is the smoke test for creds + base URL.
    const statuses = await client.getOrderStatuses()
    expect(Array.isArray(statuses)).toBe(true)
    for (const s of statuses) {
      expect(typeof s.number).toBe("number")
      expect(typeof s.text).toBe("string")
    }
  })

  it("returns inventory rows that satisfy OngoingInventoryRowResponseSchema", async () => {
    // getInventory maps every row through the schema — a real row that fails validation
    // throws a terminal OngoingApiError here, catching upstream shape drift.
    const rows = await client.getInventory()
    expect(Array.isArray(rows)).toBe(true)
    for (const r of rows.slice(0, 5)) {
      expect(typeof r.articleNumber).toBe("string")
      expect(typeof r.sellableNumberOfItems).toBe("number")
    }
  })

  it("supports a delta inventory sweep (stockInfoChangedFrom)", async () => {
    // Delta path used by the stock-sync job. Ongoing REJECTS a stockInfoChangedFrom
    // older than 24h ("must be within 24 hours of the current time" — 400), so use a
    // recent window. Empty result is fine. (Prod: the job's 6h full-sweep fallback —
    // FULL_SWEEP_INTERVAL_MS in stock-sync.ts — re-anchors the delta cursor well within
    // that 24h ceiling, so the live path never sends a stale cursor.)
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const rows = await client.getInventory(undefined, since)
    expect(Array.isArray(rows)).toBe(true)
  })

})

// Full order-history pagination walks EVERY order in the status range at concurrency 1
// (the client exposes no server-side limit), which can take minutes on a live warehouse —
// so it's opt-in via ONGOING_LIVE_HEAVY with a long timeout, kept out of the default
// fast read run.
const describeHeavy = live && process.env.ONGOING_LIVE_HEAVY === "1" ? describe : describe.skip

describeHeavy("Ongoing live API — heavy sweeps", () => {
  let client: OngoingClient
  beforeAll(() => {
    client = new OngoingClient(credsFromEnv())
  })

  it(
    "paginates the full order history without looping and validates shape",
    async () => {
      // Wide status range so pagination has many pages to walk; the cursor guard must terminate.
      const orders = await client.getOrdersByStatus(0, 1000)
      expect(Array.isArray(orders)).toBe(true)
      for (const o of orders.slice(0, 5)) {
        expect(typeof o.ongoingOrderId).toBe("number")
        expect(typeof o.orderNumber).toBe("string")
        expect(typeof o.statusNumber).toBe("number")
      }
    },
    5 * 60_000
  )
})

// Write round-trip: creates a real (test) article + order, then cancels it. SANDBOX ONLY.
// Gated behind ONGOING_LIVE_WRITES so a read-only live run never mutates the warehouse.
const describeWrites = live && writesEnabled ? describe : describe.skip

describeWrites("Ongoing live API — write round-trip (sandbox)", () => {
  let client: OngoingClient
  let creds: OngoingCredentials
  // Unique per run so re-runs never collide; upserts are idempotent by these keys anyway.
  const stamp = Date.now()
  const articleNumber = `MEDUSA-IT-${stamp}`
  const orderNumber = `MEDUSA-IT-ORDER-${stamp}`
  let ongoingOrderId: number | undefined

  beforeAll(() => {
    creds = credsFromEnv()
    client = new OngoingClient(creds)
  })

  afterAll(async () => {
    // Best-effort cleanup — cancel the order we created so the sandbox stays tidy.
    // cancelOrder only succeeds while the order is still cancellable (early status).
    if (ongoingOrderId !== undefined) {
      try {
        await client.cancelOrder(ongoingOrderId)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[live] could not cancel test order ${ongoingOrderId}:`, err)
      }
    }
  })

  it("upserts a test article (ProcessArticle)", async () => {
    const article: PostArticleModel = {
      goodsOwnerId: creds.goodsOwnerId,
      articleNumber,
      articleName: `Medusa integration test ${stamp}`,
      weight: 0.1,
    }
    const res = await client.putArticle(article)
    // articleSystemId echo is optional in the spec; a resolved call (no throw) is the assertion.
    expect(res).toBeDefined()
  })

  it("creates an order referencing the test article (ProcessOrder)", async () => {
    const order: PostOrderModel = {
      goodsOwnerId: creds.goodsOwnerId,
      orderNumber,
      deliveryDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      consignee: {
        name: "Medusa Integration Test",
        address1: "Testgatan 1",
        postCode: "11122",
        city: "Stockholm",
        countryCode: "SE",
      },
      orderLines: [{ rowNumber: "1", articleNumber, numberOfItems: 1 }],
    }
    const res = await client.putOrder(order)
    expect(typeof res.ongoingOrderId).toBe("number")
    ongoingOrderId = res.ongoingOrderId
  })

  it(
    "reads the created order back by status",
    async () => {
      // A freshly-created order sits in an early/open status, so scan only the
      // open→printed band (200–320) rather than the full 0–1000 history — the wide
      // sweep walks every shipped order and times out on a real warehouse.
      const orders = await client.getOrdersByStatus(200, 320)
      const found = orders.find((o) => o.orderNumber === orderNumber)
      expect(found?.ongoingOrderId).toBe(ongoingOrderId)
    },
    3 * 60_000
  )
})

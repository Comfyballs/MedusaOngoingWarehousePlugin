import { OngoingApiError, classifyHttpStatus, classifyError } from "./errors"
import { nodeHttpsFetch } from "./http-transport"
import {
  OngoingInventoryRowResponseSchema,
  OngoingOrderDetailResponseSchema,
  OngoingTrackedOrderResponseSchema,
} from "./schemas"
import { Throttle } from "./throttle"
import type { OngoingCredentials } from "./types"
import type {
  OngoingInventoryRow,
  OngoingOrderDetail,
  OngoingOrderStatus,
  OngoingTrackedOrder,
  OngoingTrackingRef,
  PostArticleModel,
  PostOrderModel,
  PostReturnOrderModel,
} from "./types"

type ClientOpts = {
  concurrency?: number
  maxRetries?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Ongoing processes writes sequentially per goods owner and recommends making ALL
// API calls sequentially (https://developer.ongoingwarehouse.com/parallel-requests) —
// so the client defaults to concurrency 1 (bead 4s4).
const DEFAULT_CONCURRENCY = 1
// Bound a hung socket so one stalled call can't freeze a whole cron tick (bead 4s4;
// Medusa third-party-sync best practice: always set request timeouts).
const DEFAULT_TIMEOUT_MS = 30_000

export class OngoingClient {
  private readonly authHeader: string
  private readonly throttle: Throttle
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly creds: OngoingCredentials, opts: ClientOpts = {}) {
    this.authHeader =
      "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64")
    this.throttle = new Throttle(opts.concurrency ?? DEFAULT_CONCURRENCY)
    this.maxRetries = opts.maxRetries ?? 3
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Default to the Node http/https transport, NOT global fetch: Ongoing's server 500s
    // on undici fetch's request signature (see http-transport.ts / bead 9sp). Tests still
    // inject their own fetchImpl.
    this.fetchImpl = opts.fetchImpl ?? nodeHttpsFetch
    this.sleep = opts.sleep ?? defaultSleep
  }

  protected async request<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    let attempt = 0
    // attempts = initial try + up to maxRetries retries
    for (;;) {
      try {
        return await this.throttle.run(() => this.doFetch<T>(method, path, body))
      } catch (err) {
        // #67: classifyError treats a raw network error (ECONNRESET / timeout / DNS /
        // a fetch TypeError) as retryable, so a brief outage is retried (bounded by
        // maxRetries) rather than surfacing on the first attempt.
        const retryable = classifyError(err) === "retryable"
        if (!retryable || attempt >= this.maxRetries) {
          throw err
        }
        // retryAfterMs only exists on an OngoingApiError; a network error has none.
        const retryAfterMs = err instanceof OngoingApiError ? err.retryAfterMs : undefined
        const backoff = retryAfterMs ?? 250 * 2 ** attempt
        await this.sleep(backoff)
        attempt++
      }
    }
  }

  private async doFetch<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    // Abort a hung request after timeoutMs. The resulting abort rejects fetch with a
    // non-OngoingApiError, which classifyError treats as retryable, so the request()
    // loop retries it (bounded by maxRetries) exactly like any transient network error.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

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

  // --- public operations ---

  async getOrderStatuses(): Promise<OngoingOrderStatus[]> {
    const raw = await this.request<{ orderStatuses?: { number: number; text: string }[] }>(
      "GET",
      `/orders/statuses?goodsOwnerId=${this.creds.goodsOwnerId}`
    )
    return (raw?.orderStatuses ?? []).map(mapStatus)
  }

  async getInventory(articleNumbers?: string[], changedSince?: string): Promise<OngoingInventoryRow[]> {
    // Inventory comes from GET /api/v1/articles (inventoryInfo per GetArticleModel);
    // the old /articles/inventory path does not exist in the spec. `articleNumbers` (plural,
    // not `articleNumber` — bead dtw) is declared style:form explode:true, so it must be
    // serialized as repeated keys (`articleNumbers=A&articleNumbers=B`), NOT a comma-joined
    // value — a CSV binds as a single array element server-side and matches no article
    // (PR#133 review). `changedSince` maps to stockInfoChangedFrom for delta syncs — only
    // articles whose stock changed since then (bead sw8); omitted → full catalogue sweep.
    const filters =
      (articleNumbers?.length
        ? articleNumbers.map((n) => `&articleNumbers=${encodeURIComponent(n)}`).join("")
        : "") +
      (changedSince ? `&stockInfoChangedFrom=${encodeURIComponent(changedSince)}` : "")
    const rows = await this.paginateByCursor(
      (cursorFrom) =>
        this.request<any[]>(
          "GET",
          `/articles?goodsOwnerId=${this.creds.goodsOwnerId}` +
            `&articleSystemIdFrom=${cursorFrom}&maxArticlesToGet=${ONGOING_PAGE_SIZE}${filters}`
        ),
      (raw) => Number(raw?.articleSystemId)
    )
    return rows.map(mapInventoryRow)
  }

  async getOrdersByStatus(from: number, to: number): Promise<OngoingTrackedOrder[]> {
    const rows = await this.paginateByCursor(
      (cursorFrom) =>
        this.request<any[]>(
          "GET",
          `/orders?goodsOwnerId=${this.creds.goodsOwnerId}` +
            `&orderStatusFrom=${from}&orderStatusTo=${to}` +
            `&orderIdFrom=${cursorFrom}&maxOrdersToGet=${ONGOING_PAGE_SIZE}`
        ),
      (raw) => Number(raw?.orderInfo?.orderId)
    )
    return rows.map(mapTrackedOrder)
  }

  // ProcessArticle (step 1 of Ongoing's webshop flow): PUT /articles upserts by
  // articleNumber, so the same call creates or updates. Called before putOrder so
  // an order never references an unknown articleNumber. A 2xx (with or without an
  // articleSystemId echo) means the upsert landed; a non-2xx surfaces as the usual
  // classified OngoingApiError for the caller's record-then-retry pipeline.
  async putArticle(article: PostArticleModel): Promise<{ articleSystemId?: number }> {
    const res = await this.request<{ articleSystemId?: number | null; message?: string }>(
      "PUT",
      "/articles",
      article
    )
    return {
      articleSystemId: typeof res?.articleSystemId === "number" ? res.articleSystemId : undefined,
    }
  }

  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }> {
    const res = await this.request<{ orderId?: number | null; message?: string }>(
      "PUT",
      "/orders",
      order
    )
    if (typeof res?.orderId !== "number") {
      // #108: a 2xx response that omits (or nulls) orderId must not silently flow
      // an undefined/null ongoing_order_id into the callers that persist it
      // (push-order-record-sync.ts, upsert-ongoing-order-edit.ts). Throw so the
      // existing OngoingApiError catch/record-error/retry pipeline (#67,
      // retry-policy.ts) handles it instead of a type-hole return value.
      throw new OngoingApiError(
        "Ongoing PUT /orders returned a 2xx response without a numeric orderId",
        { kind: "retryable", body: res }
      )
    }
    return { ongoingOrderId: res.orderId }
  }

  // GET /orders/{orderId} (OpenAPI v57 GetOrderModel). Used to resolve a return order
  // line's `customerOrderLine.orderLineId` by matching the original order's
  // orderLines[].article.articleNumber (see return-order-mapper.ts).
  async getOrder(ongoingOrderId: number): Promise<OngoingOrderDetail> {
    const raw = await this.request<unknown>("GET", `/orders/${ongoingOrderId}`)
    return mapOrderDetail(raw)
  }

  // PUT /returnOrders (ProcessReturnOrder). The 2xx body is
  // `PostReturnOrderResponse { returnOrderId: int32 nullable, message: string nullable }`
  // — CONFIRMED against the official Ongoing openapi.json (version 57): the `returnOrderId`
  // field name, originally inferred by analogy with putOrder's `orderId` from the Postman
  // collection, is verified against the authoritative spec (bead 2a6). Upserts by
  // `returnOrderNumber`, mirroring putOrder's idempotent-upsert semantics.
  async putReturnOrder(returnOrder: PostReturnOrderModel): Promise<{ ongoingReturnOrderId: number }> {
    const res = await this.request<{ returnOrderId?: number | null; message?: string | null }>(
      "PUT",
      "/returnOrders",
      returnOrder
    )
    if (typeof res?.returnOrderId !== "number") {
      // Mirrors putOrder's #108 guard: a 2xx that omits (or nulls) the id must not
      // silently flow an undefined/null value into the caller — throw so the same
      // classified OngoingApiError catch/record/retry pipeline handles it.
      throw new OngoingApiError(
        "Ongoing PUT /returnOrders returned a 2xx response without a numeric returnOrderId",
        { kind: "retryable", body: res }
      )
    }
    return { ongoingReturnOrderId: res.returnOrderId }
  }

  async cancelOrder(ongoingOrderId: number): Promise<{ ongoingOrderId: number; message?: string }> {
    const res = await this.request<any>("DELETE", `/orders/${ongoingOrderId}`)
    return {
      ongoingOrderId: res?.orderId ?? ongoingOrderId,
      message: res?.message,
    }
  }

  async testConnection(): Promise<boolean> {
    await this.getOrderStatuses()
    return true
  }

  // Ongoing paginates by ascending ID cursor, not page number: pass the highest ID seen
  // + 1 as the next `...IdFrom`, and stop when a page is empty or short
  // (https://developer.ongoingwarehouse.com/paginating-responses). Results come back in
  // ID order, so advancing past the batch max never skips a row. The non-advance guard is
  // a belt-and-suspenders stop so a server that ignores the cursor can't loop forever —
  // the old page/pageSize scheme (params that don't exist in the spec) did exactly that,
  // re-fetching the identical full result every iteration (bead ji6).
  private async paginateByCursor<T>(
    fetchPage: (cursorFrom: number) => Promise<T[]>,
    cursorOf: (row: T) => number
  ): Promise<T[]> {
    const all: T[] = []
    let cursorFrom = 0
    for (;;) {
      const batch = (await fetchPage(cursorFrom)) ?? []
      if (batch.length === 0) {
        return all
      }
      all.push(...batch)
      if (batch.length < ONGOING_PAGE_SIZE) {
        return all
      }
      let maxId = -Infinity
      for (const row of batch) {
        const id = cursorOf(row)
        if (Number.isFinite(id) && id > maxId) {
          maxId = id
        }
      }
      const nextCursor = maxId + 1
      // Stop if no row carried a parseable id, or the cursor didn't move past where we
      // asked (a server ignoring the cursor / returning stale rows) — never loop.
      if (!Number.isFinite(maxId) || nextCursor <= cursorFrom) {
        return all
      }
      cursorFrom = nextCursor
    }
  }
}

const ONGOING_PAGE_SIZE = 50

function mapStatus(raw: { number: number; text: string }): OngoingOrderStatus {
  return { number: raw.number, text: raw.text }
}

// #114-a: structurally validate the Ongoing 2xx body before mapping. A malformed
// row (e.g. `article`/`orderInfo` omitted) must throw a terminal OngoingApiError
// rather than flowing `undefined` required fields into the domain — matching the
// `unexpected_body_shape` convention doFetch established for bad Content-Type / JSON (#107).
function mapInventoryRow(raw: unknown): OngoingInventoryRow {
  const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError("Ongoing inventory row failed schema validation", {
      kind: "terminal",
      reason: "unexpected_body_shape",
      body: parsed.error.issues,
    })
  }
  const inv = parsed.data.inventoryInfo ?? {}
  return {
    articleNumber: parsed.data.articleNumber,
    articleSystemId: parsed.data.articleSystemId,
    numberOfItems: inv.numberOfItems ?? 0,
    allocatedNumberOfItems: inv.allocatedNumberOfItems ?? 0,
    sellableNumberOfItems: inv.sellableNumberOfItems ?? 0,
    toReceiveNumberOfItems: inv.toReceiveNumberOfItems ?? 0,
  }
}

function mapTrackedOrder(raw: unknown): OngoingTrackedOrder {
  const parsed = OngoingTrackedOrderResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError("Ongoing tracked-order row failed schema validation", {
      kind: "terminal",
      reason: "unexpected_body_shape",
      body: parsed.error.issues,
    })
  }
  // Tracking lives in two spec locations: each parcel's `tracking` and the order-level
  // `tracking[]` — both GetOrderParcelTracking/GetOrderTracking { waybill, trackingUrl }.
  // Exclude return parcels (GetOrderParcel.isReturnParcel) so an RMA waybill never surfaces
  // as an outbound shipment label — mirroring the webhook path's !isReturn filter. The
  // order-level `tracking[]` is already outbound-only (returns live in the separate
  // `returnTracking[]`, which we don't read). Collect waybills from both, deduped, keeping
  // the first trackingUrl seen per waybill.
  const sources = [
    ...(parsed.data.parcels ?? []).filter((p) => !p.isReturnParcel).map((p) => p.tracking),
    ...(parsed.data.tracking ?? []),
  ]
  const tracking: OngoingTrackingRef[] = []
  const seen = new Set<string>()
  for (const t of sources) {
    const number = t?.waybill
    if (typeof number === "string" && number.length > 0 && !seen.has(number)) {
      seen.add(number)
      tracking.push({ number, url: t?.trackingUrl || undefined })
    }
  }
  return {
    ongoingOrderId: parsed.data.orderInfo.orderId,
    orderNumber: parsed.data.orderInfo.orderNumber,
    statusNumber: parsed.data.orderInfo.orderStatus.number,
    statusText: parsed.data.orderInfo.orderStatus.text,
    trackingNumbers: tracking.map((t) => t.number),
    tracking,
  }
}

// #114-a-style structural validation (see mapInventoryRow/mapTrackedOrder above) before
// mapping GET /orders/{id} into the minimal shape return-order-mapper.ts needs. A line
// without a resolvable article.articleNumber is dropped (not thrown) — an
// articleNumber-less original order line can never be matched by a return line anyway,
// and dropping it (rather than failing the whole GET) keeps a single malformed original
// line from blocking every return against that order.
function mapOrderDetail(raw: unknown): OngoingOrderDetail {
  const parsed = OngoingOrderDetailResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError("Ongoing order-detail response failed schema validation", {
      kind: "terminal",
      reason: "unexpected_body_shape",
      body: parsed.error.issues,
    })
  }
  const lines = (parsed.data.orderLines ?? [])
    .filter((l) => l.article?.articleNumber)
    .map((l) => ({ orderLineId: l.id, articleNumber: l.article!.articleNumber }))
  return { ongoingOrderId: parsed.data.orderInfo.orderId, lines }
}

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

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined
  }
  const seconds = Number(header)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

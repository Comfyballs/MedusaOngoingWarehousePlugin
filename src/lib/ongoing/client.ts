import { OngoingApiError, classifyHttpStatus } from "./errors"
import { Throttle } from "./throttle"
import type { OngoingCredentials } from "./types"
import type {
  OngoingInventoryRow,
  OngoingOrderStatus,
  OngoingTrackedOrder,
  PostOrderModel,
} from "./types"

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

  protected async request<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
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

  // --- public operations ---

  async getOrderStatuses(): Promise<OngoingOrderStatus[]> {
    const raw = await this.request<{ orderStatuses?: { number: number; text: string }[] }>(
      "GET",
      `/orders/statuses?goodsOwnerId=${this.creds.goodsOwnerId}`
    )
    return (raw?.orderStatuses ?? []).map(mapStatus)
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

  async putOrder(order: PostOrderModel): Promise<{ ongoingOrderId: number }> {
    const res = await this.request<{ orderId: number; message?: string }>("PUT", "/orders", order)
    return { ongoingOrderId: res.orderId }
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
}

const ONGOING_PAGE_SIZE = 50

function mapStatus(raw: { number: number; text: string }): OngoingOrderStatus {
  return { number: raw.number, text: raw.text }
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

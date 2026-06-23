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

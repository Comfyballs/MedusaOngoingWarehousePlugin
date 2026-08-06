import { OngoingClient, parseRetryAfter } from "../client"
import { OngoingApiError } from "../errors"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "wh-a",
  baseUrl: "https://api.example.test/api/v1",
  username: "user",
  password: "pass",
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("OngoingClient.request", () => {
  it("sends Basic auth and parses JSON on success", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
    // @ts-expect-error exercising the private method directly in a unit test
    const data = await client.request("GET", "/articles")

    expect(data).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.example.test/api/v1/articles")
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("user:pass").toString("base64"))
  })

  it("throws terminal OngoingApiError on 400 without retrying", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(400, { error: "bad" }))
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
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
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl, sleep, maxRetries: 2 })
    // @ts-expect-error private
    const data = await client.request("GET", "/x")
    expect(data).toEqual({ ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it("retries a raw network error (non-OngoingApiError) then surfaces after maxRetries", async () => {
    // A fetch-level failure (ECONNRESET / DNS / timeout) rejects the fetch promise
    // with a plain Error — not an OngoingApiError. It must be retried, not dead-lettered.
    const netErr = new TypeError("fetch failed")
    const fetchImpl = jest.fn().mockRejectedValue(netErr)
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl, sleep, maxRetries: 2 })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toBe(netErr)
    // initial try + 2 retries = 3 calls
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("retries a raw network error then succeeds", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl, sleep, maxRetries: 2 })
    // @ts-expect-error private
    const data = await client.request("GET", "/x")
    expect(data).toEqual({ ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it("honors Retry-After seconds on 429 and gives up as retryable after maxRetries", async () => {
    // A Response body can only be read once, so hand each fetch call a fresh instance.
    const fetchImpl = jest.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(429, { error: "slow" }, { "retry-after": "2" }))
    )
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl, sleep, maxRetries: 1 })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(OngoingApiError)
    // initial try + 1 retry = 2 calls
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2000)
  })

  it("throws a terminal unexpected_body_shape error when a 200 response has a non-JSON content-type", async () => {
    // Simulates an intermediary proxy/gateway returning an HTML error page with a 200
    // status (the CRIT-1 failure scenario) instead of Ongoing's real JSON response.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
    // A malformed 2xx body must not be retried — it is not a transient failure.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws a terminal unexpected_body_shape error when a 200 body is parseable JSON but the content-type is wrong", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderId: 1 }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
  })

  it("throws a terminal unexpected_body_shape error when a 200 body is truncated JSON despite a correct content-type", async () => {
    // Simulates a gateway-timeout page that cuts the body off mid-response.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('{"orderId":', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      kind: "terminal",
      status: 200,
      reason: "unexpected_body_shape",
    })
  })

  it("resolves undefined for an empty 200 body without validating content-type", async () => {
    // An empty body (e.g. a bare 204-style DELETE response) has no shape to
    // validate and must keep resolving, not throw.
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("", { status: 200, headers: {} })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl })
    // @ts-expect-error private
    const data = await client.request("DELETE", "/orders/1")
    expect(data).toBeUndefined()
  })

  it("retries an explicit 408 Request Timeout (classified retryable, bead gbl)", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(408, { error: "timeout" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }))
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { goodsOwnerId: 7, fetchImpl, sleep, maxRetries: 2 })
    // @ts-expect-error private
    const data = await client.request("GET", "/x")
    expect(data).toEqual({ ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe("parseRetryAfter (bead gbl)", () => {
  const now = Date.parse("2026-07-27T12:00:00Z")

  it("returns undefined for a missing header", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })

  it("parses the delta-seconds form to milliseconds", () => {
    expect(parseRetryAfter("2", now)).toBe(2000)
    expect(parseRetryAfter("  120 ", now)).toBe(120_000)
    expect(parseRetryAfter("0", now)).toBe(0)
  })

  it("parses the HTTP-date form relative to now", () => {
    // 30 seconds into the future.
    expect(parseRetryAfter("Mon, 27 Jul 2026 12:00:30 GMT", now)).toBe(30_000)
  })

  it("clamps a past HTTP-date to 0 (retry now)", () => {
    expect(parseRetryAfter("Mon, 27 Jul 2026 11:59:00 GMT", now)).toBe(0)
  })

  it("returns undefined for an unparseable header (falls back to backoff)", () => {
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined()
    expect(parseRetryAfter("", now)).toBeUndefined()
  })
})

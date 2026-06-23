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
    // A Response body can only be read once, so hand each fetch call a fresh instance.
    const fetchImpl = jest.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(429, { error: "slow" }, { "retry-after": "2" }))
    )
    const sleep = jest.fn().mockResolvedValue(undefined)
    const client = new OngoingClient(creds, { fetchImpl, sleep, maxRetries: 1 })
    // @ts-expect-error private
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(OngoingApiError)
    // initial try + 1 retry = 2 calls
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2000)
  })
})

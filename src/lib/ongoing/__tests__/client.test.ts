import { OngoingClient } from "../client"
import type { OngoingCredentials } from "../types"

const creds: OngoingCredentials = {
  key: "k",
  baseUrl: "https://api.example.com/api/v1",
  username: "u",
  password: "p",
}

describe("OngoingClient request timeout (bead 4s4)", () => {
  it("aborts a hung request after timeoutMs and surfaces it (retryable path)", async () => {
    // fetch hangs until the AbortController fires, then rejects like a real AbortError.
    const fetchImpl = jest.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
      maxRetries: 0,
    })

    await expect(client.getOrderStatuses()).rejects.toThrow(/abort/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it("does not abort a request that resolves before the timeout", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderStatuses: [{ number: 200, text: "Open" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new OngoingClient(creds, { goodsOwnerId: 7,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10_000,
    })

    await expect(client.getOrderStatuses()).resolves.toEqual([{ number: 200, text: "Open" }])
    // Signal was passed but never aborted (request completed in time).
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false)
  })
})

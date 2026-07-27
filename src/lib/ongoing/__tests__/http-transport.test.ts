import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { nodeHttpsFetch, toResponse } from "../http-transport"

// Regression guard for the transport swap (bead 9sp): Ongoing's server 500s on undici
// fetch's request signature, so OngoingClient defaults to this http/https adapter instead.
// These tests pin the fetch-compatible Response shape the client depends on, using a
// throwaway loopback server (no network, no creds).
describe("nodeHttpsFetch", () => {
  let server: http.Server
  let base: string
  let lastRequest: { method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        lastRequest = {
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString(),
          headers: req.headers,
        }
        if (req.url === "/bad") {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ message: "nope" }))
          return
        }
        if (req.url === "/empty") {
          res.writeHead(204)
          res.end()
          return
        }
        res.writeHead(200, { "content-type": "application/json", "x-custom": "yes" })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      done()
    })
  })

  afterAll((done) => {
    server.close(() => done())
  })

  it("returns a fetch-like Response for a 2xx (ok/status/text/headers.get)", async () => {
    const res = await nodeHttpsFetch(`${base}/thing`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("x-custom")).toBe("yes")
    expect(res.headers.get("missing")).toBeNull()
    expect(JSON.parse(await res.text())).toEqual({ ok: true })
  })

  it("surfaces a non-2xx as ok:false with the body intact (no throw)", async () => {
    const res = await nodeHttpsFetch(`${base}/bad`, { method: "GET" })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(JSON.parse(await res.text())).toEqual({ message: "nope" })
  })

  it("handles an empty 204 body without throwing (null-body status)", async () => {
    const res = await nodeHttpsFetch(`${base}/empty`, { method: "DELETE" })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  it("sends a request body with an explicit Content-Length (framed, not chunked)", async () => {
    const payload = JSON.stringify({ articleNumber: "A1" })
    await nodeHttpsFetch(`${base}/orders`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
    expect(lastRequest.method).toBe("PUT")
    expect(lastRequest.body).toBe(payload)
    expect(lastRequest.headers["content-length"]).toBe(String(Buffer.byteLength(payload)))
    expect(lastRequest.headers["transfer-encoding"]).toBeUndefined()
  })

  it("rejects when aborted via signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      nodeHttpsFetch(`${base}/thing`, { method: "GET", signal: controller.signal })
    ).rejects.toBeDefined()
  })
})

// The Response ctor throws a RangeError if a body is paired with a null-body status
// (204/205/304). In the live transport this throw would fire inside an async 'end'
// callback and hang the fetch Promise forever, so `toResponse` must never throw. Node's
// own HTTP client parser refuses to deliver a body on those statuses, so this branch is
// only reachable via a malformed upstream — hence a direct unit test of the builder (bead 0y1).
describe("toResponse", () => {
  it("drops a stray body on a null-body status instead of throwing (204-with-body)", async () => {
    const res = toResponse(204, Buffer.from("hello"), { "content-type": "text/plain" })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  it.each([205, 304])("drops a stray body on %d as well", async (status) => {
    const res = toResponse(status, Buffer.from("stray"), {})
    expect(res.status).toBe(status)
    expect(await res.text()).toBe("")
  })

  it("keeps the body for an ordinary 200", async () => {
    const res = toResponse(200, Buffer.from(JSON.stringify({ ok: true })), {
      "content-type": "application/json",
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toEqual({ ok: true })
  })

  it("passes an empty body through unchanged (bare 204)", async () => {
    const res = toResponse(204, Buffer.alloc(0), {})
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })
})

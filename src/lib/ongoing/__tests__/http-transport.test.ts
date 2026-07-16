import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { nodeHttpsFetch } from "../http-transport"

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

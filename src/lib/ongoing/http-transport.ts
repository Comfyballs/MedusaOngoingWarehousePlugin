import * as http from "node:http"
import * as https from "node:https"

// Default HTTP transport for OngoingClient — a fetch-compatible adapter over Node's
// built-in http/https modules.
//
// WHY NOT global fetch: Ongoing's REST API (IIS + WAF) rejects requests made by Node's
// global `fetch` (undici's high-level fetch) with a 500 `{"Message":"An error has
// occurred."}` — on EVERY call, including a trivial authenticated GET /orders/statuses.
// Verified live against the real API (bead 9sp): curl, Node's https module, and
// undici's low-level `request()` all return 200 with identical headers/TLS/HTTP-1.1 in
// the same process; only undici `fetch` 500s. The trigger is fetch's on-the-wire request
// serialization (not header values, not auth, not TLS — all ruled out), which the server
// refuses. Routing through the https module sidesteps it with zero new dependencies.
//
// Returns a real WHATWG `Response`, so OngoingClient.doFetch (res.ok / res.status /
// res.text() / res.headers.get()) and the unit tests (which inject Response-returning
// fetch stubs) see an identical shape.
export const nodeHttpsFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.toString()
  const u = new URL(url)
  const mod = u.protocol === "http:" ? http : https

  const method = (init?.method ?? "GET").toUpperCase()
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) }
  const bodyBuf =
    init?.body == null ? undefined : Buffer.from(init.body as string)
  // Send an explicit Content-Length so the write goes out as a normal framed body
  // rather than chunked transfer-encoding (which some servers reject on PUT).
  if (bodyBuf) {
    headers["content-length"] = String(bodyBuf.length)
  }

  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      u,
      { method, headers, signal: init?.signal ?? undefined },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const buf = Buffer.concat(chunks)
          // Flatten Node's header bag (values may be string | string[]) into a
          // Headers-safe record; drop undefined.
          const outHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) {
              continue
            }
            outHeaders[k] = Array.isArray(v) ? v.join(", ") : v
          }
          const status = res.statusCode ?? 502
          // The Response ctor throws a RangeError if a body is supplied with a
          // null-body status (204/205/304) — and an empty 2xx (e.g. a bare DELETE)
          // has no body anyway — so pass null for a zero-length payload.
          const body = buf.length > 0 ? buf : null
          resolve(new Response(body, { status, headers: outHeaders }))
        })
        res.on("error", reject)
      }
    )
    req.on("error", reject)
    if (bodyBuf) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

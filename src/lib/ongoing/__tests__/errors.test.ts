import { OngoingApiError, classifyHttpStatus, classifyError } from "../errors"

describe("classifyHttpStatus", () => {
  it("treats 429 and 5xx as retryable", () => {
    expect(classifyHttpStatus(429)).toBe("retryable")
    expect(classifyHttpStatus(500)).toBe("retryable")
    expect(classifyHttpStatus(503)).toBe("retryable")
  })

  it("treats 4xx (except 429) as terminal", () => {
    expect(classifyHttpStatus(400)).toBe("terminal")
    expect(classifyHttpStatus(401)).toBe("terminal")
    expect(classifyHttpStatus(404)).toBe("terminal")
    expect(classifyHttpStatus(422)).toBe("terminal")
  })
})

describe("classifyError", () => {
  it("passes through an OngoingApiError's kind", () => {
    expect(classifyError(new OngoingApiError("r", { kind: "retryable", status: 503 }))).toBe(
      "retryable"
    )
    expect(classifyError(new OngoingApiError("t", { kind: "terminal", status: 400 }))).toBe(
      "terminal"
    )
  })

  it("treats a raw/unknown error (network failure) as retryable", () => {
    // ECONNRESET / timeout / DNS / a fetch TypeError are not OngoingApiError and
    // must NOT be dead-lettered as terminal.
    expect(classifyError(new Error("ECONNRESET"))).toBe("retryable")
    expect(classifyError(new TypeError("fetch failed"))).toBe("retryable")
    expect(classifyError("boom")).toBe("retryable")
    expect(classifyError(undefined)).toBe("retryable")
  })
})

describe("OngoingApiError", () => {
  it("carries status, kind, and body", () => {
    const err = new OngoingApiError("boom", { status: 500, kind: "retryable", body: { e: 1 } })
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(500)
    expect(err.kind).toBe("retryable")
    expect(err.body).toEqual({ e: 1 })
  })

  it("carries an optional reason for finer-grained terminal classification", () => {
    const err = new OngoingApiError("boom", {
      status: 200,
      kind: "terminal",
      reason: "unexpected_body_shape",
      body: "<html>",
    })
    expect(err.reason).toBe("unexpected_body_shape")
  })
})

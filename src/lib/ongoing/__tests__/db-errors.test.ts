import { isUniqueViolation } from "../db-errors"

describe("isUniqueViolation", () => {
  it("detects a Postgres unique_violation (SQLSTATE 23505) on the error itself", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true)
  })

  it("detects it when MikroORM wraps the driver error under .cause", () => {
    expect(isUniqueViolation({ name: "UniqueConstraintViolationException", cause: { code: "23505" } })).toBe(true)
  })

  it("detects it under the older .previous chain", () => {
    expect(isUniqueViolation({ previous: { previous: { code: "23505" } } })).toBe(true)
  })

  it("returns false for a different SQLSTATE (e.g. 23503 FK violation)", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false)
  })

  it("returns false for a plain error / null / undefined", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  it("does not loop forever on a self-referential cause chain", () => {
    const cyclic: { code?: string; cause?: unknown } = { code: "x" }
    cyclic.cause = cyclic
    expect(isUniqueViolation(cyclic)).toBe(false)
  })
})

import { MedusaError } from "@medusajs/framework/utils"
import { isUniqueViolation } from "../db-errors"

describe("isUniqueViolation", () => {
  describe("already-mapped Medusa shape (mainline)", () => {
    it("detects MedusaError(INVALID_DATA) whose message says 'already exists'", () => {
      const mapped = new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Ongoing integration with credential_key: wh-1, already exists."
      )
      expect(isUniqueViolation(mapped)).toBe(true)
    })

    it("does NOT treat other INVALID_DATA errors as duplicates (e.g. NOT NULL)", () => {
      const notNull = new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cannot set field 'credential_key' of Ongoing integration to null"
      )
      expect(isUniqueViolation(notNull)).toBe(false)
    })

    it("does NOT treat a different MedusaError type with 'already exists' text as a duplicate", () => {
      const other = new MedusaError(MedusaError.Types.NOT_ALLOWED, "already exists somewhere")
      expect(isUniqueViolation(other)).toBe(false)
    })
  })

  describe("raw driver shape (edge: unparseable constraint detail)", () => {
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

    it("does not loop forever on a self-referential cause chain", () => {
      const cyclic: { code?: string; cause?: unknown } = { code: "x" }
      cyclic.cause = cyclic
      expect(isUniqueViolation(cyclic)).toBe(false)
    })
  })

  it("returns false for a plain error / null / undefined", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })
})

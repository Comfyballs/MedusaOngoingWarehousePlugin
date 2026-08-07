import { MedusaError } from "@medusajs/framework/utils"
import { validateIntervalString } from "../interval-validation"

// bead atq: validateIntervalString must match validateIntervalOption's
// parseInt-based semantics exactly (src/modules/ongoing/options.ts) — same
// accept/reject boundary for every case, since the two guard the same value at
// different layers (boot-time plugin options vs. a stored DB row).
describe("validateIntervalString", () => {
  it.each(["900000", "1", "600000"])("accepts a positive integer string (%s)", (value) => {
    expect(() => validateIntervalString(value, "stock_sync_interval")).not.toThrow()
  })

  it.each(["0", "-5", "abc", "", "  ", "NaN"])(
    "rejects a non-positive or non-numeric value (%p)",
    (value) => {
      expect(() => validateIntervalString(value, "stock_sync_interval")).toThrow(MedusaError)
      expect(() => validateIntervalString(value, "stock_sync_interval")).toThrow(
        /stock_sync_interval must be a positive integer/
      )
    }
  )

  it("parses a leading-numeric string permissively, matching parseInt (parity with validateIntervalOption)", () => {
    // parseInt("900000ms", 10) === 900000 — not a value the admin form would ever
    // send, but the check must agree with resolveIntervalMs's own parseInt call.
    expect(() => validateIntervalString("900000ms", "status_poll_interval")).not.toThrow()
  })
})

import { MedusaError } from "@medusajs/framework/utils"

// A Postgres unique_violation reaches a step's `catch` in one of TWO shapes,
// because Medusa's MedusaService repository layer wraps every create/update in
// `transaction(...).catch(dbErrorMapper)`
// (@medusajs/utils dal/mikro-orm/mikro-orm-repository.js):
//
//   1. ALREADY-MAPPED (the mainline): dbErrorMapper recognises SQLSTATE 23505 and
//      throws `MedusaError(INVALID_DATA, "<Table> with <col>: <val>, already
//      exists.")`. That maps to HTTP 400 — a typed error, but NOT the 422 a
//      duplicate resource warrants. This is what actually reaches us for a real
//      duplicate credential_key / stock_location_id.
//   2. RAW (edge): if the driver error carries no parseable `detail`,
//      dbErrorMapper `throw err`s the original MikroORM
//      `UniqueConstraintViolationException` unchanged, whose SQLSTATE lives on
//      `.code` (and, when wrapped, `.cause`/`.previous`).
//
// Detect both so the caller can re-tag the failure as a DUPLICATE_ERROR (422).
const PG_UNIQUE_VIOLATION = "23505"

function isMappedUniqueViolation(err: unknown): boolean {
  // Compare on `.type` (a string) rather than `instanceof` to stay robust
  // against dual-package MedusaError class identities. INVALID_DATA is also used
  // for NOT NULL / bad-column errors, so the "already exists" message suffix
  // dbErrorMapper emits is what disambiguates a unique violation specifically.
  const e = err as { type?: unknown; message?: unknown }
  return (
    e?.type === MedusaError.Types.INVALID_DATA &&
    typeof e.message === "string" &&
    /already exists/i.test(e.message)
  )
}

function isRawUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: unknown; cause?: unknown; previous?: unknown }
    if (e.code === PG_UNIQUE_VIOLATION) {
      return true
    }
    const next = e.cause ?? e.previous
    if (next === cur) {
      break
    }
    cur = next
  }
  return false
}

export function isUniqueViolation(err: unknown): boolean {
  return isMappedUniqueViolation(err) || isRawUniqueViolation(err)
}

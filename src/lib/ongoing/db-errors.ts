// Postgres SQLSTATE 23505 = unique_violation. MikroORM (Medusa's ORM) surfaces
// the driver error with the SQLSTATE copied onto `.code`, but sometimes wraps
// the original driver error inside a `UniqueConstraintViolationException` under
// `.cause` (or the older `.previous`). Match the SQLSTATE directly, walking a
// short cause chain, rather than keying on a MikroORM class name — that keeps us
// decoupled from ORM internals while still catching the wrapped case.
const PG_UNIQUE_VIOLATION = "23505"

export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: unknown; cause?: unknown; previous?: unknown }
    if (e.code === PG_UNIQUE_VIOLATION) {
      return true
    }
    cur = e.cause ?? e.previous
  }
  return false
}

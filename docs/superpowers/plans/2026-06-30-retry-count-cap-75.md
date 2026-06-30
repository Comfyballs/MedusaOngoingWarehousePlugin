# Plan: Retry driver must cap on `OngoingOrderSync.retry_count` (dead-letter deterministic failures) (#75)

## Problem

#67 made unknown/network failures classify as `retryable` (correct — avoids
dead-lettering on a transient outage). The consequence the #67/#73 review flagged: once a
**retry driver** exists (issue #39, milestone M4 — `retryFailedSyncs`, re-runs sync rows
where `sync_state = "error" AND error_class = "retryable"`), a *deterministic*
non-network failure — a programming bug, or malformed-but-non-`OngoingApiError` data that
`classifyError` defaults to `retryable` — would be retried **forever** instead of being
dead-lettered.

`src/modules/ongoing/models/order-sync.ts` already carries `retry_count: model.number().default(0)`,
so a max-attempts cap was anticipated by the schema. The requirement for the eventual
retry driver: honor `retry_count` as a ceiling and, after N attempts, stop retrying and
mark the row terminal/dead-lettered.

### Locked scope (from research)

`retry_count` is **never incremented today** and **no retry driver exists yet** (the only
consumer is #39 in M4). Therefore #75 does **not** change any existing workflow step and
does **not** wire a consumer. It delivers one thing: a **small, pure, TDD-tested helper**
that encodes the cap + dead-letter decision, plus a **documented consumption contract** so
#39 can adopt it without re-litigating the design. It is not a no-op.

### Design decisions (locked — do not re-open)

- **Dead-letter representation:** flip `error_class` from `"retryable"` to `"terminal"`.
  No new `sync_state` value, **no migration**. The retry driver's query
  (`sync_state = "error" AND error_class = "retryable"`) then naturally **excludes** the
  row — flipping `error_class` to `"terminal"` is what dead-letters it, with zero schema
  change. `retry_count > 0` distinguishes "exhausted its retries" from "terminal on the
  first attempt" in admin/dashboard queries.
- **Max retry ceiling:** `5`, exported as `MAX_SYNC_RETRIES`.
- **Scope boundary — NOT the HTTP retry count:** `OngoingClient.maxRetries`
  (`src/lib/ongoing/client.ts:31`, default `3`) governs **per-HTTP-call** transient
  retries *inside a single sync invocation*. #75 governs **workflow-level re-invocation**
  counting across separate driver passes. These are different layers; do not conflate
  them and do not touch `client.ts`.
- **Purity:** the helper takes plain data and returns plain data — no DB, no container, no
  `MedusaService`. #39 calls it, then persists the result via the existing
  `updateOngoingOrderSyncs` auto-CRUD method. This keeps it unit-testable with no Medusa
  test harness (matches `src/lib/ongoing/resolve-article-number.ts`).

### Why no model / migration change

`Migration20260623211927.ts` already created every column this needs: `retry_count`
(default `0`), `error_class` enum `["retryable","terminal"]` nullable, `last_error`
nullable, and the `sync_state` enum is a five-value DB CHECK constraint
(`["pending","sent","shipped","cancelled","error"]`). The dead-letter signal rides on the
existing `error_class` flip, so there is nothing to generate or migrate.

## Approach

Add one pure module `src/lib/ongoing/retry-policy.ts`:

- Export const `MAX_SYNC_RETRIES = 5`.
- Export type `RetryPolicyInput = { retry_count: number; error_class: "retryable" | "terminal" | null }`.
- Export type `RetryOutcome = { retry_count: number; error_class: "retryable" | "terminal"; dead_lettered: boolean }`.
- Export function
  `resolveRetryOutcome(input: RetryPolicyInput, maxRetries = MAX_SYNC_RETRIES): RetryOutcome`.

Semantics — call this for a row that **just failed again**, *before* re-invoking the sync:

1. **Already `"terminal"`** (`input.error_class === "terminal"`): a deterministic failure
   that should not be retried at all. Return `{ retry_count: input.retry_count, error_class: "terminal", dead_lettered: true }`
   — `retry_count` is unchanged (no attempt was, or should be, spent on it).
2. **`"retryable"` or `null`** (an in-flight retryable failure; `null` is treated as
   retryable, matching `classifyError`'s default and the model's nullable column): compute
   `newCount = input.retry_count + 1`.
   - If `newCount >= maxRetries`: the cap is reached — return
     `{ retry_count: newCount, error_class: "terminal", dead_lettered: true }`.
   - Else: keep retrying — return
     `{ retry_count: newCount, error_class: "retryable", dead_lettered: false }`.

Boundary precisely: with `maxRetries = 5`, `retry_count` 3→4 stays retryable, 4→5 flips to
terminal + dead-lettered (the 5th attempt is the last and exhausts the ceiling). Use `>=`
so any out-of-range stored count (e.g. already `>= 5`) also dead-letters rather than
looping.

Export from the lib barrel `src/lib/ongoing/index.ts` (append-only, matching the existing
export lines):

```ts
export { resolveRetryOutcome, MAX_SYNC_RETRIES } from "./retry-policy"
export type { RetryPolicyInput, RetryOutcome } from "./retry-policy"
```

Give the function a JSDoc block in the style of `resolve-article-number.ts` that states:
the cap, the dead-letter-via-`error_class`-flip mechanism, that `null` is treated as
retryable, that it is pure, and a one-line pointer to the #39 consumption contract below.

### What this issue explicitly does NOT do

- No change to `src/workflows/steps/push-order-record-sync.ts`,
  `src/workflows/steps/upsert-ongoing-order-edit.ts`, or any other existing step/workflow.
- No new `sync_state` value, no model edit, no `npx medusa plugin:db:generate`, no
  migration.
- No widening of `RecordSyncInput` in `src/modules/ongoing/service.ts` —
  `RecordSyncInput` has **no** `retry_count` field and gains none here. The retry driver
  (#39) persists `retry_count` by calling `updateOngoingOrderSyncs` directly (see
  contract), not through `recordSync`.
- No consumer wiring, job, or subscriber. #39 owns all of that.

## Consumption contract for #39 (`retryFailedSyncs`) — documented, not built here

Record this in the plan and in the helper's JSDoc so #39 inherits the decision:

1. #39's driver queries rows with `sync_state = "error" AND error_class = "retryable"`
   (e.g. via `listOngoingOrderSyncs({ sync_state: "error", error_class: "retryable" })`).
2. For each candidate row, **before** re-invoking the sync, call
   `resolveRetryOutcome({ retry_count: row.retry_count, error_class: row.error_class })`.
3. If `outcome.dead_lettered === true`: **do not re-invoke**. Persist the terminal state
   directly via the existing auto-CRUD update —
   `await service.updateOngoingOrderSyncs({ id: row.id, retry_count: outcome.retry_count, error_class: "terminal" })`
   — so the row drops out of the `error AND retryable` query on the next pass.
4. If `outcome.dead_lettered === false`: persist the incremented count
   (`updateOngoingOrderSyncs({ id: row.id, retry_count: outcome.retry_count })`) and then
   re-invoke the sync. (A successful re-invocation overwrites the row via the normal
   `recordSync` path; a fresh failure goes through `resolveRetryOutcome` again next pass.)

Field-placement note (decided): `retry_count` lives on `OngoingOrderSync` only and is
written **exclusively** through `updateOngoingOrderSyncs` by the driver. It is
deliberately kept off `RecordSyncInput`/`recordSync` so the success/normal-write path
never has to reason about attempt counting — counting is the driver's concern alone.

## Tasks (TDD — failing test first, then implement)

The helper is pure business logic, so per `superpowers:test-driven-development` the test
is written first and must fail (module does not yet exist) before the implementation.

1. **Write the failing test** `src/lib/ongoing/__tests__/retry-policy.test.ts`
   (jest, `describe`/`it`, table-driven in the style of
   `src/lib/ongoing/__tests__/resolve-article-number.test.ts`). Import
   `resolveRetryOutcome, MAX_SYNC_RETRIES` from `../retry-policy`. Cover:
   - `MAX_SYNC_RETRIES === 5` (pin the constant).
   - retryable, `retry_count` 0 → outcome `{ retry_count: 1, error_class: "retryable", dead_lettered: false }`.
   - retryable, `retry_count` 3 → `{ retry_count: 4, error_class: "retryable", dead_lettered: false }`.
   - retryable, `retry_count` 4 → `{ retry_count: 5, error_class: "terminal", dead_lettered: true }` (cap boundary, the load-bearing case).
   - `error_class: null`, `retry_count` 0 → treated as retryable → `{ retry_count: 1, error_class: "retryable", dead_lettered: false }`.
   - `error_class: null` at the boundary, `retry_count` 4 → `{ retry_count: 5, error_class: "terminal", dead_lettered: true }`.
   - already `error_class: "terminal"`, `retry_count` 2 → `{ retry_count: 2, error_class: "terminal", dead_lettered: true }` (unchanged count, no further retry).
   - a stored `retry_count` already at/over the cap, retryable, `retry_count` 5 → `{ retry_count: 6, error_class: "terminal", dead_lettered: true }` (guards `>=`, never loops).
   - explicit `maxRetries` override, e.g. `resolveRetryOutcome({ retry_count: 0, error_class: "retryable" }, 1)` → `{ retry_count: 1, error_class: "terminal", dead_lettered: true }` (proves the parameter is honored, not hard-coded).

   Run `yarn test src/lib/ongoing/__tests__/retry-policy.test.ts` and confirm it FAILS
   (cannot resolve `../retry-policy`).

2. **Implement** `src/lib/ongoing/retry-policy.ts` per the Approach section
   (`MAX_SYNC_RETRIES`, `RetryPolicyInput`, `RetryOutcome`, `resolveRetryOutcome`, JSDoc
   with the #39 contract pointer). Re-run
   `yarn test src/lib/ongoing/__tests__/retry-policy.test.ts` and confirm it PASSES.

3. **Export** from the barrel `src/lib/ongoing/index.ts` (append the two lines shown in
   Approach). No other file changes.

## Verification

- `yarn lint` — clean on the changed files (`retry-policy.ts`, the test, the barrel).
- `yarn build` — `medusa plugin:build` compiles with no type errors.
- `yarn test src/lib/ongoing/__tests__/retry-policy.test.ts` — the new suite green.
- `yarn test` — full suite still green (no existing test touched, so no regression
  expected; running it confirms the barrel addition did not break an import).

## Out of scope / follow-ups

- The actual `retryFailedSyncs` driver, its scheduling, and the `updateOngoingOrderSyncs`
  wiring described in the contract land in **#39 (M4)** — not here.
- No admin/dashboard surfacing of dead-lettered rows is added here; if a "dead-lettered"
  filter or badge is wanted, open a separate issue when #39 lands.

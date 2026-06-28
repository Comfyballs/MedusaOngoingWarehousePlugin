# Plan: Classify unknown/network errors as retryable (#67)

## Problem

Three sites treat a non-`OngoingApiError` (raw network error: ECONNRESET / timeout /
DNS / `fetch` TypeError) as terminal/non-retryable, so a brief outage permanently
flags a sync row `terminal` and requires manual intervention:

1. `src/lib/ongoing/client.ts` retry loop — only retries `OngoingApiError` with
   `kind === "retryable"`; a raw network error is never retried.
2. `src/workflows/steps/push-order-record-sync.ts` catch — `instanceof OngoingApiError
   ? err.kind : undefined`, unknown → `error_class = "terminal"`.
3. `src/workflows/steps/upsert-ongoing-order-edit.ts` catch — same pattern.

Genuine business/validation errors (order-mapper, resolve-article-number) already
throw `OngoingApiError` with `kind: "terminal"`, so they keep flowing as terminal —
only unknown/network errors change behavior.

## Approach

- Add `classifyError(err: unknown): OngoingErrorKind` to `src/lib/ongoing/errors.ts`:
  `err instanceof OngoingApiError ? err.kind : "retryable"` (unknown defaults to
  retryable). Export it from the lib barrel `src/lib/ongoing/index.ts` (append-only).
- Client retry loop: retry when `classifyError(err) === "retryable"` (network errors
  retried, still bounded by `maxRetries`); guard the backoff line so it tolerates a
  non-`OngoingApiError`: `err instanceof OngoingApiError ? err.retryAfterMs : undefined`.
- Both step handlers: replace the instanceof/undefined→terminal logic with
  `const errorClass = classifyError(err)`.

## Tasks (TDD — failing test first per piece)

1. Unit-test `classifyError`: retryable/terminal `OngoingApiError` pass through;
   plain `Error` / unknown → "retryable". Implement in `errors.ts`; export from barrel.
2. Client retry test: a `fetchImpl` rejecting with a network-style error is retried up
   to `maxRetries` then surfaces (inject `sleep`/`fetchImpl`/`maxRetries`). Implement.
3. Step tests (both steps): an unknown (non-`OngoingApiError`) failure records
   `error_class: "retryable"`. Update existing terminal-expectation tests to retryable.
   Implement both catch blocks.

## Verification

- `yarn lint` (changed files clean)
- `yarn build`
- `yarn test` (all green)

This page lists the Medusa v2 rules a contributor to this plugin must follow. They are what the required Medusa-aware review checks, and a generic reviewer will miss them. Each rule notes how this codebase already satisfies it, so you can match the existing pattern. For where these rules live in the code, see [[Dev Architecture]]; for the review gate itself, see [[Dev Contributing]].

Before implementing backend changes, load the **`medusa-dev:building-with-medusa`** skill; for `src/admin/**`, also **`medusa-dev:building-admin-dashboard-customizations`**.

## Wrap mutations in workflows

Any state change — writing a sync row, calling Ongoing, creating a shipment, updating an integration — goes through a workflow, not directly in a route, subscriber, or provider method. Routes and subscribers may **read** via the module service or `query.graph`, but they mutate only by running a workflow.

There is one documented deviation: `status-poll.ts` writes `updateOngoingOrderSyncs` / `updateOngoingIntegrations` directly for bookkeeping. It is flagged `arch-workflow-required` and tracked in bead `o6c`. Do not add new direct mutations; the webhook's equivalent status write already goes through `refreshOngoingOrderStatusWorkflow`, and new writes should follow that path.

## No PUT or PATCH routes

Medusa's admin API convention forbids `PUT` and `PATCH`. Partial updates use `POST` with PATCH semantics — see `POST /admin/ongoing/integrations/:id`, which updates an existing row. If you are tempted to "fix" that into a `PUT`, don't; it is deliberate.

## Preserve module isolation

There is exactly one custom module, `ongoing`. Do not call another module's service directly across a module boundary. Cross-model references use `defineLink` under `src/links/` (stock-location to integration, order-sync to order, order-sync to fulfilment), and reads join through `query.graph`. Keep it that way.

## Use `MedusaError`, not generic `Error`

Throw `MedusaError` with the right type so Medusa maps it to the correct HTTP status. This codebase does this throughout — for example unique-constraint violations are re-tagged as `MedusaError(DUPLICATE_ERROR)` (422 rather than 400), and the order mapper and article resolver throw `MedusaError`/terminal `OngoingApiError` on data problems. A bare `Error` becomes an opaque 500. The one intentional plain-`Error` throw is `Throttle`'s constructor guard, which is a programmer-error assertion, not a request path.

## Store prices as-is, not in cents

Medusa stores prices as-is (not scaled to cents). The order mapper sends `prices.linePrice = unit_price` **verbatim, with no ×100**. If you touch price mapping, keep it as-is; multiplying by 100 would inflate every line price 100×. The rule is comment-documented but not enforced by a check, so it is easy to break — be deliberate.

## Follow workflow-composition constraints

Inside `createWorkflow` you may use only `function`, `transform`, `when`, and step calls. **No** `async`, arrow-function step bodies with awaits, raw `await`s, or plain `if`/`else` control flow — conditional execution is expressed with `when(...)`, and data reshaping with `transform(...)`. The workflows here are composed this way; match that shape. Business logic that needs `async`/conditionals belongs inside a **step** (or a pure helper the step calls), not in the workflow body.

## Use `query.graph` vs `query.index` correctly

Use `query.graph` for the graph-of-links reads this plugin does (fulfilment plus linked order, sync rows plus tracking labels). Do not reach for `query.index` where `query.graph` is correct. The existing usage is correct throughout — copy the nearest existing call rather than inventing a new pattern.

## Service methods are async

Methods on a `MedusaService` are async by convention. This codebase has two deliberate sync exceptions (`getCredentials`, `getClient`) that carry an eslint-disable and a rationale comment because they are pure in-memory lookups. Do not add new sync service methods without that same explicit justification.

## Related pages

- [[Dev Architecture]]
- [[Dev Contributing]]
- [[Dev Testing]]
- [[Dev Gotchas]]

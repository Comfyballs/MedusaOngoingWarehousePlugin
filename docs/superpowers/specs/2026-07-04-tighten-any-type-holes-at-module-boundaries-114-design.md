# Design: Tighten `any` type holes at every module boundary (#114)

**Status:** design
**Epic:** GitHub issue #114 (P1, milestone M6: Post-launch hardening)
**Source review:** whole-project Medusa-aware code review 2026-07-02, cross-shard P1 finding
**Recommends:** decompose into 4 sub-task issues, one per boundary class

## Problem

`any` is used consistently at every module boundary in the plugin:

- **REST edge** — `client.ts` returns `raw: any` from Ongoing's REST API, then hand-drills fields into typed rows (I1 `mapInventoryRow`, I2 `mapTrackedOrder`). Fields Ongoing omits at runtime (e.g. `article` on inventory rows) silently flow into required fields as `undefined`, and downstream code operates on them without noticing.
- **Container parameter** — 25 workflow-step handlers signed `{ container }: { container: any }`. Losing the `MedusaContainer` type here means renaming a resolvable service or its methods is compile-clean everywhere — bugs surface at runtime as "not a function".
- **Event bus** — 7 sites resolve `Modules.EVENT_BUS` as `any` (subscribers, jobs, one step). Any typo in `.emit(...)` payload shape or method name goes undetected.
- **Remote query** — I3 `re-query-fulfillment-order.ts` signs `query: any`, losing type safety on `query.graph({...})` entity/fields.
- **Scoped-out: I6/I7** — `input as any` in `createOngoingIntegrations` / `updateOngoingIntegrations`. The author documented this as an intentional DTO/`model.json()` type mismatch (generated `Record<string, unknown> | null` vs actual `number[] | null`). This is a code-generation shape problem, not a boundary-typing hole. **Explicitly out of scope for #114.** If we want to address it, file a separate issue about the `shipped_status_codes`/`cancellable_status_codes` model shape.

## Non-goals

- Adding schema validation for internal (Medusa-owned) DTOs. Only the untrusted REST edge gets runtime validation.
- Fixing I6/I7. Scoped out above.
- Rewriting the workflow-step signatures to something exotic (e.g. custom framework wrappers). Keep Medusa's `createStep` signature; only replace `any` with the framework's own exported types.
- A "big-bang" single-PR refactor. Broken up per boundary (see Decomposition).

## Recommended approach

1. **REST edge (I1, I2) — runtime validation with Zod.** Add Zod as a runtime dependency. Introduce a `src/lib/ongoing/schemas.ts` that exports Zod schemas for the Ongoing response shapes that today feed `mapInventoryRow` / `mapTrackedOrder`. Replace `raw: any` with `raw: unknown` and parse it. On parse failure, throw `OngoingApiError({ kind: "terminal", reason: "unexpected_body_shape" })` — the same error kind PR #118 already introduced for malformed 2xx bodies, so the retry/error-classification path stays uniform. This is the only boundary that gets a schema library — all other boundaries below are type-only and add no runtime code.
2. **`container: any` (25 sites) — type-only alias.** Replace `container: any` with `MedusaContainer` imported from `@medusajs/framework/types`. `container.resolve(ONGOING_MODULE) as OngoingModuleService` at the top of each handler stays; the `as any` residuals at resolve sites get tightened to `as OngoingModuleService` in the same pass.
3. **EventBus (7 sites) — narrow interface.** Type `resolve(Modules.EVENT_BUS)` as `IEventBusModuleService` from `@medusajs/types`. No runtime change; type-only.
4. **`query: any` (I3) — `RemoteQueryFunction`.** Type `re-query-fulfillment-order.ts`'s `query` parameter as `RemoteQueryFunction` from `@medusajs/types`. Type-only.

Order of landing matters: **Zod (1) is the highest-risk item** (new dep, first schema, runtime behavior on malformed 2xx). Land it first so mechanical refactors (2/3/4) don't compete with it in review or in `client.ts`-touching merge conflicts.

## Alternatives considered

- **Inline validators everywhere (no schema lib).** Would follow PR #118/#120 precedent. Rejected because I1/I2 have nested shape (`raw.article?.articleNumber`, `raw.parcels[].parcelTracking?.code`) that inline `if` chains handle poorly and produce inconsistent error messages. Zod's `.safeParse().error.issues` gives a single structured failure diagnostic. Also: doing I1/I2 inline means each future response shape gets its own bespoke validator, drifting from a single edge convention.
- **Valibot instead of Zod.** Smaller runtime bundle, but this is a Node-only backend plugin (no browser bundle), bundle size is irrelevant. Zod is what Medusa v2 examples ship. Reject.
- **One PR that touches everything.** The epic body already recommends decomposition, and the boundaries have independent mechanics (runtime schema vs type-only alias). One PR would be a large review + high merge-conflict risk. Reject.
- **Fix I6/I7 in the same epic.** Different problem class (generated DTO shape, not boundary typing). Keeping it separate keeps this epic focused and lets I6/I7 wait until we decide whether to change the model column types or leave the documented cast in place.

## Decomposition

Four sub-task issues, filed under #114 via the native GitHub sub-issue relationship:

- **#114-a — REST edge validation with Zod (I1, I2)** — priority `high` within the epic. Adds `zod` to `dependencies`. Introduces `src/lib/ongoing/schemas.ts`. Rewrites `mapInventoryRow` and `mapTrackedOrder` to parse first. Extends `OngoingApiError`'s `unexpected_body_shape` usage. Own plan.
- **#114-b — Type `container: any` → `MedusaContainer` in workflow steps (25 sites)** — mechanical rewrite across `src/workflows/steps/*.ts`. Also tightens the few remaining `container.resolve(ONGOING_MODULE) as any` sites to `as OngoingModuleService` in the same pass. Own plan.
- **#114-c — Type EVENT_BUS resolves as `IEventBusModuleService` (7 sites)** — subscribers + jobs + one step. Own plan.
- **#114-d — Type `query: any` as `RemoteQueryFunction` (I3)** — `re-query-fulfillment-order.ts` + audit any other `query: any` residuals. Own plan.

Each sub-issue gets its own plan under `docs/superpowers/plans/` and its own PR. Parent #114 closes when the last sub-issue closes (native rollup).

## Architecture: REST-edge validation (sub-issue #114-a)

New file `src/lib/ongoing/schemas.ts` — Zod schemas for the two response shapes today's `map*` functions parse:

```ts
// Illustrative, not final wording — final field set matches what mapInventoryRow
// and mapTrackedOrder actually read from the response.
export const OngoingInventoryRowResponseSchema = z.object({
  article: z.object({
    articleNumber: z.string(),
    articleSystemId: z.number(),
  }).optional(),
  totalItems: z.object({
    NumberOfItemsDecimal: z.number().optional(),
    AllocatedNumberOfItems: z.number().optional(),
    SellableNumberOfItems: z.number().optional(),
    ToReceiveNumberOfItems: z.number().optional(),
  }).optional(),
})

export const OngoingTrackedOrderResponseSchema = z.object({
  orderInfo: z.object({
    orderId: z.number().optional(),
    orderNumber: z.string().optional(),
    orderStatus: z.object({
      number: z.number().optional(),
      text: z.string().optional(),
    }).optional(),
  }).optional(),
  parcels: z.array(z.object({
    parcelTracking: z.object({ code: z.string().optional() }).optional(),
    trackingNumber: z.string().optional(),
  })).optional(),
})
```

`mapInventoryRow` / `mapTrackedOrder` become:

```ts
function mapInventoryRow(raw: unknown): OngoingInventoryRow {
  const parsed = OngoingInventoryRowResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OngoingApiError({
      kind: "terminal",
      reason: "unexpected_body_shape",
      // ... include parsed.error.issues[0] for diagnosis
    })
  }
  // build the row from parsed.data (typed)
}
```

**Interaction with #118/#120:** those PRs added the `unexpected_body_shape` terminal-error kind and validated `Content-Type` + JSON-parseability. #114-a adds a *third* layer — structural validation on the parsed JSON. Same error kind, same non-retry semantics, one uniform failure path.

## Architecture: type-only rewrites (#114-b, -c, -d)

No new runtime code. Add imports:

- `#114-b`: `import type { MedusaContainer } from "@medusajs/framework/types"` in each affected step file. Replace `{ container }: { container: any }` with `{ container }: { container: MedusaContainer }`. Tighten any `container.resolve(ONGOING_MODULE) as any` → `as OngoingModuleService`.
- `#114-c`: `import type { IEventBusModuleService } from "@medusajs/types"`. Replace `resolve(Modules.EVENT_BUS) as any` / `const eventBus: any = resolve(Modules.EVENT_BUS)` with `resolve<IEventBusModuleService>(Modules.EVENT_BUS)`.
- `#114-d`: `import type { RemoteQueryFunction } from "@medusajs/types"`. Change `query: any` → `query: RemoteQueryFunction`.

Existing casts `as OngoingModuleService` at resolve sites stay — they're the current idiomatic Medusa pattern (module service resolves aren't strongly typed in Awilix; project-owned service types come from the cast).

## Failure modes addressed

- I1/I2: A production Ongoing response that drops `article` on inventory or `orderInfo` on tracked orders is currently silently accepted with `articleNumber: undefined`, `articleSystemId: undefined`, etc. flowing into the domain. After #114-a: parse fails, `OngoingApiError({kind: "terminal"})` is thrown, retry logic skips it, error is logged with a structured `parsed.error.issues[0]` for diagnosis.
- Container-service renames: after #114-b, renaming `OngoingModuleService.attemptRetrySyncTransition` breaks compilation at every call site instead of at runtime.
- EventBus payload typos: after #114-c, `eventBus.emit({ name: "...", data: {...} })` is type-checked against `IEventBusModuleService`'s signature.
- query.graph misuse: after #114-d, wrong entity names / wrong `fields` shapes fail at compile time.

## Testing strategy

- **#114-a**: unit tests for each Zod schema against fixture bodies (happy path + omitted-field failures + type-mismatch failures + the exact production failure shapes I1/I2 describe). Extend the existing `client.ts` test suite from #107/#118.
- **#114-b/-c/-d**: no runtime behavior change → existing test suite passing (`yarn test`) + `yarn lint` + `yarn build` is sufficient. No new tests required. If a boundary was actually load-bearing at runtime and the type changed something, tests would fail.

## Risks

- **Bundle risk from Zod**: none — plugin is Node-only, no user-facing bundle.
- **Runtime cost of parse on every REST response**: Ongoing responses are small (< 100 fields per call), parse is O(n) in field count, negligible. If observability later shows otherwise, cache the schema instance (Zod schemas are already reusable objects).
- **Merge conflicts on `client.ts`**: #114-a lands first. #107/#108/#118/#120 already merged (or are about to), so #114-a rebases on top of them, not concurrent.
- **Type ripple in #114-b**: 25 files touched, but each edit is 1–2 lines. Reviewer needs to confirm no runtime behavior change per file.

## Sequencing

1. #114-a lands first (introduces `zod`, defines the edge validation pattern).
2. #114-b, #114-c, #114-d can land in parallel — they don't share files.
3. Once all four PRs merge, #114 rolls up to closed via the sub-issue relation.

## Open questions

None. All design decisions locked with the user prior to this doc.

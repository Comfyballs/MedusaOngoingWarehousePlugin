# setupOngoingLocationWorkflow Implementation Plan (Issue #30)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an `OngoingIntegration` is created for a stock location, provision the Medusa-native fulfillment binding (fulfillment set + service zone + ≥1 shipping option pointing at the Ongoing provider), set the integration's unique `stock_location_id`, create the `OngoingIntegration ⇄ stock_location` link, and surface what was created — all in one idempotent workflow that reuses an existing fulfillment set when one is present.

**Architecture:** A single `setupOngoingLocationWorkflow` under `src/workflows/`, composed from Medusa 2.16.0 core-flows (`createLocationFulfillmentSetWorkflow`, `createServiceZonesWorkflow`, `createShippingOptionsWorkflow`, `useQueryGraphStep`, `createRemoteLinkStep`) plus two custom steps (upsert the integration's `stock_location_id`; emit nothing else). The provisioning decision (reuse-if-exists vs create) is made with `when()`; all id plumbing and input shaping is done with `transform()`. Pure mapping/decision logic that is hard to test through a live DB is extracted into a side-effect-free helper module (`src/workflows/setup-location/helpers.ts`) and unit-tested in isolation. This plugin has **no live Postgres/Medusa instance**, so full workflow integration tests are deferred to the test-app milestone; this milestone verifies via helper unit tests plus `yarn build`.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `@medusajs/medusa/core-flows`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` (already wired in M1).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module id is `"ongoing"` (camelCase, never dashes); imported as `ONGOING_MODULE` from `src/modules/ongoing`.
- Prices/quantities are stored **as-is** in Medusa — never ×100 or ÷100. The seeded shipping price amount is `0` (literal).
- **Workflow composition rules (CRITICAL):** the `createWorkflow` body is a regular synchronous `function` — **no** `async`, **no** arrow functions, **no** `if`/`else`/ternary, **no** `&&`/`||`/`??`, **no** optional chaining `?.`, **no** object/array spread `...`, **no** `new Date()`, **no** `for`/`while`. Use **`transform()`** for every value derivation and **`when().then()`** for every branch.
- One `defineLink` per file (already satisfied by M1; this plan does not add links).
- The `OngoingIntegration ⇄ stock_location` link is defined in `src/links/ongoing-integration-stock-location.ts` with **stock_location FIRST, then ongoing**. `createRemoteLinkStep` payload order MUST match: `[{ [Modules.STOCK_LOCATION]: { stock_location_id }, [ONGOING_MODULE]: { ongoing_integration_id } }]`. Never hand-roll `link.create`.
- The unique `stock_location_id` column on `OngoingIntegration` is the DB guard; all later lookups filter on it (not across the link). It MUST be written in this same workflow.
- `provider_id` on the shipping option MUST equal `` `${identifier}_${optionId}` `` where `identifier` is the Ongoing provider's static `identifier` (`"ongoing"`) and `optionId` is one of the ids returned by the provider's `getFulfillmentOptions()`. **This couples to issue #20** — the exact `optionId` constant is owned by #20; this plan imports it from the provider package (see Task 1) rather than redefining it.
- Seed values (placeholders, clearly flagged to edit before go-live): shipping option name `"Ongoing Fulfillment"`, `price_type: "flat"`, `prices: [{ currency_code: <store default>, amount: 0 }]`, service zone scoped to the location's country (ISO-2). The shipping option `type` carries a placeholder label/description/code so operators see it is a seed.
- `canCalculate` is `false` on the provider ⇒ `price_type: "flat"` with a seeded `prices` array (no calculated rates).
- Workflows barrel: `package.json` `exports["./workflows"]` → `src/workflows/index.js`, so every public workflow MUST be re-exported from `src/workflows/index.ts`.

---

## File Structure

**Create:**
- `src/workflows/setup-location/constants.ts` — seed constants (shipping option name, placeholder type, default price amount).
- `src/workflows/setup-location/helpers.ts` — pure, side-effect-free helpers: reuse-branch decision from a queried location, `provider_id` composition, building the `createServiceZonesWorkflow` and `createShippingOptionsWorkflow` inputs, extracting the created fulfillment-set id from a re-queried location.
- `src/workflows/setup-location/steps/upsert-integration-location.ts` — custom step: set `OngoingIntegration.stock_location_id` (the unique column) with compensation.
- `src/workflows/setup-location/setup-location.ts` — the `setupOngoingLocationWorkflow` composition.
- `src/workflows/index.ts` — workflows barrel (re-export `setupOngoingLocationWorkflow` + its types).
- `src/workflows/setup-location/__tests__/helpers.test.ts` — unit tests for the pure helpers.

**Modify:**
- `src/providers/ongoing-fulfillment/...` — **only if** issue #20 has not yet exported the option-id constant; otherwise import from it. Do not redefine the provider here (see Task 1 coordination note).

---

## Task 1: Coordinate the provider option id (#20) + seed constants

**Files:**
- Create: `src/workflows/setup-location/constants.ts`

**Interfaces:**
- Consumes: from issue #20's provider package, the static provider `identifier` (`"ongoing"`) and the **shipping option id** returned by `getFulfillmentOptions()` (call it `ONGOING_FULFILLMENT_OPTION_ID`).
- Produces:
  - `ONGOING_SHIPPING_OPTION_NAME = "Ongoing Fulfillment"`
  - `ONGOING_SEED_PRICE_AMOUNT = 0`
  - `ONGOING_SEED_OPTION_TYPE = { label: "Ongoing Fulfillment (placeholder)", description: "Auto-created by the Ongoing plugin. Edit name, price, and carrier before going live.", code: "ongoing-fulfillment-placeholder" }`
  - re-exported `ONGOING_PROVIDER_IDENTIFIER` and `ONGOING_FULFILLMENT_OPTION_ID` so the rest of this feature has a single import site.

- [ ] **Step 1: Confirm the provider exports the option id constant**

Run:
```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin
grep -rn "getFulfillmentOptions\|identifier\|ONGOING_PROVIDER_ID\|ONGOING_STANDARD_OPTION_ID" src/providers 2>/dev/null
```
Expected: shows the provider's static `identifier` and the id string returned by `getFulfillmentOptions()`.

- Decision rule based on the grep result:
  - **If #20 already exports named constants** for the identifier and the option id (#20 owns `src/providers/ongoing-fulfillment/constants.ts` exporting `ONGOING_PROVIDER_ID = "ongoing"` and `ONGOING_STANDARD_OPTION_ID = "ongoing-standard"`), import them in Step 2 (aliasing to local names) — do not redefine.
  - **If #20 exists but only has the literal `identifier` / inline option id** (not exported), add named exports to the provider's `constants.ts`:
    ```ts
    export const ONGOING_PROVIDER_ID = "ongoing"
    export const ONGOING_STANDARD_OPTION_ID = "ongoing-standard"
    ```
    and have `identifier`/`getFulfillmentOptions()` reference them, so there is exactly one source of truth. (`"ongoing-standard"` is the placeholder id; match whatever literal #20 chose — they MUST be identical.)
  - **If `src/providers` is empty (#20 not merged yet)**: this task is BLOCKED on #20. Stop and report the dependency; do not invent a divergent option id.

- [ ] **Step 2: Create the seed constants module**

Create `src/workflows/setup-location/constants.ts` (adjust the import path/names to match what Step 1 confirmed the provider exports):
```ts
import {
  ONGOING_PROVIDER_ID as ONGOING_PROVIDER_IDENTIFIER,
  ONGOING_STANDARD_OPTION_ID as ONGOING_FULFILLMENT_OPTION_ID,
} from "../../providers/ongoing-fulfillment/constants"

export { ONGOING_PROVIDER_IDENTIFIER, ONGOING_FULFILLMENT_OPTION_ID }

export const ONGOING_SHIPPING_OPTION_NAME = "Ongoing Fulfillment"

export const ONGOING_SEED_PRICE_AMOUNT = 0

export const ONGOING_SEED_OPTION_TYPE = {
  label: "Ongoing Fulfillment (placeholder)",
  description:
    "Auto-created by the Ongoing plugin. Edit name, price, and carrier before going live.",
  code: "ongoing-fulfillment-placeholder",
}

export const ONGOING_FULFILLMENT_SET_NAME = "Ongoing Fulfillment"
```

- [ ] **Step 3: Verify it type-checks against the provider export**

Run:
```bash
cd /Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "setup-location/constants" || echo "no constants errors"
```
Expected: `no constants errors` (the import resolves to the provider's exports).

- [ ] **Step 4: Commit**

```bash
git add src/workflows/setup-location/constants.ts src/providers
git commit -m "feat(ongoing-workflow): seed constants + single-source provider option id for setup-location (#30)"
```

---

## Task 2: Pure helpers (provider_id composition, reuse decision, input builders)

**Files:**
- Create: `src/workflows/setup-location/helpers.ts`
- Test: `src/workflows/setup-location/__tests__/helpers.test.ts`

**Interfaces:**
- Consumes: constants from Task 1.
- Produces (all pure, no Medusa container, no `await`):
  - `type QueriedLocation = { id: string; fulfillment_sets?: Array<{ id: string; service_zones?: Array<{ id: string; shipping_options?: Array<{ id: string; provider_id?: string }> }> }> }`
  - `function composeProviderId(identifier: string, optionId: string): string` → `` `${identifier}_${optionId}` ``
  - `type FulfillmentSetMode = "auto" | "reuse" | "create"`
  - `function decideReuse(location: QueriedLocation, mode?: FulfillmentSetMode): { reuse: boolean; fulfillmentSetId?: string }` — honors the override `mode` (default `"auto"`):
    - `"create"` → never reuse (always create a new set), even when one exists ⇒ `{ reuse: false }`.
    - `"reuse"` → reuse the first existing set when ≥1 exists, else create ⇒ same as auto.
    - `"auto"` (default) → reuse-if-exists: `reuse` is true when the location already has ≥1 fulfillment set; `fulfillmentSetId` is the first existing set's id (or undefined when none).
  - `function extractFulfillmentSetId(location: QueriedLocation): string` — returns the first fulfillment set's id; throws a clear `Error` if none exists (used after the create branch re-query).
  - `function buildServiceZoneInput(args: { fulfillmentSetId: string; countryCode: string }): { data: Array<{ name: string; fulfillment_set_id: string; geo_zones: Array<{ type: "country"; country_code: string }> }> }`
  - `function buildShippingOptionInput(args: { serviceZoneId: string; shippingProfileId: string; providerId: string; currencyCode: string }): Array<{ name: string; service_zone_id: string; shipping_profile_id: string; provider_id: string; price_type: "flat"; prices: Array<{ currency_code: string; amount: number }>; type: { label: string; description: string; code: string } }>`

These helpers are the testable core; the workflow composition wires them through `transform()`.

- [ ] **Step 1: Write the failing tests**

Create `src/workflows/setup-location/__tests__/helpers.test.ts`:
```ts
import {
  composeProviderId,
  decideReuse,
  extractFulfillmentSetId,
  buildServiceZoneInput,
  buildShippingOptionInput,
} from "../helpers"
import {
  ONGOING_PROVIDER_IDENTIFIER,
  ONGOING_FULFILLMENT_OPTION_ID,
  ONGOING_SHIPPING_OPTION_NAME,
  ONGOING_SEED_OPTION_TYPE,
} from "../constants"

describe("composeProviderId", () => {
  it("joins identifier and option id with an underscore", () => {
    expect(composeProviderId("ongoing", "ongoing-standard")).toBe("ongoing_ongoing-standard")
  })

  it("matches `${identifier}_${optionId}` for the real constants", () => {
    expect(composeProviderId(ONGOING_PROVIDER_IDENTIFIER, ONGOING_FULFILLMENT_OPTION_ID)).toBe(
      `${ONGOING_PROVIDER_IDENTIFIER}_${ONGOING_FULFILLMENT_OPTION_ID}`
    )
  })
})

describe("decideReuse", () => {
  it("auto + existing: reuses and returns the existing set id (default mode)", () => {
    const result = decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] })
    expect(result).toEqual({ reuse: true, fulfillmentSetId: "fset_1" })
  })

  it("auto + none: does not reuse when there are no fulfillment sets (default mode)", () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] })).toEqual({ reuse: false })
    expect(decideReuse({ id: "loc_1" })).toEqual({ reuse: false })
  })

  it('"reuse" + existing: reuses the existing set id', () => {
    expect(
      decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] }, "reuse")
    ).toEqual({ reuse: true, fulfillmentSetId: "fset_1" })
  })

  it('"reuse" + none: creates when no set exists', () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] }, "reuse")).toEqual({
      reuse: false,
    })
  })

  it('"create" + existing: always creates a new set even when one exists', () => {
    expect(
      decideReuse({ id: "loc_1", fulfillment_sets: [{ id: "fset_1" }] }, "create")
    ).toEqual({ reuse: false })
  })

  it('"create" + none: creates a new set', () => {
    expect(decideReuse({ id: "loc_1", fulfillment_sets: [] }, "create")).toEqual({
      reuse: false,
    })
  })
})

describe("extractFulfillmentSetId", () => {
  it("returns the first fulfillment set id", () => {
    expect(extractFulfillmentSetId({ id: "loc_1", fulfillment_sets: [{ id: "fset_9" }] })).toBe("fset_9")
  })

  it("throws when no fulfillment set is present", () => {
    expect(() => extractFulfillmentSetId({ id: "loc_1", fulfillment_sets: [] })).toThrow(/fulfillment set/i)
  })
})

describe("buildServiceZoneInput", () => {
  it("scopes a country geo zone to the location country", () => {
    const input = buildServiceZoneInput({ fulfillmentSetId: "fset_1", countryCode: "no" })
    expect(input).toEqual({
      data: [
        {
          name: "Ongoing",
          fulfillment_set_id: "fset_1",
          geo_zones: [{ type: "country", country_code: "no" }],
        },
      ],
    })
  })
})

describe("buildShippingOptionInput", () => {
  it("builds a flat seeded option with the composed provider_id", () => {
    const input = buildShippingOptionInput({
      serviceZoneId: "sz_1",
      shippingProfileId: "sp_1",
      providerId: "ongoing_ongoing-standard",
      currencyCode: "nok",
    })
    expect(input).toEqual([
      {
        name: ONGOING_SHIPPING_OPTION_NAME,
        service_zone_id: "sz_1",
        shipping_profile_id: "sp_1",
        provider_id: "ongoing_ongoing-standard",
        price_type: "flat",
        prices: [{ currency_code: "nok", amount: 0 }],
        type: ONGOING_SEED_OPTION_TYPE,
      },
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/workflows/setup-location/__tests__/helpers.test.ts`
Expected: FAIL — cannot find module `../helpers`.

- [ ] **Step 3: Implement the helpers**

Create `src/workflows/setup-location/helpers.ts`:
```ts
import {
  ONGOING_SHIPPING_OPTION_NAME,
  ONGOING_SEED_PRICE_AMOUNT,
  ONGOING_SEED_OPTION_TYPE,
} from "./constants"

export type QueriedShippingOption = { id: string; provider_id?: string }
export type QueriedServiceZone = { id: string; shipping_options?: QueriedShippingOption[] }
export type QueriedFulfillmentSet = { id: string; service_zones?: QueriedServiceZone[] }
export type QueriedLocation = {
  id: string
  fulfillment_sets?: QueriedFulfillmentSet[]
}

export type FulfillmentSetMode = "auto" | "reuse" | "create"

export function composeProviderId(identifier: string, optionId: string): string {
  return `${identifier}_${optionId}`
}

export function decideReuse(
  location: QueriedLocation,
  mode: FulfillmentSetMode = "auto"
): {
  reuse: boolean
  fulfillmentSetId?: string
} {
  // "create" forces a new fulfillment set even when one already exists.
  if (mode === "create") {
    return { reuse: false }
  }
  // "auto" (default) and "reuse" both reuse-if-exists, else create.
  const sets = location.fulfillment_sets || []
  if (sets.length > 0) {
    return { reuse: true, fulfillmentSetId: sets[0].id }
  }
  return { reuse: false }
}

export function extractFulfillmentSetId(location: QueriedLocation): string {
  const sets = location.fulfillment_sets || []
  if (sets.length === 0) {
    throw new Error(
      `[ongoing] expected a fulfillment set on location "${location.id}" after creation, found none`
    )
  }
  return sets[0].id
}

export function buildServiceZoneInput(args: {
  fulfillmentSetId: string
  countryCode: string
}): {
  data: Array<{
    name: string
    fulfillment_set_id: string
    geo_zones: Array<{ type: "country"; country_code: string }>
  }>
} {
  return {
    data: [
      {
        name: "Ongoing",
        fulfillment_set_id: args.fulfillmentSetId,
        geo_zones: [{ type: "country", country_code: args.countryCode }],
      },
    ],
  }
}

export function buildShippingOptionInput(args: {
  serviceZoneId: string
  shippingProfileId: string
  providerId: string
  currencyCode: string
}): Array<{
  name: string
  service_zone_id: string
  shipping_profile_id: string
  provider_id: string
  price_type: "flat"
  prices: Array<{ currency_code: string; amount: number }>
  type: { label: string; description: string; code: string }
}> {
  return [
    {
      name: ONGOING_SHIPPING_OPTION_NAME,
      service_zone_id: args.serviceZoneId,
      shipping_profile_id: args.shippingProfileId,
      provider_id: args.providerId,
      price_type: "flat",
      prices: [{ currency_code: args.currencyCode, amount: ONGOING_SEED_PRICE_AMOUNT }],
      type: ONGOING_SEED_OPTION_TYPE,
    },
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/setup-location/__tests__/helpers.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/setup-location/helpers.ts src/workflows/setup-location/__tests__/helpers.test.ts
git commit -m "feat(ongoing-workflow): pure helpers for reuse decision, provider_id, and core-flow inputs (#30)"
```

---

## Task 3: Custom step — write the unique `stock_location_id` on the integration

**Files:**
- Create: `src/workflows/setup-location/steps/upsert-integration-location.ts`

**Interfaces:**
- Consumes: the `ongoing` module service (`updateOngoingIntegrations`, `retrieveOngoingIntegration` — both auto-generated by `MedusaService`); `ONGOING_MODULE` from `src/modules/ongoing`.
- Produces: `upsertIntegrationLocationStep` — input `{ integration_id: string; stock_location_id: string }`; sets the integration's unique `stock_location_id` column and returns `{ integration_id, stock_location_id }`. Compensation restores the previous `stock_location_id`.

This is a single mutation in its own step (one mutation per step) so rollback works and the `stock_location_id` write participates in the workflow's compensation chain.

- [ ] **Step 1: Implement the step (scaffolding — verified by build in Task 5)**

Create `src/workflows/setup-location/steps/upsert-integration-location.ts`:
```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../../modules/ongoing"

type Input = {
  integration_id: string
  stock_location_id: string
}

export const upsertIntegrationLocationStep = createStep(
  "ongoing-upsert-integration-location",
  async (input: Input, { container }) => {
    const ongoing = container.resolve(ONGOING_MODULE)

    const existing = await ongoing.retrieveOngoingIntegration(input.integration_id)
    const previousLocationId = existing.stock_location_id

    await ongoing.updateOngoingIntegrations({
      id: input.integration_id,
      stock_location_id: input.stock_location_id,
    })

    return new StepResponse(
      { integration_id: input.integration_id, stock_location_id: input.stock_location_id },
      { integration_id: input.integration_id, previousLocationId }
    )
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const ongoing = container.resolve(ONGOING_MODULE)
    await ongoing.updateOngoingIntegrations({
      id: compensation.integration_id,
      stock_location_id: compensation.previousLocationId,
    })
  }
)
```

> NOTE: `retrieveOngoingIntegration` / `updateOngoingIntegrations` are the auto-CRUD methods `MedusaService({ OngoingIntegration, OngoingOrderSync })` generates (singular `retrieve*`, plural `update*`). If `yarn build` (Task 5) reports a method-name mismatch, the error lists the generated method names — adjust to match.

- [ ] **Step 2: Commit**

```bash
git add src/workflows/setup-location/steps/upsert-integration-location.ts
git commit -m "feat(ongoing-workflow): step to set unique stock_location_id on integration with compensation (#30)"
```

---

## Task 4: The `setupOngoingLocationWorkflow` composition + barrel

**Files:**
- Create: `src/workflows/setup-location/setup-location.ts`
- Create: `src/workflows/index.ts`

**Interfaces:**
- Consumes: core-flows (`createLocationFulfillmentSetWorkflow`, `createServiceZonesWorkflow`, `createShippingOptionsWorkflow`, `useQueryGraphStep`, `createRemoteLinkStep`) from `@medusajs/medusa/core-flows`; `Modules` from `@medusajs/framework/utils`; `ONGOING_MODULE` from `src/modules/ongoing`; helpers + constants from Tasks 1–2; the step from Task 3.
- Produces:
  - `type SetupOngoingLocationInput = { integration_id: string; stock_location_id: string; fulfillment_set_mode?: FulfillmentSetMode }` — the optional override flag (`"auto" | "reuse" | "create"`, default `"auto"`) for future admin control of issue #30's create-new-vs-link-to-existing open question. Omitting it preserves the reuse-if-exists default, so existing callers are unchanged.
  - `setupOngoingLocationWorkflow` returning `WorkflowResponse<{ integration_id: string; stock_location_id: string; fulfillment_set_id: string; service_zone_id: string; shipping_option_ids: string[]; reused: boolean }>` — `reused` reflects what actually happened (true only when an existing set was reused), so the chosen mode's effect is observable in the response.
- `src/workflows/index.ts` re-exports `setupOngoingLocationWorkflow` and `SetupOngoingLocationInput`.

**Strict step ordering inside the composition (all branching via `when()`, all value derivation via `transform()`):**
1. `useQueryGraphStep` on `stock_location` (existing fulfillment sets); a `transform()` derives the effective mode (`input.fulfillment_set_mode ?? "auto"`) and feeds both the location and mode into `decideReuse` to produce `reuseDecision`.
2. A `transform()` computes a `shouldCreate` boolean (`reuseDecision.reuse === false`); `when({ shouldCreate }, (d) => d.shouldCreate)` gates `createLocationFulfillmentSetWorkflow.runAsStep` (type `"shipping"`), then a **second** `useQueryGraphStep` (different `.config()` name) to read back the created set id. The `when()` predicate reads the precomputed boolean — no raw conditional/flag logic in the composition body.
3. `transform()` selects the effective `fulfillment_set_id` (existing one when reused, re-queried one when created).
4. `useQueryGraphStep` on `shipping_profile` filtered `{ type: "default" }` → default profile id.
5. `useQueryGraphStep` (or reuse the step-1 location) to read the location's country code; `transform()` builds the service-zone input → `createServiceZonesWorkflow.runAsStep`.
6. `transform()` builds the shipping-option input (with composed `provider_id`) → `createShippingOptionsWorkflow.runAsStep`.
7. `upsertIntegrationLocationStep` (write the unique column).
8. `transform()` builds the link payload (stock_location FIRST) → `createRemoteLinkStep`.
9. `transform()` shapes the `WorkflowResponse`.

> CRITICAL `when()` constraint: `createServiceZonesWorkflow`, `createShippingOptionsWorkflow`, `upsertIntegrationLocationStep`, and `createRemoteLinkStep` run **unconditionally** (they must run for both the create and reuse branches). Only `createLocationFulfillmentSetWorkflow` + its read-back query are wrapped in `when({ shouldCreate }, (d) => d.shouldCreate)`, where `shouldCreate` is a `transform()`-computed boolean derived from `decideReuse(location, mode)` — **not** a raw conditional or flag read in the composition body. The reuse branch reuses the existing fulfillment set but **still creates a new Ongoing-pointed service zone + shipping option** on it (the existing set may belong to another provider).
>
> The `fulfillment_set_mode` override flag (default `"auto"`) controls the set decision via `decideReuse`: `"create"` forces `shouldCreate = true` even when a set exists; `"reuse"` and `"auto"` both reuse-if-exists, else create. This matches the spec's reuse-if-exists DEFAULT **plus an override flag** (issue #30's create-new-vs-link-to-existing open question), while always ensuring an Ongoing shipping option exists.

- [ ] **Step 1: Implement the composition (scaffolding — verified by build in Task 5)**

Create `src/workflows/setup-location/setup-location.ts`:
```ts
import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createLocationFulfillmentSetWorkflow,
  createServiceZonesWorkflow,
  createShippingOptionsWorkflow,
  createRemoteLinkStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { ONGOING_MODULE } from "../../modules/ongoing"
import {
  ONGOING_PROVIDER_IDENTIFIER,
  ONGOING_FULFILLMENT_OPTION_ID,
  ONGOING_FULFILLMENT_SET_NAME,
} from "./constants"
import {
  composeProviderId,
  decideReuse,
  extractFulfillmentSetId,
  buildServiceZoneInput,
  buildShippingOptionInput,
  FulfillmentSetMode,
} from "./helpers"
import { upsertIntegrationLocationStep } from "./steps/upsert-integration-location"

export type SetupOngoingLocationInput = {
  integration_id: string
  stock_location_id: string
  // Override for the fulfillment-set decision (future admin control of issue #30's
  // create-new-vs-link-to-existing question). Default "auto" = reuse-if-exists.
  fulfillment_set_mode?: FulfillmentSetMode
}

export const setupOngoingLocationWorkflow = createWorkflow(
  "setup-ongoing-location",
  function (input: SetupOngoingLocationInput) {
    // (1) detect existing fulfillment binding + the location's country
    const existing = useQueryGraphStep({
      entity: "stock_location",
      fields: [
        "id",
        "address.country_code",
        "fulfillment_sets.id",
        "fulfillment_sets.service_zones.id",
        "fulfillment_sets.service_zones.shipping_options.id",
        "fulfillment_sets.service_zones.shipping_options.provider_id",
      ],
      filters: { id: input.stock_location_id },
    }).config({ name: "query-existing-location" })

    // honor the optional override flag; default "auto" = reuse-if-exists
    const reuseDecision = transform({ existing, input }, (data) =>
      decideReuse(data.existing.data[0], data.input.fulfillment_set_mode ?? "auto")
    )

    // precompute the create gate as a plain boolean so when() reads no flag logic
    const shouldCreate = transform(
      { reuseDecision },
      (data) => data.reuseDecision.reuse === false
    )

    const countryCode = transform({ existing }, (data) =>
      data.existing.data[0].address.country_code
    )

    // (2) create the fulfillment set only when the decision says so
    //     ("create" mode forces this even if a set already exists)
    const created = when({ shouldCreate }, (data) => data.shouldCreate).then(
      () => {
        createLocationFulfillmentSetWorkflow.runAsStep({
          input: transform({ input }, (data) => ({
            location_id: data.input.stock_location_id,
            fulfillment_set_data: {
              name: ONGOING_FULFILLMENT_SET_NAME,
              type: "shipping",
            },
          })),
        })

        // re-query to read back the created set id (the create returns `unknown`)
        const requeried = useQueryGraphStep({
          entity: "stock_location",
          fields: ["id", "fulfillment_sets.id"],
          filters: { id: input.stock_location_id },
        }).config({ name: "query-created-fulfillment-set" })

        return transform({ requeried }, (data) =>
          extractFulfillmentSetId(data.requeried.data[0])
        )
      }
    )

    // (3) effective fulfillment set id: existing (reused) or newly created
    const fulfillmentSetId = transform({ reuseDecision, created }, (data) => {
      if (data.reuseDecision.reuse === true) {
        return data.reuseDecision.fulfillmentSetId as string
      }
      return data.created as string
    })

    // (4) default shipping profile
    const profiles = useQueryGraphStep({
      entity: "shipping_profile",
      fields: ["id"],
      filters: { type: "default" },
    }).config({ name: "query-default-shipping-profile" })

    const shippingProfileId = transform({ profiles }, (data) => data.profiles.data[0].id)

    // (5) service zone scoped to the location country
    const serviceZones = createServiceZonesWorkflow.runAsStep({
      input: transform({ fulfillmentSetId, countryCode }, (data) =>
        buildServiceZoneInput({
          fulfillmentSetId: data.fulfillmentSetId,
          countryCode: data.countryCode,
        })
      ),
    })

    const serviceZoneId = transform({ serviceZones }, (data) => data.serviceZones[0].id)

    // (6) shipping option pointing at the Ongoing provider
    const providerId = transform({}, () =>
      composeProviderId(ONGOING_PROVIDER_IDENTIFIER, ONGOING_FULFILLMENT_OPTION_ID)
    )

    // store default currency for the seeded flat price
    const stores = useQueryGraphStep({
      entity: "store",
      fields: ["id", "supported_currencies.currency_code", "supported_currencies.is_default"],
    }).config({ name: "query-store-currency" })

    const currencyCode = transform({ stores }, (data) => {
      const currencies = data.stores.data[0].supported_currencies || []
      const def = currencies.find((c: { is_default?: boolean }) => c.is_default === true)
      if (def) {
        return def.currency_code
      }
      return currencies[0].currency_code
    })

    const shippingOptions = createShippingOptionsWorkflow.runAsStep({
      input: transform(
        { serviceZoneId, shippingProfileId, providerId, currencyCode },
        (data) =>
          buildShippingOptionInput({
            serviceZoneId: data.serviceZoneId,
            shippingProfileId: data.shippingProfileId,
            providerId: data.providerId,
            currencyCode: data.currencyCode,
          })
      ),
    })

    const shippingOptionIds = transform({ shippingOptions }, (data) =>
      data.shippingOptions.map((o: { id: string }) => o.id)
    )

    // (7) write the unique stock_location_id column on the integration
    upsertIntegrationLocationStep({
      integration_id: input.integration_id,
      stock_location_id: input.stock_location_id,
    })

    // (8) create the OngoingIntegration <-> stock_location link (stock_location FIRST)
    createRemoteLinkStep(
      transform({ input }, (data) => [
        {
          [Modules.STOCK_LOCATION]: {
            stock_location_id: data.input.stock_location_id,
          },
          [ONGOING_MODULE]: {
            ongoing_integration_id: data.input.integration_id,
          },
        },
      ])
    )

    // (9) surface what was created
    return new WorkflowResponse(
      transform(
        {
          input,
          fulfillmentSetId,
          serviceZoneId,
          shippingOptionIds,
          reuseDecision,
        },
        (data) => ({
          integration_id: data.input.integration_id,
          stock_location_id: data.input.stock_location_id,
          fulfillment_set_id: data.fulfillmentSetId,
          service_zone_id: data.serviceZoneId,
          shipping_option_ids: data.shippingOptionIds,
          reused: data.reuseDecision.reuse,
        })
      )
    )
  }
)

export default setupOngoingLocationWorkflow
```

> NOTE (verify-points carried to the test-app milestone, do not block build):
> - The exact field path for the location's country (`address.country_code`) and the store default-currency shape (`supported_currencies.is_default`) are the documented 2.16.0 shapes. If `yarn build` or a later live run shows a different path, the read is isolated in a single `transform()` each — one-spot edits.
> - `createServiceZonesWorkflow` returns `ServiceZoneDTO[]` and `createShippingOptionsWorkflow` returns `ShippingOptionDTO[]`; the `.id` reads above match those DTOs.
> - The `if` statements appear **only inside `transform()` callbacks** (which execute at runtime and may use normal JS) and inside `helpers.ts` — never in the workflow composition body itself. This is compliant with the composition rules.

- [ ] **Step 2: Create the workflows barrel**

Create `src/workflows/index.ts`:
```ts
export {
  setupOngoingLocationWorkflow,
  default as setupOngoingLocation,
} from "./setup-location/setup-location"
export type { SetupOngoingLocationInput } from "./setup-location/setup-location"
```

- [ ] **Step 3: Commit**

```bash
git add src/workflows/setup-location/setup-location.ts src/workflows/index.ts
git commit -m "feat(ongoing-workflow): setupOngoingLocationWorkflow provisions fulfillment binding + link (#30)"
```

---

## Task 5: Verify — unit tests + build

**Files:** none (verification only).

**Interfaces:** confirms the whole feature compiles and the pure helpers pass.

- [ ] **Step 1: Run the helper unit suite**

Run: `yarn test src/workflows`
Expected: PASS — all `helpers.test.ts` assertions green.

- [ ] **Step 2: Run the full unit suite (no regressions in M1)**

Run: `yarn test`
Expected: all suites PASS (M1 lib/module tests + the new helper tests).

- [ ] **Step 3: Build the plugin**

Run: `yarn build`
Expected: `medusa plugin:build` completes with no TypeScript errors; output appears under `.medusa/server`, including `.medusa/server/src/workflows/index.js` (the barrel the `exports` map points at).

- [ ] **Step 4: Fix any build errors and re-run**

If the build fails, read the error, fix at the single isolated site (helper, `transform()`, or the auto-CRUD method name per the Task 3 NOTE), and re-run `yarn build` until it is clean. Do NOT mark complete until both `yarn test` and `yarn build` succeed.

> Full workflow **integration** tests (executing `setupOngoingLocationWorkflow.run()` against a DB and asserting the fulfillment set / service zone / shipping option / link / unique column were persisted, plus the reuse-vs-create branch and idempotency) are **deferred to the test-app milestone**, which provisions a live Postgres + Medusa instance. This milestone's contract is: pure helpers unit-tested + a clean `yarn build`.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "test(ongoing-workflow): verify setup-location helpers + plugin build (#30)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (§3 setup workflow, §4 link):** provisions fulfillment set + service zone + ≥1 Ongoing-pointed shipping option (Task 4, steps 2/5/6) ✓; sets the unique `stock_location_id` (Task 3, wired in Task 4 step 7) ✓; creates the `OngoingIntegration ⇄ stock_location` link with stock_location FIRST via `createRemoteLinkStep` (Task 4 step 8) ✓; reuse-if-exists DEFAULT plus an override flag (`fulfillment_set_mode: "auto" | "reuse" | "create"`, default `"auto"`) for the set decision — threaded via a `transform()`-computed `shouldCreate` boolean into `when()`, honored by `decideReuse`, and reflected in the `reused` response field (issue #30's create-new-vs-link-to-existing open question) (Tasks 2, 4) ✓; surfaces what it created in `WorkflowResponse` (Task 4 step 9) ✓; seed values flagged as placeholders (Task 1 constants) ✓; `provider_id = ${identifier}_${optionId}` coordinated with #20 (Tasks 1–2) ✓.
- **Composition-rule scan:** the `createWorkflow` body uses only `useQueryGraphStep`, `*.runAsStep`, custom steps, `transform()`, and `when()`. No `async`/arrow on the body; no `if`/ternary/`??`/`?.`/spread/`new Date()`/loops at composition scope. All `if`/`||`/`?.`-style logic lives inside `transform()` callbacks or `helpers.ts`, both of which run at execution time and permit normal JS. ✓
- **Placeholder scan:** every code step contains full code; the three NOTE callouts (provider option-id source in Task 1, auto-CRUD method names in Task 3, field-path verify-points in Task 4) are explicit verify-points with the resolution method stated, not missing content.
- **Type consistency:** `SetupOngoingLocationInput`, `composeProviderId`, `decideReuse`, `extractFulfillmentSetId`, `buildServiceZoneInput`, `buildShippingOptionInput`, `upsertIntegrationLocationStep`, and the constant names are referenced identically across tasks and tests. The `WorkflowResponse` shape matches the spec's "surface what it created" requirement field-for-field.

## Dependencies & verify-points carried forward
- **Blocked-by #20:** the provider's `identifier` and `getFulfillmentOptions()` option id must exist and be exported (Task 1). If `src/providers` is empty, stop and report — do not invent a divergent id.
- **Carried to the test-app milestone:** live execution of the workflow (branch coverage, idempotency, persisted-entity assertions); confirmation of the `address.country_code` and store default-currency field paths; DTO `.id` shapes from the two create core-flows. Each is isolated in a single helper/`transform()` for a one-spot fix.

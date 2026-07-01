# Settings Page — Integration CRUD, Assign Location, Test Connection Implementation Plan (#40)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Business-logic tasks (all workflow steps, all API routes, and the module service method) follow superpowers:test-driven-development — the failing test is written and run-to-fail **before** the implementation. The admin UI wiring inside Task 10 is pure React scaffolding with no established test harness in this repo (see Task 10 header) and is verified by a standalone `tsc` type-gate plus a manual QA checklist; the pure-function logic that UI wiring depends on (CSV/JSON parsing) is extracted into its own module and is TDD'd like everything else.

> **Revision note (post plan-verification review):** this plan was corrected after per-plan + cross-plan review found four defects in an earlier draft: (1) `yarn build` was wrongly used as the admin TypeScript type-gate — `medusa plugin:build` excludes `src/admin` from `tsc` and bundles it with Vite/esbuild, so it never type-checks TSX; (2) the `[id]` route's scoped test command used a bracketed jest positional arg that jest treats as an unreliable regex; (3) `parseCodesCsv` and the `edit_sync_rules` JSON parsing were pure business logic wrongly folded into the TDD-exempt UI task; (4) **the create route committed the `OngoingIntegration` row via direct auto-CRUD, then ran `setupOngoingLocationWorkflow` — if that workflow failed, the row was already persisted with no fulfillment set/service zone/link and no compensation, an orphaned row the list page would render as fully configured.** All four are fixed below: Task 1 Step 4 and Task 10's build step now use `npx tsc -p src/admin/tsconfig.json --noEmit`; Task 9's test commands scope to the parent directory; the CSV/JSON parsing lives in its own TDD'd module (`utils/parse-codes.ts`); and create/update/delete now each run through their own workflow (`createOngoingIntegrationWorkflow`, `updateOngoingIntegrationWorkflow`, `deleteOngoingIntegrationWorkflow`), with the create workflow's row-insert step carrying an explicit **compensation** (delete the row) that fires if the nested location-setup step fails.

**Goal:** Ship the Ongoing Warehouse admin settings page at `/app/settings/ongoing`: list configured integrations, create/edit them in a Drawer (pick an available `credential_key`, assign the stock location — which runs `setupOngoingLocationWorkflow` — set sync intervals and `stock_reconcile_mode`), and a **Test connection** action backed by `POST /admin/ongoing/test-connection`. This also lays the shared admin scaffolding (`sdk.ts`, `@medusajs/js-sdk`) that issue #41 builds on.

**Architecture:** `Module (OngoingModuleService, existing) → Workflows (new, this plan) → API routes (new, this plan) → Admin UI (new, this plan)`. Three new workflows back every mutation: `createOngoingIntegrationWorkflow` (inserts the row with a compensating delete, then composes the existing `setupOngoingLocationWorkflow` via `.runAsStep()` so a failed location setup rolls the row back), `updateOngoingIntegrationWorkflow` (updates the row with a compensating revert-to-previous-values), and `deleteOngoingIntegrationWorkflow` (deletes the row). Four admin API route files call these workflows (or, for reads, the module service directly): `GET/POST /admin/ongoing/integrations` (list + create), `GET/POST/DELETE /admin/ongoing/integrations/:id` (retrieve + update + delete), `GET /admin/ongoing/credential-keys` (populates the create-form Select), and `POST /admin/ongoing/test-connection` (drives the Test connection button, pre- or post-save; this one is a read-through action against the live Ongoing API with no persisted mutation, so it does not need a workflow). The settings page (`src/admin/routes/settings/ongoing/page.tsx`) is a single file that lists integrations in a `Table` and opens a shared `IntegrationDrawer` component for both create and edit.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`, `@medusajs/admin-sdk`, `@medusajs/js-sdk`, `@medusajs/ui`, `@medusajs/icons`), TypeScript 5.6 (Node16 module resolution for `src/`, its own bundler-mode `src/admin/tsconfig.json` for the admin), yarn 4.6, `@tanstack/react-query` (bundled by the admin dashboard — do not add to `package.json`), Jest + `@swc/jest` for unit tests (`jest.config.js`, `package.json` `"test": "jest"`). Node `>= 20`.

---

## Design decisions (read before implementing)

### 1. No `zod` — manual validation functions, matching the existing webhook-route precedent

`medusa-dev:building-with-medusa`'s quick reference recommends `validateAndTransformBody` + Zod schemas registered in `src/api/middlewares.ts`. **This plan does not use that pattern**, for two concrete reasons specific to this repo:

- **Runtime dependency risk.** This plugin's `package.json` has **no `dependencies` field at all** — every runtime import in `src/` currently resolves through a `peerDependency` the consuming Medusa app already provides (`@medusajs/*`). `zod` is only present in this repo's `node_modules` as a *transitive* dependency of unrelated tooling (it resolves via a `^3.25.0 || ^4.0.0` range from some other package, not a top-level entry) — there is no guarantee it is resolvable from the plugin's install location inside an arbitrary consumer's `node_modules` tree once `.medusa/server` ships. Adding a hard `import { z } from "zod"` to compiled runtime route code without adding `zod` as a real `dependency` would be a latent production break; adding it as a new runtime `dependency` is out of scope for a settings-page issue and not requested by the resolved research.
- **Existing precedent already solves this without the risk.** `src/api/ongoing/webhooks/[credentialKey]/route.ts` validates its inbound payload with a hand-written `parsePayload(body: unknown): WebhookOrderPayload | null` function — no Zod, no extra dependency, and it is directly unit-testable by calling the exported handler with bad bodies. This plan follows that exact convention: each new route directory gets its own `validators.ts` exporting a `validate*Input(body: unknown): T` function that **throws `MedusaError(MedusaError.Types.INVALID_DATA, …)`** on bad *request shape* (missing/mistyped fields). Validators only check shape; they never touch the database or plugin options — see decision 2 for where domain/business validation (e.g. "does this `credential_key` actually exist?") lives.

Validation is exercised by unit tests that call the exported route handler with malformed input and assert the thrown `MedusaError`, and separately assert the workflow is never invoked on failure.

### 2. Every mutation runs through a workflow — corrected after review

An earlier draft of this plan had the create route call `OngoingModuleService.createOngoingIntegrations(...)` directly, then run `setupOngoingLocationWorkflow` afterward, justified by an in-repo "precedent" (`recordSync`/`acquireSyncLock`) that, on closer inspection, is auto-CRUD called from **workflow steps**, not from a route — there is in fact **no existing route** in `src/api/**` that calls a module's mutation methods directly. That draft had a real bug: if `setupOngoingLocationWorkflow` failed *after* the row was already committed, the `OngoingIntegration` row was left orphaned — no fulfillment set, no service zone, no module link — and `GET /admin/ongoing/integrations` would list it as if it were fully configured. This plan corrects course:

- **`createOngoingIntegrationWorkflow`** (`src/workflows/create-ongoing-integration.ts`) is the only way an `OngoingIntegration` row gets created. Its first step, `createOngoingIntegrationRowStep` (`src/workflows/steps/create-ongoing-integration-row.ts`), inserts the row and returns a `StepResponse` whose **compensation input is the new row's id**; its compensation function deletes that row. The workflow's second "step" is the *existing* `setupOngoingLocationWorkflow`, composed in via **`.runAsStep()`** — the same composition mechanism `setupOngoingLocationWorkflow` itself already uses internally for `createServiceZonesWorkflow.runAsStep(...)` and `createShippingOptionsWorkflow.runAsStep(...)` (`src/workflows/setup-location/setup-location.ts:114-156`). If the composed `setupOngoingLocationWorkflow` step fails for any reason, the outer workflow's saga runs the row-insert step's compensation, deleting the row — no more orphans.
- **`updateOngoingIntegrationWorkflow`** (`src/workflows/update-ongoing-integration.ts`) wraps `updateOngoingIntegrationStep`, which snapshots the row's previous values before writing and compensates by restoring them.
- **`deleteOngoingIntegrationWorkflow`** (`src/workflows/delete-ongoing-integration.ts`) wraps `deleteOngoingIntegrationStep`. There is nothing to compensate (it is the terminal step of its own workflow and the row is gone), so it has no compensation function — the same shape as the existing `cancelOngoingOrderStep` (`src/workflows/steps/cancel-ongoing-order.ts:33-36`), which also omits one.
- **Domain/business validation now lives in the workflow step, not the route.** `createOngoingIntegrationRowHandler` calls `OngoingModuleService.getCredentials(credential_key)` (which throws `MedusaError(INVALID_DATA)` for an unknown key) *before* calling `createOngoingIntegrations` — so an unknown key never reaches the database and never needs compensation. This follows `medusa-dev:building-with-medusa`'s `logic-workflow-validation` rule ("business validation in workflow steps, not API routes") more precisely than the earlier draft, which ran that same check from the route.
- Routes now do exactly two things for a mutation: validate request **shape** (decision 1), then call `theWorkflow(req.scope).run({ input })` and forward the result. No route resolves `OngoingModuleService` to call a `createX`/`updateX`/`deleteX` auto-CRUD method directly. Reads (`GET`) are not mutations and still call the module service directly — matching every other read in this codebase (e.g. the existing webhook route's `listOngoingIntegrations` call).

**Testing note on the nested workflow composition:** this exemption applies to **`createOngoingIntegrationWorkflow` only**, because it composes the heavy `setupOngoingLocationWorkflow` (needs a live `query` module, remote-link module, and fulfillment module services that don't exist outside a real Medusa app + Postgres — this repo has no `@medusajs/test-utils` integration-test harness wired up, confirmed in `CLAUDE.md`, and `setupOngoingLocationWorkflow` itself has never been exercised end-to-end for the same reason: its only test, `src/workflows/setup-location/__tests__/helpers.test.ts`, covers pure helper functions, not the orchestrated `.run()`). For that one workflow, this plan TDDs the two things that are both real and independently verifiable without a DB: (a) the row-insert step's `invoke`/`compensate` handlers in isolation (Task 5 — proves the compensation logic itself is correct, exactly mirroring how `cancelOngoingOrderStep`'s handler is tested in isolation), and (b) the route's contract when the workflow rejects (Task 8 — proves a failed create never returns a `201`/success response for what would otherwise be an orphaned row).

`updateOngoingIntegrationWorkflow` and `deleteOngoingIntegrationWorkflow` carry **no such exemption** — each resolves only the `"ongoing"` module service, nothing heavier, so Tasks 6 and 7 each also run the real workflow through a real `createMedusaContainer()` (the same pattern `src/workflows/__tests__/push-order-to-ongoing.test.ts` uses: register a mocked `"ongoing"` service on a real container, then call `theWorkflow(container).run({ input })` and assert on the resolved `result`). This is full workflow-level TDD, not just step-level, for both.

### 3. `stock_location_id` and `credential_key` are immutable after creation

`credential_key` selects which configured `OngoingCredentials` the integration uses; `stock_location_id` is a `.unique()` column written once by `setupOngoingLocationWorkflow`'s `upsertIntegrationLocationStep` and is the anchor for the fulfillment set / service zone / shipping option / module link that workflow creates. There is **no** workflow that tears down and re-creates that binding for a location change, and no research or spec text describes one. The update route's `validators.ts` **does not define fields for `credential_key` or `stock_location_id` at all**, and neither does `updateOngoingIntegrationStep`'s `UpdateOngoingIntegrationInput` — if either is present in the request body it is silently dropped by the route validator (never read into the returned object) before it ever reaches the workflow, so `updateOngoingIntegrations` can never receive them regardless of what the client sends. The admin UI renders both as read-only on the edit Drawer for the same reason. Changing either requires deleting and re-creating the integration (see decision 4).

### 4. Delete removes only the `OngoingIntegration` row — no teardown

`deleteOngoingIntegrationStep` removes the module's DB row (and, per Medusa's default cascade behavior, its `OngoingIntegration ↔ stock_location` module link record). **It does not remove** the fulfillment set, service zone, or shipping option that `setupOngoingLocationWorkflow` created on the stock location — there is no reverse workflow for that, and building one is out of scope for #40. The admin UI's delete action uses `usePrompt` (`@medusajs/ui`) to show a `variant: "danger"` confirmation that names exactly what is and is not removed, so operators aren't surprised by leftover fulfillment configuration.

---

## Global Constraints

- Medusa version floor **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Package manager **yarn 4.6.0** (`nodeLinker: node-modules`), Node **>= 20**.
- Module id is `"ongoing"` — import `ONGOING_MODULE` from `src/modules/ongoing/index.ts` (`ONGOING_MODULE = "ongoing"`).
- **No PUT/PATCH routes.** Updates are `POST` (Medusa convention; also explicit in this repo's CLAUDE.md). Reads are `GET`, removal is `DELETE`.
- **All mutations run through a workflow.** `createOngoingIntegrationWorkflow`, `updateOngoingIntegrationWorkflow`, `deleteOngoingIntegrationWorkflow` — never a direct `createOngoingIntegrations`/`updateOngoingIntegrations`/`deleteOngoingIntegrations` auto-CRUD call from a route. `GET` reads call the module service directly (not a mutation).
- Use **`MedusaError`** for thrown errors, never generic `Error`. Admin routes let a validation/not-found `MedusaError` propagate (no try/catch converting it to a manual status) — that's the framework's job.
- **Module isolation:** anything that touches the `ongoing` module (routes' `GET` handlers, workflow steps) does so only through `OngoingModuleService`; no cross-module service reach-around, no direct repository access.
- `/admin/*` routes are **auto-authenticated** by Medusa (no `authenticate` middleware needed).
- **The admin type-gate is `npx tsc -p src/admin/tsconfig.json --noEmit`, never `yarn build`.** `yarn build` runs `medusa plugin:build`, whose root `tsconfig.json` (`exclude: ["src/admin", ...]`) skips `src/admin` entirely and hands it to Vite/esbuild for bundling instead — `esbuild`/Vite strip types without checking them. `src/admin/tsconfig.json` (`include: ["."]`, `noEmit: true`, `strict: true`) exists specifically to be invoked standalone for this purpose.
- **Admin UI must use the Medusa JS SDK for every request** — `sdk.admin.*` for built-in endpoints (`stockLocation.list`), `sdk.client.fetch(...)` for the four custom routes this plan adds. Never raw `fetch()`.
- Display queries (the integrations list) load on mount with no `enabled` gate; modal-only queries (credential keys, stock locations for the form Select) are gated on the Drawer being open.
- Prices are not touched by this issue (no monetary fields on `OngoingIntegration`) — the `data-price-format` rule doesn't apply here.
- Plugin build output is `.medusa/server`; every backend task must compile under **`yarn build`** and pass **`yarn lint`**; every admin task must additionally pass the `tsc` type-gate above.
- Tests are **pure unit tests** (mock the module service, `req`/`res`, workflow imports, and step `container`s) — there is no local Postgres/Medusa instance in this plugin (matches every existing `__tests__` suite in `src/`).

---

## File Structure

**Create:**
- `src/admin/lib/sdk.ts` — the shared Medusa JS SDK singleton (owned by #40 per the M5 ownership map; #41 imports it).
- `src/workflows/steps/create-ongoing-integration-row.ts` — `createOngoingIntegrationRowStep` (insert + compensating delete).
- `src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts`
- `src/workflows/create-ongoing-integration.ts` — `createOngoingIntegrationWorkflow` (row insert, then `setupOngoingLocationWorkflow.runAsStep(...)`).
- `src/workflows/steps/update-ongoing-integration.ts` — `updateOngoingIntegrationStep` (update + compensating revert).
- `src/workflows/steps/__tests__/update-ongoing-integration.test.ts`
- `src/workflows/update-ongoing-integration.ts` — `updateOngoingIntegrationWorkflow`.
- `src/workflows/__tests__/update-ongoing-integration.test.ts` — real-container workflow-level test (mirrors `push-order-to-ongoing.test.ts`).
- `src/workflows/steps/delete-ongoing-integration.ts` — `deleteOngoingIntegrationStep` (delete, no compensation).
- `src/workflows/steps/__tests__/delete-ongoing-integration.test.ts`
- `src/workflows/delete-ongoing-integration.ts` — `deleteOngoingIntegrationWorkflow`.
- `src/workflows/__tests__/delete-ongoing-integration.test.ts` — real-container workflow-level test.
- `src/api/admin/ongoing/credential-keys/route.ts` — `GET`, backs the create-form Select.
- `src/api/admin/ongoing/credential-keys/__tests__/route.test.ts`
- `src/api/admin/ongoing/test-connection/validators.ts` — `validateTestConnectionInput`.
- `src/api/admin/ongoing/test-connection/route.ts` — `POST`, drives the Test connection button.
- `src/api/admin/ongoing/test-connection/__tests__/route.test.ts`
- `src/api/admin/ongoing/integrations/validators.ts` — `validateCreateIntegrationInput`.
- `src/api/admin/ongoing/integrations/route.ts` — `GET` (list, direct read), `POST` (calls `createOngoingIntegrationWorkflow`).
- `src/api/admin/ongoing/integrations/__tests__/route.test.ts`
- `src/api/admin/ongoing/integrations/[id]/validators.ts` — `validateUpdateIntegrationInput`.
- `src/api/admin/ongoing/integrations/[id]/route.ts` — `GET` (retrieve, direct read), `POST` (calls `updateOngoingIntegrationWorkflow`), `DELETE` (calls `deleteOngoingIntegrationWorkflow`).
- `src/api/admin/ongoing/integrations/[id]/__tests__/route.test.ts`
- `src/modules/ongoing/__tests__/list-credential-keys.test.ts`
- `src/admin/routes/settings/ongoing/utils/parse-codes.ts` — `parseCodesCsv`, `parseEditSyncRulesJson` (pure functions, TDD'd under node-env Jest).
- `src/admin/routes/settings/ongoing/utils/__tests__/parse-codes.test.ts`
- `src/admin/routes/settings/ongoing/page.tsx` — the settings page (list + drawer trigger).
- `src/admin/routes/settings/ongoing/integration-drawer.tsx` — the create/edit form Drawer + Test connection wiring.

**Edit:**
- `package.json` — add `"@medusajs/js-sdk": "2.16.0"` to `devDependencies` (owned by #40).
- `src/modules/ongoing/service.ts` — add `listCredentialKeys(): string[]`.
- `src/lib/ongoing/types.ts` — add `STOCK_RECONCILE_MODES` / `StockReconcileMode` (shared by the workflow steps and the API validators — see Task 5).
- `src/workflows/index.ts` — export the three new workflows and their input types.

**Depends on (already exists, do not modify):**
- `src/modules/ongoing/index.ts` — `ONGOING_MODULE = "ongoing"`.
- `src/modules/ongoing/service.ts` — `getCredentials(credentialKey): OngoingCredentials` (sync, throws `MedusaError(INVALID_DATA)` on unknown key), `getClient(credentialKey): OngoingClient` (sync).
- `src/modules/ongoing/models/integration.ts` — the `OngoingIntegration` model (all fields referenced by name throughout this plan).
- `src/lib/ongoing/client.ts` — `OngoingClient.getOrderStatuses(): Promise<OngoingOrderStatus[]>`.
- `src/lib/ongoing/types.ts` — `OngoingOrderStatus = { number: number; text: string }`.
- `src/workflows/setup-location/setup-location.ts` — `SetupOngoingLocationInput = { integration_id: string; stock_location_id: string; fulfillment_set_mode?: FulfillmentSetMode }`; `setupOngoingLocationWorkflow.runAsStep({ input })` composes into a parent workflow (already used this way internally, e.g. `createServiceZonesWorkflow.runAsStep(...)` at line 114-121).
- `src/workflows/steps/cancel-ongoing-order.ts` — the `createStep(name, invoke)` shape with no compensation function, the precedent `deleteOngoingIntegrationStep` follows.
- `src/workflows/setup-location/steps/upsert-integration-location.ts` — the `createStep(name, invoke, compensate)` shape with a snapshot-and-restore compensation, the precedent `updateOngoingIntegrationStep` follows.

---

## Task 1: Admin SDK singleton + `@medusajs/js-sdk` devDependency (scaffolding)

Pure config/scaffolding (no business logic) — exempt from TDD per `docs/superpowers/process.md`. Verified by `yarn install` succeeding and the admin `tsc` type-gate compiling cleanly.

**Files:**
- Edit: `package.json`
- Create: `src/admin/lib/sdk.ts`

- [ ] **Step 1: Add `@medusajs/js-sdk` to `devDependencies`**

In `package.json`, insert the line after `"@medusajs/icons": "2.16.0",` and before `"@medusajs/medusa": "2.16.0",`:

```json
    "@medusajs/icons": "2.16.0",
    "@medusajs/js-sdk": "2.16.0",
    "@medusajs/medusa": "2.16.0",
```

- [ ] **Step 2: Install**

Run: `yarn install`
Expected: completes with no errors (yarn.lock already resolves `@medusajs/js-sdk@npm:2.16.0` as a transitive dependency; this just promotes it to a direct, declared one — `node_modules/@medusajs/js-sdk` already exists).

- [ ] **Step 3: Create the SDK singleton**

Create `src/admin/lib/sdk.ts`:

```ts
import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})
```

- [ ] **Step 4: Type-check the admin bundle**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: no errors. (This is the admin type-gate for the whole plan — `yarn build` does **not** type-check `src/admin`; see "Global Constraints." `sdk.ts` is not imported by anything yet — Task 10 wires it up — this step just confirms it compiles standalone under `src/admin/tsconfig.json`'s `strict: true`.)

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/admin/lib/sdk.ts
git commit -m "chore(ongoing-admin): add @medusajs/js-sdk + shared admin SDK singleton (#40)"
```

---

## Task 2: `OngoingModuleService.listCredentialKeys()` (TDD)

**Files:**
- Edit: `src/modules/ongoing/service.ts`
- Create: `src/modules/ongoing/__tests__/list-credential-keys.test.ts`

**Interfaces:**
- Produces: `listCredentialKeys(): string[]` — the configured `OngoingCredentials.key` values, in plugin-options order. Backs `GET /admin/ongoing/credential-keys` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/modules/ongoing/__tests__/list-credential-keys.test.ts` (mirrors the real-instantiation pattern already used in `src/modules/ongoing/__tests__/sync-lock.test.ts`):

```ts
import OngoingModuleService from "../service"

describe("OngoingModuleService.listCredentialKeys", () => {
  it("returns the configured credential keys in order", () => {
    const svc = new OngoingModuleService({} as any, {
      integrations: [
        { key: "wh-1", baseUrl: "https://a", username: "u", password: "p", goodsOwnerId: 1 },
        { key: "wh-2", baseUrl: "https://b", username: "u", password: "p", goodsOwnerId: 2 },
      ],
    } as any)

    expect(svc.listCredentialKeys()).toEqual(["wh-1", "wh-2"])
  })

  it("returns an empty array when no integrations are configured", () => {
    const svc = new OngoingModuleService({} as any, { integrations: [] } as any)

    expect(svc.listCredentialKeys()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/modules/ongoing/__tests__/list-credential-keys.test.ts`
Expected: FAIL — `svc.listCredentialKeys is not a function`.

- [ ] **Step 3: Implement**

In `src/modules/ongoing/service.ts`, add the method after `getClient` (around line 53), before `getIntegrationByLocation`:

```ts
  // Pure synchronous config accessor (no I/O) — same rationale as getCredentials
  // and getClient above: this reads in-memory plugin options, not the DB.
  // eslint-disable-next-line @medusajs/service-methods-must-be-async
  listCredentialKeys(): string[] {
    return this.options_.integrations.map((i) => i.key)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/modules/ongoing/__tests__/list-credential-keys.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full unit suite + lint + build**

Run: `yarn test && yarn lint && yarn build`
Expected: all suites PASS; lint clean; build compiles.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ongoing/service.ts src/modules/ongoing/__tests__/list-credential-keys.test.ts
git commit -m "feat(ongoing-module): add listCredentialKeys() (#40)"
```

---

## Task 3: `GET /admin/ongoing/credential-keys` (TDD)

**Files:**
- Create: `src/api/admin/ongoing/credential-keys/route.ts`
- Create: `src/api/admin/ongoing/credential-keys/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE` from `../../../../modules/ongoing`; `OngoingModuleService.listCredentialKeys(): string[]` (Task 2).
- Produces: `export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void>` → `res.json({ credential_keys: string[] })`.

- [ ] **Step 1: Write the failing test**

Create `src/api/admin/ongoing/credential-keys/__tests__/route.test.ts`:

```ts
import { GET } from "../route"

const makeService = (keys: string[]) => ({
  listCredentialKeys: jest.fn(() => keys),
})

const makeReq = (service: ReturnType<typeof makeService>) =>
  ({
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("GET /admin/ongoing/credential-keys", () => {
  it("returns the configured credential keys", async () => {
    const service = makeService(["wh-1", "wh-2"])
    const res = makeRes()

    await GET(makeReq(service), res)

    expect(service.listCredentialKeys).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ credential_keys: ["wh-1", "wh-2"] })
  })

  it("returns an empty list when no integrations are configured", async () => {
    const service = makeService([])
    const res = makeRes()

    await GET(makeReq(service), res)

    expect(res.json).toHaveBeenCalledWith({ credential_keys: [] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/api/admin/ongoing/credential-keys/`
Expected: FAIL — cannot find module `../route`.

- [ ] **Step 3: Implement**

Create `src/api/admin/ongoing/credential-keys/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const credential_keys = ongoing.listCredentialKeys()
  res.json({ credential_keys })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/api/admin/ongoing/credential-keys/`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + build**

Run: `yarn lint && yarn build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/api/admin/ongoing/credential-keys
git commit -m "feat(ongoing-api): GET /admin/ongoing/credential-keys (#40)"
```

---

## Task 4: `POST /admin/ongoing/test-connection` (TDD)

Reads-through to the live Ongoing API with **no persisted mutation** (nothing is written to `OngoingIntegration`), so this route calls the module service directly — no workflow needed (see "Global Constraints").

**Files:**
- Create: `src/api/admin/ongoing/test-connection/validators.ts`
- Create: `src/api/admin/ongoing/test-connection/route.ts`
- Create: `src/api/admin/ongoing/test-connection/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.getClient(credentialKey: string): OngoingClient` (sync, throws `MedusaError(INVALID_DATA)` on unknown key); `OngoingClient.getOrderStatuses(): Promise<OngoingOrderStatus[]>`.
- Produces: `export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void>` → `res.json({ success: true, statuses: OngoingOrderStatus[] })` on a reachable connection, `res.json({ success: false, error: string })` when the Ongoing API call itself fails, or a thrown `MedusaError(INVALID_DATA)` (propagated, not caught) when the request body or `credential_key` is invalid. Works pre-save (no `integration_id` needed) — the create-form Drawer calls this before the integration row exists.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/test-connection/__tests__/route.test.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"
import { POST } from "../route"

const makeService = (opts: {
  getClient?: (key: string) => { getOrderStatuses: () => Promise<unknown> }
}) => ({
  getClient: jest.fn(
    opts.getClient ??
      (() => {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
      })
  ),
})

const makeReq = (body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("POST /admin/ongoing/test-connection", () => {
  it("throws MedusaError(INVALID_DATA) when credential_key is missing", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq({}, service), res)).rejects.toThrow(MedusaError)
    expect(service.getClient).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it("propagates MedusaError(INVALID_DATA) for an unknown credential_key", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq({ credential_key: "wh-nope" }, service), res)).rejects.toMatchObject(
      { type: MedusaError.Types.INVALID_DATA }
    )
  })

  it("returns success + statuses when the Ongoing API is reachable", async () => {
    const statuses = [{ number: 100, text: "Registered" }, { number: 320, text: "Shipped" }]
    const service = makeService({
      getClient: () => ({ getOrderStatuses: () => Promise.resolve(statuses) }),
    })
    const res = makeRes()

    await POST(makeReq({ credential_key: "wh-1" }, service), res)

    expect(service.getClient).toHaveBeenCalledWith("wh-1")
    expect(res.json).toHaveBeenCalledWith({ success: true, statuses })
  })

  it("returns success:false + error when the Ongoing API call fails", async () => {
    const service = makeService({
      getClient: () => ({ getOrderStatuses: () => Promise.reject(new Error("ECONNREFUSED")) }),
    })
    const res = makeRes()

    await POST(makeReq({ credential_key: "wh-1" }, service), res)

    expect(res.json).toHaveBeenCalledWith({ success: false, error: "ECONNREFUSED" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/admin/ongoing/test-connection/`
Expected: FAIL — cannot find module `../route`.

- [ ] **Step 3: Implement the validator**

Create `src/api/admin/ongoing/test-connection/validators.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"

export type TestConnectionInput = {
  credential_key: string
}

export function validateTestConnectionInput(body: unknown): TestConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.credential_key !== "string" || b.credential_key.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] credential_key is required")
  }
  return { credential_key: b.credential_key }
}
```

- [ ] **Step 4: Implement the route**

Create `src/api/admin/ongoing/test-connection/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"
import { validateTestConnectionInput } from "./validators"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { credential_key } = validateTestConnectionInput(req.body)
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService

  // Throws MedusaError(INVALID_DATA) for an unknown credential_key — intentionally
  // NOT caught here; that is a bad request, distinct from a reachable-but-failing
  // Ongoing API call below.
  const client = ongoing.getClient(credential_key)

  try {
    const statuses = await client.getOrderStatuses()
    res.json({ success: true, statuses })
  } catch (err) {
    res.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/api/admin/ongoing/test-connection/`
Expected: PASS (4 tests).

- [ ] **Step 6: Lint + build**

Run: `yarn lint && yarn build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/api/admin/ongoing/test-connection
git commit -m "feat(ongoing-api): POST /admin/ongoing/test-connection (#40)"
```

---

## Task 5: `createOngoingIntegrationWorkflow` — insert + location setup, with rollback (TDD)

This is the fix for the cross-plan blocker: the row insert and the location setup are now one saga. `createOngoingIntegrationRowHandler` also owns the `credential_key` business-validation (throws before ever touching the DB), and its `StepResponse` compensation input is exactly what's needed to delete the row if the composed `setupOngoingLocationWorkflow` step fails afterward.

**Files:**
- Edit: `src/lib/ongoing/types.ts`
- Create: `src/workflows/steps/create-ongoing-integration-row.ts`
- Create: `src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts`
- Create: `src/workflows/create-ongoing-integration.ts`
- Edit: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.getCredentials(credentialKey): OngoingCredentials` (sync, throws `MedusaError(INVALID_DATA)` on unknown key); `.createOngoingIntegrations(data): Promise<OngoingIntegration>` (auto-CRUD; single-object input returns a single entity); `.deleteOngoingIntegrations(id): Promise<void>`; `setupOngoingLocationWorkflow` from `./setup-location/setup-location` (composed via `.runAsStep()`).
- Produces: `createOngoingIntegrationRowStep` (invoke: `CreateOngoingIntegrationRowInput → StepResponse<OngoingIntegrationRow, { integrationId: string }>`; compensate: deletes `compensation.integrationId`); `createOngoingIntegrationWorkflow` — `createOngoingIntegrationWorkflow(container).run({ input: CreateOngoingIntegrationInput })` resolves `{ result: OngoingIntegrationRow }`. Consumed by Task 8's `POST /admin/ongoing/integrations`.

- [ ] **Step 1: Add the shared `StockReconcileMode` type**

Append to `src/lib/ongoing/types.ts` (shared by the workflow step below and the API validators in Task 8/9 — keeping it out of `src/api/**` means the workflow layer never imports from the route layer):

```ts
// --- Ongoing integration settings enums (admin CRUD + workflows; #40) ---

export const STOCK_RECONCILE_MODES = ["sellable_plus_reserved", "precise", "onhand"] as const
export type StockReconcileMode = (typeof STOCK_RECONCILE_MODES)[number]
```

- [ ] **Step 2: Write the failing step tests**

Create `src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts` (mirrors the raw-handler-invocation style of `src/workflows/steps/__tests__/cancel-ongoing-order.test.ts`):

```ts
import { MedusaError } from "@medusajs/framework/utils"
import {
  createOngoingIntegrationRowHandler,
  compensateOngoingIntegrationRowHandler,
  type CreateOngoingIntegrationRowInput,
} from "../create-ongoing-integration-row"

const validInput: CreateOngoingIntegrationRowInput = {
  credential_key: "wh-1",
  stock_location_id: "sloc_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: null,
  status_poll_interval: null,
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules: null,
  shipped_status_codes: null,
  cancellable_status_codes: null,
}

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) },
})

describe("createOngoingIntegrationRowStep", () => {
  it("validates the credential_key, creates the row, and returns compensation data", async () => {
    const created = { id: "integ_1", ...validInput }
    const getCredentials = jest.fn().mockReturnValue({ key: "wh-1" })
    const createOngoingIntegrations = jest.fn().mockResolvedValue(created)
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    const res = await createOngoingIntegrationRowHandler(validInput, context)

    expect(getCredentials).toHaveBeenCalledWith("wh-1")
    expect(createOngoingIntegrations).toHaveBeenCalledWith(validInput)
    expect(res.output).toEqual(created)
    expect(res.compensateInput).toEqual({ integrationId: "integ_1" })
  })

  it("throws MedusaError(INVALID_DATA) for an unknown credential_key, without creating a row", async () => {
    const getCredentials = jest.fn(() => {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
    })
    const createOngoingIntegrations = jest.fn()
    const context = makeContext({ getCredentials, createOngoingIntegrations })

    await expect(createOngoingIntegrationRowHandler(validInput, context)).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrations).not.toHaveBeenCalled()
  })
})

describe("compensateOngoingIntegrationRowStep", () => {
  it("deletes the row that was created", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const context = makeContext({ deleteOngoingIntegrations })

    await compensateOngoingIntegrationRowHandler({ integrationId: "integ_1" }, context)

    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
  })

  it("is a no-op when there is nothing to compensate", async () => {
    const deleteOngoingIntegrations = jest.fn()
    const context = makeContext({ deleteOngoingIntegrations })

    await compensateOngoingIntegrationRowHandler(undefined, context)

    expect(deleteOngoingIntegrations).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts`
Expected: FAIL — cannot find module `../create-ongoing-integration-row`.

- [ ] **Step 4: Implement the step**

Create `src/workflows/steps/create-ongoing-integration-row.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { StockReconcileMode } from "../../lib/ongoing/types"

export type CreateOngoingIntegrationRowInput = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

export type OngoingIntegrationRow = CreateOngoingIntegrationRowInput & { id: string }

export type CreateOngoingIntegrationRowCompensation = { integrationId: string }

export const createOngoingIntegrationRowHandler = async (
  input: CreateOngoingIntegrationRowInput,
  { container }: { container: any }
): Promise<StepResponse<OngoingIntegrationRow, CreateOngoingIntegrationRowCompensation>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService

  // Business validation (does this credential_key exist in plugin options?)
  // lives here, not in the route — throws MedusaError(INVALID_DATA) before any
  // row is written, so there is nothing to compensate on this failure path.
  ongoing.getCredentials(input.credential_key)

  const integration = await ongoing.createOngoingIntegrations(input)
  return new StepResponse(integration, { integrationId: integration.id })
}

export const compensateOngoingIntegrationRowHandler = async (
  compensation: CreateOngoingIntegrationRowCompensation | undefined,
  { container }: { container: any }
): Promise<void> => {
  if (!compensation) {
    return
  }
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  await ongoing.deleteOngoingIntegrations(compensation.integrationId)
}

export const createOngoingIntegrationRowStep = createStep(
  "create-ongoing-integration-row",
  createOngoingIntegrationRowHandler,
  compensateOngoingIntegrationRowHandler
)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Implement the workflow (composes the existing `setupOngoingLocationWorkflow`)**

Create `src/workflows/create-ongoing-integration.ts`:

```ts
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createOngoingIntegrationRowStep,
  type CreateOngoingIntegrationRowInput,
} from "./steps/create-ongoing-integration-row"
import { setupOngoingLocationWorkflow } from "./setup-location/setup-location"

export type CreateOngoingIntegrationInput = CreateOngoingIntegrationRowInput

export const createOngoingIntegrationWorkflow = createWorkflow(
  "create-ongoing-integration",
  function (input: CreateOngoingIntegrationInput) {
    // Step 1: insert the row (compensable — deletes the row on any later failure).
    const integration = createOngoingIntegrationRowStep(input)

    // Step 2: bind the stock location. Composed via .runAsStep() — the same
    // mechanism setupOngoingLocationWorkflow itself uses internally for
    // createServiceZonesWorkflow/createShippingOptionsWorkflow — so if this
    // step (or anything inside it) fails, the outer saga runs Step 1's
    // compensation and the row is deleted. No orphaned integration.
    const setupInput = transform({ integration, input }, (data) => ({
      integration_id: data.integration.id,
      stock_location_id: data.input.stock_location_id,
    }))
    setupOngoingLocationWorkflow.runAsStep({ input: setupInput })

    return new WorkflowResponse(integration)
  }
)

export default createOngoingIntegrationWorkflow
```

- [ ] **Step 7: Export from the workflows barrel**

In `src/workflows/index.ts`, add:

```ts
export { createOngoingIntegrationWorkflow } from "./create-ongoing-integration"
export type { CreateOngoingIntegrationInput } from "./create-ongoing-integration"
```

- [ ] **Step 8: Run the full unit suite, lint, build**

Run: `yarn test && yarn lint && yarn build`
Expected: all PASS/clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ongoing/types.ts src/workflows/steps/create-ongoing-integration-row.ts src/workflows/steps/__tests__/create-ongoing-integration-row.test.ts src/workflows/create-ongoing-integration.ts src/workflows/index.ts
git commit -m "feat(ongoing-workflow): createOngoingIntegrationWorkflow — row insert + location setup, compensable (#40)"
```

---

## Task 6: `updateOngoingIntegrationWorkflow` (TDD)

**Files:**
- Create: `src/workflows/steps/update-ongoing-integration.ts`
- Create: `src/workflows/steps/__tests__/update-ongoing-integration.test.ts`
- Create: `src/workflows/update-ongoing-integration.ts`
- Create: `src/workflows/__tests__/update-ongoing-integration.test.ts`
- Edit: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.retrieveOngoingIntegration(id): Promise<OngoingIntegration>`; `.updateOngoingIntegrations(data): Promise<OngoingIntegration>`.
- Produces: `updateOngoingIntegrationStep` (invoke: snapshots the row's previous editable-field values, then updates; compensate: restores the snapshot); `updateOngoingIntegrationWorkflow(container).run({ input: UpdateOngoingIntegrationInput })` resolves `{ result: OngoingIntegration }`. Consumed by Task 9's `POST /admin/ongoing/integrations/:id`. Unlike Task 5's `createOngoingIntegrationWorkflow`, this workflow only resolves the `"ongoing"` service — no heavy sub-workflow — so it gets a real workflow-level test (Steps 5-8 below), not just a step-level one.

- [ ] **Step 1: Write the failing step tests**

Create `src/workflows/steps/__tests__/update-ongoing-integration.test.ts`:

```ts
import {
  updateOngoingIntegrationHandler,
  compensateOngoingIntegrationHandler,
} from "../update-ongoing-integration"

const previousRow = {
  id: "integ_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "300000",
  status_poll_interval: "60000",
  stock_reconcile_mode: "sellable_plus_reserved" as const,
  edit_sync_rules: null,
  shipped_status_codes: [320],
  cancellable_status_codes: [100],
}

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) },
})

describe("updateOngoingIntegrationStep", () => {
  it("snapshots the previous values, applies the update, and returns compensation data", async () => {
    const retrieveOngoingIntegration = jest.fn().mockResolvedValue(previousRow)
    const updated = { ...previousRow, enabled: false }
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(updated)
    const context = makeContext({ retrieveOngoingIntegration, updateOngoingIntegrations })

    const res = await updateOngoingIntegrationHandler({ id: "integ_1", enabled: false }, context)

    expect(updateOngoingIntegrations).toHaveBeenCalledWith({ id: "integ_1", enabled: false })
    expect(res.output).toEqual(updated)
    expect(res.compensateInput).toEqual({
      id: "integ_1",
      previous: {
        enabled: true,
        stock_sync_enabled: true,
        stock_sync_interval: "300000",
        status_poll_interval: "60000",
        stock_reconcile_mode: "sellable_plus_reserved",
        edit_sync_rules: null,
        shipped_status_codes: [320],
        cancellable_status_codes: [100],
      },
    })
  })
})

describe("compensateOngoingIntegrationStep", () => {
  it("restores the previous values", async () => {
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(previousRow)
    const context = makeContext({ updateOngoingIntegrations })
    const previous = {
      enabled: true,
      stock_sync_enabled: true,
      stock_sync_interval: "300000",
      status_poll_interval: "60000",
      stock_reconcile_mode: "sellable_plus_reserved" as const,
      edit_sync_rules: null,
      shipped_status_codes: [320],
      cancellable_status_codes: [100],
    }

    await compensateOngoingIntegrationHandler({ id: "integ_1", previous }, context)

    expect(updateOngoingIntegrations).toHaveBeenCalledWith({
      id: "integ_1",
      enabled: true,
      stock_sync_enabled: true,
      stock_sync_interval: "300000",
      status_poll_interval: "60000",
      stock_reconcile_mode: "sellable_plus_reserved",
      edit_sync_rules: null,
      shipped_status_codes: [320],
      cancellable_status_codes: [100],
    })
  })

  it("is a no-op when there is nothing to compensate", async () => {
    const updateOngoingIntegrations = jest.fn()
    const context = makeContext({ updateOngoingIntegrations })

    await compensateOngoingIntegrationHandler(undefined, context)

    expect(updateOngoingIntegrations).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/workflows/steps/__tests__/update-ongoing-integration.test.ts`
Expected: FAIL — cannot find module `../update-ongoing-integration`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/update-ongoing-integration.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"
import type { StockReconcileMode } from "../../lib/ongoing/types"

export type UpdateOngoingIntegrationInput = {
  id: string
  enabled?: boolean
  stock_sync_enabled?: boolean
  stock_sync_interval?: string | null
  status_poll_interval?: string | null
  stock_reconcile_mode?: StockReconcileMode
  edit_sync_rules?: Record<string, unknown> | null
  shipped_status_codes?: number[] | null
  cancellable_status_codes?: number[] | null
}

type PreviousIntegrationState = {
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

export type UpdateOngoingIntegrationCompensation = {
  id: string
  previous: PreviousIntegrationState
}

export const updateOngoingIntegrationHandler = async (
  input: UpdateOngoingIntegrationInput,
  { container }: { container: any }
): Promise<StepResponse<Record<string, unknown>, UpdateOngoingIntegrationCompensation>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const existing = await ongoing.retrieveOngoingIntegration(input.id)
  const previous: PreviousIntegrationState = {
    enabled: existing.enabled,
    stock_sync_enabled: existing.stock_sync_enabled,
    stock_sync_interval: existing.stock_sync_interval,
    status_poll_interval: existing.status_poll_interval,
    stock_reconcile_mode: existing.stock_reconcile_mode,
    edit_sync_rules: existing.edit_sync_rules,
    shipped_status_codes: existing.shipped_status_codes,
    cancellable_status_codes: existing.cancellable_status_codes,
  }

  const updated = await ongoing.updateOngoingIntegrations(input)
  return new StepResponse(updated, { id: input.id, previous })
}

export const compensateOngoingIntegrationHandler = async (
  compensation: UpdateOngoingIntegrationCompensation | undefined,
  { container }: { container: any }
): Promise<void> => {
  if (!compensation) {
    return
  }
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  await ongoing.updateOngoingIntegrations({ id: compensation.id, ...compensation.previous })
}

export const updateOngoingIntegrationStep = createStep(
  "update-ongoing-integration",
  updateOngoingIntegrationHandler,
  compensateOngoingIntegrationHandler
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/workflows/steps/__tests__/update-ongoing-integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing workflow-level test**

Create `src/workflows/__tests__/update-ongoing-integration.test.ts` (a real `createMedusaContainer()` running the actual orchestrator, mirroring `src/workflows/__tests__/push-order-to-ongoing.test.ts` — this workflow only resolves `"ongoing"`, so no heavier fixtures are needed):

```ts
import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { updateOngoingIntegrationWorkflow } from "../update-ongoing-integration"

const previousRow = {
  id: "integ_1",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: null,
  status_poll_interval: null,
  stock_reconcile_mode: "sellable_plus_reserved" as const,
  edit_sync_rules: null,
  shipped_status_codes: null,
  cancellable_status_codes: null,
}

function buildContainer(service: Record<string, jest.Mock>) {
  const container: any = createMedusaContainer()
  container.register("ongoing", asValue(service))
  return container
}

describe("updateOngoingIntegrationWorkflow", () => {
  it("runs the update step through the real orchestrator and resolves the updated row", async () => {
    const updated = { ...previousRow, enabled: false }
    const retrieveOngoingIntegration = jest.fn().mockResolvedValue(previousRow)
    const updateOngoingIntegrations = jest.fn().mockResolvedValue(updated)
    const container = buildContainer({ retrieveOngoingIntegration, updateOngoingIntegrations })

    const { result } = await updateOngoingIntegrationWorkflow(container).run({
      input: { id: "integ_1", enabled: false },
    })

    expect(result).toEqual(updated)
    expect(updateOngoingIntegrations).toHaveBeenCalledWith({ id: "integ_1", enabled: false })
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `yarn test src/workflows/__tests__/update-ongoing-integration.test.ts`
Expected: FAIL — cannot find module `../update-ongoing-integration` (the workflow file doesn't exist yet).

- [ ] **Step 7: Implement the workflow**

Create `src/workflows/update-ongoing-integration.ts`:

```ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  updateOngoingIntegrationStep,
  type UpdateOngoingIntegrationInput,
} from "./steps/update-ongoing-integration"

export type { UpdateOngoingIntegrationInput }

export const updateOngoingIntegrationWorkflow = createWorkflow(
  "update-ongoing-integration",
  function (input: UpdateOngoingIntegrationInput) {
    const integration = updateOngoingIntegrationStep(input)
    return new WorkflowResponse(integration)
  }
)

export default updateOngoingIntegrationWorkflow
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `yarn test src/workflows/__tests__/update-ongoing-integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Export from the workflows barrel**

In `src/workflows/index.ts`, add:

```ts
export { updateOngoingIntegrationWorkflow } from "./update-ongoing-integration"
export type { UpdateOngoingIntegrationInput } from "./update-ongoing-integration"
```

- [ ] **Step 10: Run the full unit suite, lint, build**

Run: `yarn test && yarn lint && yarn build`
Expected: all PASS/clean.

- [ ] **Step 11: Commit**

```bash
git add src/workflows/steps/update-ongoing-integration.ts src/workflows/steps/__tests__/update-ongoing-integration.test.ts src/workflows/update-ongoing-integration.ts src/workflows/__tests__/update-ongoing-integration.test.ts src/workflows/index.ts
git commit -m "feat(ongoing-workflow): updateOngoingIntegrationWorkflow — snapshot + compensable update (#40)"
```

---

## Task 7: `deleteOngoingIntegrationWorkflow` (TDD)

**Files:**
- Create: `src/workflows/steps/delete-ongoing-integration.ts`
- Create: `src/workflows/steps/__tests__/delete-ongoing-integration.test.ts`
- Create: `src/workflows/delete-ongoing-integration.ts`
- Create: `src/workflows/__tests__/delete-ongoing-integration.test.ts`
- Edit: `src/workflows/index.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.deleteOngoingIntegrations(id): Promise<void>`.
- Produces: `deleteOngoingIntegrationStep` (invoke only, no compensation — same shape as `cancelOngoingOrderStep`); `deleteOngoingIntegrationWorkflow(container).run({ input: { id: string } })` resolves `{ result: { id, object: "integration", deleted: true } }`. Consumed by Task 9's `DELETE /admin/ongoing/integrations/:id`. Like Task 6, this workflow only resolves `"ongoing"`, so it also gets a real workflow-level test (Steps 5-8 below).

- [ ] **Step 1: Write the failing step test**

Create `src/workflows/steps/__tests__/delete-ongoing-integration.test.ts`:

```ts
import { deleteOngoingIntegrationHandler } from "../delete-ongoing-integration"

const makeContext = (service: Record<string, jest.Mock>) => ({
  container: { resolve: jest.fn(() => service) },
})

describe("deleteOngoingIntegrationStep", () => {
  it("deletes the row and returns the standard delete response", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const context = makeContext({ deleteOngoingIntegrations })

    const res = await deleteOngoingIntegrationHandler({ id: "integ_1" }, context)

    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
    expect(res.output).toEqual({ id: "integ_1", object: "integration", deleted: true })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/workflows/steps/__tests__/delete-ongoing-integration.test.ts`
Expected: FAIL — cannot find module `../delete-ongoing-integration`.

- [ ] **Step 3: Implement the step**

Create `src/workflows/steps/delete-ongoing-integration.ts`:

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type DeleteOngoingIntegrationInput = { id: string }
export type DeleteOngoingIntegrationOutput = { id: string; object: "integration"; deleted: true }

export const deleteOngoingIntegrationHandler = async (
  input: DeleteOngoingIntegrationInput,
  { container }: { container: any }
): Promise<StepResponse<DeleteOngoingIntegrationOutput>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  await ongoing.deleteOngoingIntegrations(input.id)
  return new StepResponse({ id: input.id, object: "integration", deleted: true })
}

// No compensation function — mirrors cancelOngoingOrderStep
// (src/workflows/steps/cancel-ongoing-order.ts:33-36): this is the terminal
// step of its own single-step workflow, so there is nothing after it that
// could fail and require rolling this delete back.
export const deleteOngoingIntegrationStep = createStep(
  "delete-ongoing-integration",
  deleteOngoingIntegrationHandler
)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/workflows/steps/__tests__/delete-ongoing-integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write the failing workflow-level test**

Create `src/workflows/__tests__/delete-ongoing-integration.test.ts` (same real-container pattern as Task 6 Step 5):

```ts
import { createMedusaContainer } from "@medusajs/framework/utils"
import { asValue } from "awilix"
import { deleteOngoingIntegrationWorkflow } from "../delete-ongoing-integration"

describe("deleteOngoingIntegrationWorkflow", () => {
  it("runs the delete step through the real orchestrator and resolves the standard delete response", async () => {
    const deleteOngoingIntegrations = jest.fn().mockResolvedValue(undefined)
    const container: any = createMedusaContainer()
    container.register("ongoing", asValue({ deleteOngoingIntegrations }))

    const { result } = await deleteOngoingIntegrationWorkflow(container).run({
      input: { id: "integ_1" },
    })

    expect(result).toEqual({ id: "integ_1", object: "integration", deleted: true })
    expect(deleteOngoingIntegrations).toHaveBeenCalledWith("integ_1")
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `yarn test src/workflows/__tests__/delete-ongoing-integration.test.ts`
Expected: FAIL — cannot find module `../delete-ongoing-integration` (the workflow file doesn't exist yet).

- [ ] **Step 7: Implement the workflow**

Create `src/workflows/delete-ongoing-integration.ts`:

```ts
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deleteOngoingIntegrationStep,
  type DeleteOngoingIntegrationInput,
} from "./steps/delete-ongoing-integration"

export type { DeleteOngoingIntegrationInput }

export const deleteOngoingIntegrationWorkflow = createWorkflow(
  "delete-ongoing-integration",
  function (input: DeleteOngoingIntegrationInput) {
    const result = deleteOngoingIntegrationStep(input)
    return new WorkflowResponse(result)
  }
)

export default deleteOngoingIntegrationWorkflow
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `yarn test src/workflows/__tests__/delete-ongoing-integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Export from the workflows barrel**

In `src/workflows/index.ts`, add:

```ts
export { deleteOngoingIntegrationWorkflow } from "./delete-ongoing-integration"
export type { DeleteOngoingIntegrationInput } from "./delete-ongoing-integration"
```

- [ ] **Step 10: Run the full unit suite, lint, build**

Run: `yarn test && yarn lint && yarn build`
Expected: all PASS/clean.

- [ ] **Step 11: Commit**

```bash
git add src/workflows/steps/delete-ongoing-integration.ts src/workflows/steps/__tests__/delete-ongoing-integration.test.ts src/workflows/delete-ongoing-integration.ts src/workflows/__tests__/delete-ongoing-integration.test.ts src/workflows/index.ts
git commit -m "feat(ongoing-workflow): deleteOngoingIntegrationWorkflow (#40)"
```

---

## Task 8: `GET`/`POST /admin/ongoing/integrations` — list + create (TDD)

**Files:**
- Create: `src/api/admin/ongoing/integrations/validators.ts`
- Create: `src/api/admin/ongoing/integrations/route.ts`
- Create: `src/api/admin/ongoing/integrations/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.listOngoingIntegrations(): Promise<OngoingIntegration[]>` (direct read, no workflow); `createOngoingIntegrationWorkflow` + `CreateOngoingIntegrationInput` from `../../../../workflows` (Task 5).
- Produces: `export async function GET(...)` → `res.json({ integrations })`; `export async function POST(...)` → validates request shape, calls `createOngoingIntegrationWorkflow(req.scope).run({ input })`, returns `res.status(201).json({ integration })`. On workflow rejection (e.g. an unknown `credential_key` or a failed location setup — both now handled with compensation inside the workflow, see Task 5), the route's promise rejects and **no response is ever sent** — there is no path that returns a success status for a row that didn't fully persist.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/integrations/__tests__/route.test.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"

// Hoisted above imports by @swc/jest — the mock fn must be created inside the
// factory (see src/api/ongoing/webhooks/[credentialKey]/__tests__/route.test.ts
// for the same TDZ-avoidance pattern), then re-imported for assertions.
jest.mock("../../../../../workflows", () => ({
  __esModule: true,
  createOngoingIntegrationWorkflow: jest.fn(),
}))

import { GET, POST } from "../route"
import { createOngoingIntegrationWorkflow as createOngoingIntegrationWorkflowImport } from "../../../../../workflows"

const createOngoingIntegrationWorkflow =
  createOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof createOngoingIntegrationWorkflowImport
  >

const makeService = (opts: { listResult?: Record<string, unknown>[] }) => ({
  listOngoingIntegrations: jest.fn().mockResolvedValue(opts.listResult ?? []),
})

const makeReq = (body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

const validBody = () => ({
  credential_key: "wh-1",
  stock_location_id: "sloc_1",
})

describe("GET /admin/ongoing/integrations", () => {
  it("lists all integrations", async () => {
    const rows = [{ id: "integ_1" }, { id: "integ_2" }]
    const service = makeService({ listResult: rows })
    const res = makeRes()

    await GET(makeReq(undefined, service), res)

    expect(res.json).toHaveBeenCalledWith({ integrations: rows })
  })
})

describe("POST /admin/ongoing/integrations", () => {
  it("throws MedusaError(INVALID_DATA) when credential_key is missing, without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ stock_location_id: "sloc_1" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("throws MedusaError(INVALID_DATA) when stock_location_id is missing", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ credential_key: "wh-1" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("rejects an invalid stock_reconcile_mode without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq({ ...validBody(), stock_reconcile_mode: "bogus" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(createOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("runs the workflow with the validated input and returns 201", async () => {
    const created = { id: "integ_1", credential_key: "wh-1", stock_location_id: "sloc_1" }
    const run = jest.fn().mockResolvedValue({ result: created })
    createOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()
    const req = makeReq(validBody(), service)

    await POST(req, res)

    expect(createOngoingIntegrationWorkflow).toHaveBeenCalledWith(req.scope)
    expect(run).toHaveBeenCalledWith({
      input: expect.objectContaining({
        credential_key: "wh-1",
        stock_location_id: "sloc_1",
        enabled: true,
        stock_sync_enabled: true,
        stock_reconcile_mode: "sellable_plus_reserved",
      }),
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith({ integration: created })
  })

  it("propagates a workflow rejection and never sends a response (no orphaned-row success path)", async () => {
    const run = jest.fn().mockRejectedValue(
      new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] no credentials configured")
    )
    createOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await expect(POST(makeReq(validBody(), service), res)).rejects.toThrow(MedusaError)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/admin/ongoing/integrations/`
Expected: FAIL — cannot find module `../route`.

- [ ] **Step 3: Implement the validator**

Create `src/api/admin/ongoing/integrations/validators.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"
import { STOCK_RECONCILE_MODES, StockReconcileMode } from "../../../../lib/ongoing/types"

export type CreateIntegrationInput = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `[ongoing] ${message}`)
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
}

// Request-SHAPE validation only (required fields, correct types/enums) — this
// never touches plugin options or the DB. Whether the credential_key actually
// exists is business validation and lives in the workflow step
// (createOngoingIntegrationRowHandler, src/workflows/steps/create-ongoing-integration-row.ts).
export function validateCreateIntegrationInput(body: unknown): CreateIntegrationInput {
  const b = (body ?? {}) as Record<string, unknown>

  if (typeof b.credential_key !== "string" || b.credential_key.length === 0) {
    invalid("credential_key is required")
  }
  if (typeof b.stock_location_id !== "string" || b.stock_location_id.length === 0) {
    invalid("stock_location_id is required")
  }
  if (
    b.stock_reconcile_mode !== undefined &&
    !STOCK_RECONCILE_MODES.includes(b.stock_reconcile_mode as StockReconcileMode)
  ) {
    invalid(`stock_reconcile_mode must be one of ${STOCK_RECONCILE_MODES.join(", ")}`)
  }
  if (
    b.shipped_status_codes !== undefined &&
    b.shipped_status_codes !== null &&
    !isNumberArray(b.shipped_status_codes)
  ) {
    invalid("shipped_status_codes must be an array of numbers")
  }
  if (
    b.cancellable_status_codes !== undefined &&
    b.cancellable_status_codes !== null &&
    !isNumberArray(b.cancellable_status_codes)
  ) {
    invalid("cancellable_status_codes must be an array of numbers")
  }
  if (
    b.edit_sync_rules !== undefined &&
    b.edit_sync_rules !== null &&
    typeof b.edit_sync_rules !== "object"
  ) {
    invalid("edit_sync_rules must be an object")
  }

  return {
    credential_key: b.credential_key as string,
    stock_location_id: b.stock_location_id as string,
    enabled: typeof b.enabled === "boolean" ? b.enabled : true,
    stock_sync_enabled: typeof b.stock_sync_enabled === "boolean" ? b.stock_sync_enabled : true,
    stock_sync_interval: typeof b.stock_sync_interval === "string" ? b.stock_sync_interval : null,
    status_poll_interval: typeof b.status_poll_interval === "string" ? b.status_poll_interval : null,
    stock_reconcile_mode: (b.stock_reconcile_mode as StockReconcileMode) ?? "sellable_plus_reserved",
    edit_sync_rules: (b.edit_sync_rules as Record<string, unknown> | null) ?? null,
    shipped_status_codes: (b.shipped_status_codes as number[] | null) ?? null,
    cancellable_status_codes: (b.cancellable_status_codes as number[] | null) ?? null,
  }
}
```

- [ ] **Step 4: Implement the route**

Create `src/api/admin/ongoing/integrations/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"
import { createOngoingIntegrationWorkflow } from "../../../../workflows"
import { validateCreateIntegrationInput } from "./validators"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const integrations = await ongoing.listOngoingIntegrations()
  res.json({ integrations })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const input = validateCreateIntegrationInput(req.body)

  const { result: integration } = await createOngoingIntegrationWorkflow(req.scope).run({ input })

  res.status(201).json({ integration })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/api/admin/ongoing/integrations/`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full unit suite, lint, build**

Run: `yarn test && yarn lint && yarn build`
Expected: all PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add src/api/admin/ongoing/integrations/validators.ts src/api/admin/ongoing/integrations/route.ts src/api/admin/ongoing/integrations/__tests__
git commit -m "feat(ongoing-api): GET/POST /admin/ongoing/integrations — list + create via createOngoingIntegrationWorkflow (#40)"
```

---

## Task 9: `GET`/`POST`/`DELETE /admin/ongoing/integrations/:id` — retrieve, update, delete (TDD)

**Files:**
- Create: `src/api/admin/ongoing/integrations/[id]/validators.ts`
- Create: `src/api/admin/ongoing/integrations/[id]/route.ts`
- Create: `src/api/admin/ongoing/integrations/[id]/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `ONGOING_MODULE`; `OngoingModuleService.retrieveOngoingIntegration(id): Promise<OngoingIntegration>` (direct read; throws `MedusaError(NOT_FOUND)` on a missing id — framework default); `updateOngoingIntegrationWorkflow` + `UpdateOngoingIntegrationInput` (Task 6); `deleteOngoingIntegrationWorkflow` (Task 7).
- Produces: `GET` → `res.json({ integration })`; `POST` → `res.json({ integration })` (never writes `credential_key`/`stock_location_id` — see Design decision 3); `DELETE` → `res.json({ id, object: "integration", deleted: true })`.

- [ ] **Step 1: Write the failing tests**

Create `src/api/admin/ongoing/integrations/[id]/__tests__/route.test.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"

jest.mock("../../../../../../workflows", () => ({
  __esModule: true,
  updateOngoingIntegrationWorkflow: jest.fn(),
  deleteOngoingIntegrationWorkflow: jest.fn(),
}))

import { GET, POST, DELETE } from "../route"
import {
  updateOngoingIntegrationWorkflow as updateOngoingIntegrationWorkflowImport,
  deleteOngoingIntegrationWorkflow as deleteOngoingIntegrationWorkflowImport,
} from "../../../../../../workflows"

const updateOngoingIntegrationWorkflow =
  updateOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof updateOngoingIntegrationWorkflowImport
  >
const deleteOngoingIntegrationWorkflow =
  deleteOngoingIntegrationWorkflowImport as jest.MockedFunction<
    typeof deleteOngoingIntegrationWorkflowImport
  >

const makeService = (opts: { retrieveResult?: Record<string, unknown> | Error }) => ({
  retrieveOngoingIntegration: jest.fn(() => {
    if (opts.retrieveResult instanceof Error) {
      return Promise.reject(opts.retrieveResult)
    }
    return Promise.resolve(opts.retrieveResult ?? {})
  }),
})

const makeReq = (id: string, body: unknown, service: ReturnType<typeof makeService>) =>
  ({
    params: { id },
    body,
    scope: { resolve: jest.fn(() => service) },
  }) as any

const makeRes = () => ({ json: jest.fn() }) as any

describe("GET /admin/ongoing/integrations/:id", () => {
  it("returns the integration", async () => {
    const integration = { id: "integ_1", credential_key: "wh-1" }
    const service = makeService({ retrieveResult: integration })
    const res = makeRes()

    await GET(makeReq("integ_1", undefined, service), res)

    expect(service.retrieveOngoingIntegration).toHaveBeenCalledWith("integ_1")
    expect(res.json).toHaveBeenCalledWith({ integration })
  })

  it("propagates MedusaError(NOT_FOUND) for a missing id", async () => {
    const notFound = new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
    const service = makeService({ retrieveResult: notFound })
    const res = makeRes()

    await expect(GET(makeReq("integ_missing", undefined, service), res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    })
  })
})

describe("POST /admin/ongoing/integrations/:id", () => {
  it("throws MedusaError(INVALID_DATA) for a malformed body, without running the workflow", async () => {
    const service = makeService({})
    const res = makeRes()

    await expect(
      POST(makeReq("integ_1", { enabled: "yes" }, service), res)
    ).rejects.toThrow(MedusaError)
    expect(updateOngoingIntegrationWorkflow).not.toHaveBeenCalled()
  })

  it("runs the workflow with only the allowed fields", async () => {
    const updated = { id: "integ_1", enabled: false }
    const run = jest.fn().mockResolvedValue({ result: updated })
    updateOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await POST(makeReq("integ_1", { enabled: false, stock_sync_interval: "300000" }, service), res)

    expect(run).toHaveBeenCalledWith({
      input: { id: "integ_1", enabled: false, stock_sync_interval: "300000" },
    })
    expect(res.json).toHaveBeenCalledWith({ integration: updated })
  })

  it("never forwards credential_key or stock_location_id even if present in the body", async () => {
    const run = jest.fn().mockResolvedValue({ result: { id: "integ_1" } })
    updateOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await POST(
      makeReq(
        "integ_1",
        { enabled: true, credential_key: "wh-changed", stock_location_id: "sloc-changed" },
        service
      ),
      res
    )

    const call = run.mock.calls[0][0].input
    expect(call).toEqual({ id: "integ_1", enabled: true })
    expect(call).not.toHaveProperty("credential_key")
    expect(call).not.toHaveProperty("stock_location_id")
  })
})

describe("DELETE /admin/ongoing/integrations/:id", () => {
  it("runs the delete workflow and returns its result", async () => {
    const result = { id: "integ_1", object: "integration", deleted: true }
    const run = jest.fn().mockResolvedValue({ result })
    deleteOngoingIntegrationWorkflow.mockReturnValue({ run } as any)
    const service = makeService({})
    const res = makeRes()

    await DELETE(makeReq("integ_1", undefined, service), res)

    expect(run).toHaveBeenCalledWith({ input: { id: "integ_1" } })
    expect(res.json).toHaveBeenCalledWith(result)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/api/admin/ongoing/integrations/`
Expected: FAIL — cannot find module `../route` (scoping to the parent `integrations/` directory reliably picks up both this suite and Task 8's sibling suite; a bracketed path segment like `[id]` passed directly to jest is treated as an unreliable regex, so this plan never scopes a test run to a path containing `[id]`).

- [ ] **Step 3: Implement the validator**

Create `src/api/admin/ongoing/integrations/[id]/validators.ts`:

```ts
import { MedusaError } from "@medusajs/framework/utils"
import { STOCK_RECONCILE_MODES, StockReconcileMode } from "../../../../../lib/ongoing/types"

// credential_key and stock_location_id are deliberately NOT modeled here even
// if present in the request body — they are immutable after creation (see
// "Design decisions" #3 in the #40 plan). Any such keys in the body are never
// read into the returned object, so they can never reach the update workflow.
export type UpdateIntegrationInput = {
  enabled?: boolean
  stock_sync_enabled?: boolean
  stock_sync_interval?: string | null
  status_poll_interval?: string | null
  stock_reconcile_mode?: StockReconcileMode
  edit_sync_rules?: Record<string, unknown> | null
  shipped_status_codes?: number[] | null
  cancellable_status_codes?: number[] | null
}

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `[ongoing] ${message}`)
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number")
}

export function validateUpdateIntegrationInput(body: unknown): UpdateIntegrationInput {
  const b = (body ?? {}) as Record<string, unknown>
  const result: UpdateIntegrationInput = {}

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") invalid("enabled must be a boolean")
    result.enabled = b.enabled as boolean
  }
  if (b.stock_sync_enabled !== undefined) {
    if (typeof b.stock_sync_enabled !== "boolean") invalid("stock_sync_enabled must be a boolean")
    result.stock_sync_enabled = b.stock_sync_enabled as boolean
  }
  if (b.stock_sync_interval !== undefined) {
    if (b.stock_sync_interval !== null && typeof b.stock_sync_interval !== "string") {
      invalid("stock_sync_interval must be a string or null")
    }
    result.stock_sync_interval = b.stock_sync_interval as string | null
  }
  if (b.status_poll_interval !== undefined) {
    if (b.status_poll_interval !== null && typeof b.status_poll_interval !== "string") {
      invalid("status_poll_interval must be a string or null")
    }
    result.status_poll_interval = b.status_poll_interval as string | null
  }
  if (b.stock_reconcile_mode !== undefined) {
    if (!STOCK_RECONCILE_MODES.includes(b.stock_reconcile_mode as StockReconcileMode)) {
      invalid(`stock_reconcile_mode must be one of ${STOCK_RECONCILE_MODES.join(", ")}`)
    }
    result.stock_reconcile_mode = b.stock_reconcile_mode as StockReconcileMode
  }
  if (b.edit_sync_rules !== undefined) {
    if (b.edit_sync_rules !== null && typeof b.edit_sync_rules !== "object") {
      invalid("edit_sync_rules must be an object or null")
    }
    result.edit_sync_rules = b.edit_sync_rules as Record<string, unknown> | null
  }
  if (b.shipped_status_codes !== undefined) {
    if (b.shipped_status_codes !== null && !isNumberArray(b.shipped_status_codes)) {
      invalid("shipped_status_codes must be an array of numbers or null")
    }
    result.shipped_status_codes = b.shipped_status_codes as number[] | null
  }
  if (b.cancellable_status_codes !== undefined) {
    if (b.cancellable_status_codes !== null && !isNumberArray(b.cancellable_status_codes)) {
      invalid("cancellable_status_codes must be an array of numbers or null")
    }
    result.cancellable_status_codes = b.cancellable_status_codes as number[] | null
  }

  return result
}
```

- [ ] **Step 4: Implement the route**

Create `src/api/admin/ongoing/integrations/[id]/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../../modules/ongoing"
import OngoingModuleService from "../../../../../modules/ongoing/service"
import { updateOngoingIntegrationWorkflow, deleteOngoingIntegrationWorkflow } from "../../../../../workflows"
import { validateUpdateIntegrationInput } from "./validators"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const integration = await ongoing.retrieveOngoingIntegration(id)
  res.json({ integration })
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params
  const update = validateUpdateIntegrationInput(req.body)

  const { result: integration } = await updateOngoingIntegrationWorkflow(req.scope).run({
    input: { id, ...update },
  })

  res.json({ integration })
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params

  const { result } = await deleteOngoingIntegrationWorkflow(req.scope).run({ input: { id } })

  res.json(result)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/api/admin/ongoing/integrations/`
Expected: PASS (11 tests total — 7 from Task 8's sibling suite + 6 here).

- [ ] **Step 6: Run the full unit suite, lint, build**

Run: `yarn test && yarn lint && yarn build`
Expected: all PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add "src/api/admin/ongoing/integrations/[id]"
git commit -m "feat(ongoing-api): GET/POST/DELETE /admin/ongoing/integrations/:id via update/delete workflows (#40)"
```

---

## Task 10: Admin settings page — list, create/edit Drawer, Test connection, delete confirmation

**Not TDD (React wiring only):** there is no `@testing-library/react` or jsdom `testEnvironment` configured anywhere in this repo (`jest.config.js` uses `testEnvironment: "node"`, and no existing `src/admin/**` test exists to establish a convention) — adding a React testing harness is out of scope for a settings-page issue and no research/spec asked for it. The *pure business logic* this UI depends on (CSV parsing, `edit_sync_rules` JSON parsing) is **not** exempt from TDD — it is extracted into its own plain-`.ts` module (`utils/parse-codes.ts`) and TDD'd under the existing node-env Jest in Step 1 below, exactly like any other pure function in this repo (e.g. `src/workflows/setup-location/helpers.ts`). Only the React component wiring around it (Steps 6-7) is scaffolding, verified by the standalone admin `tsc` type-gate (never `yarn build` — see "Global Constraints") plus the manual QA checklist.

**Files:**
- Create: `src/admin/routes/settings/ongoing/utils/parse-codes.ts`
- Create: `src/admin/routes/settings/ongoing/utils/__tests__/parse-codes.test.ts`
- Create: `src/admin/routes/settings/ongoing/integration-drawer.tsx`
- Create: `src/admin/routes/settings/ongoing/page.tsx`

**Interfaces:**
- Consumes: `sdk` from `../../../lib/sdk` (Task 1); `GET /admin/ongoing/integrations` → `{ integrations: OngoingIntegration[] }` (Task 8); `POST /admin/ongoing/integrations` → `{ integration }` (Task 8); `GET /admin/ongoing/integrations/:id`, `POST /admin/ongoing/integrations/:id` → `{ integration }`, `DELETE /admin/ongoing/integrations/:id` → `{ id, object, deleted }` (Task 9); `GET /admin/ongoing/credential-keys` → `{ credential_keys: string[] }` (Task 3); `POST /admin/ongoing/test-connection` → `{ success, statuses?, error? }` (Task 4); `sdk.admin.stockLocation.list(query?)` → `{ stock_locations: { id: string; name: string }[] }` (built-in SDK method); `parseCodesCsv`, `parseEditSyncRulesJson` from `./utils/parse-codes` (Step 1 below).
- Produces: the mounted route at `/app/settings/ongoing`, labeled "Ongoing Warehouse" in the Settings navigation.

- [ ] **Step 1: Write the failing tests for the pure parsing utilities**

Create `src/admin/routes/settings/ongoing/utils/__tests__/parse-codes.test.ts`:

```ts
import { parseCodesCsv, parseEditSyncRulesJson } from "../parse-codes"

describe("parseCodesCsv", () => {
  it("parses a comma/space-separated list into numbers", () => {
    expect(parseCodesCsv("300, 320  410")).toEqual([300, 320, 410])
  })

  it("returns null for an empty or whitespace-only string", () => {
    expect(parseCodesCsv("")).toBeNull()
    expect(parseCodesCsv("   ")).toBeNull()
  })

  it("throws on a non-integer token", () => {
    expect(() => parseCodesCsv("300, abc")).toThrow('"abc" is not a valid status code')
  })

  it("throws on a decimal token", () => {
    expect(() => parseCodesCsv("300.5")).toThrow('"300.5" is not a valid status code')
  })
})

describe("parseEditSyncRulesJson", () => {
  it("returns null for an empty or whitespace-only string", () => {
    expect(parseEditSyncRulesJson("")).toBeNull()
    expect(parseEditSyncRulesJson("   ")).toBeNull()
  })

  it("parses a valid JSON object", () => {
    expect(parseEditSyncRulesJson('{"address": "resync"}')).toEqual({ address: "resync" })
  })

  it("throws on invalid JSON", () => {
    expect(() => parseEditSyncRulesJson("{not json")).toThrow("Edit sync rules must be valid JSON")
  })

  it("throws when the JSON parses to a non-object (array, number, string)", () => {
    expect(() => parseEditSyncRulesJson("[1,2,3]")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson("5")).toThrow("Edit sync rules must be a JSON object")
    expect(() => parseEditSyncRulesJson('"hello"')).toThrow("Edit sync rules must be a JSON object")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/admin/routes/settings/ongoing/utils/`
Expected: FAIL — cannot find module `../parse-codes`.

- [ ] **Step 3: Implement the parsing utilities**

Create `src/admin/routes/settings/ongoing/utils/parse-codes.ts`:

```ts
// Parses "300, 320" -> [300, 320]; throws on any non-integer token so the
// caller can surface a validation error instead of silently dropping codes.
export function parseCodesCsv(csv: string): number[] | null {
  const trimmed = csv.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.split(/[,\s]+/).map((token) => {
    const n = Number(token)
    if (!Number.isInteger(n)) {
      throw new Error(`"${token}" is not a valid status code`)
    }
    return n
  })
}

// Parses the "Edit sync rules" JSON textarea into a plain object, or null if
// empty. Throws a friendly error both on unparseable JSON and on JSON that
// parses but isn't an object (an array, number, string, or null literal).
export function parseEditSyncRulesJson(json: string): Record<string, unknown> | null {
  const trimmed = json.trim()
  if (!trimmed) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error("Edit sync rules must be valid JSON")
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Edit sync rules must be a JSON object")
  }

  return parsed as Record<string, unknown>
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/admin/routes/settings/ongoing/utils/`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS, including this new one (`jest.config.js`'s `roots: <rootDir>/src` + `testMatch **/__tests__/**/*.test.ts` picks up any depth under `src/`, including `src/admin/**`).

- [ ] **Step 6: Create the shared create/edit Drawer**

Create `src/admin/routes/settings/ongoing/integration-drawer.tsx`:

```tsx
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Drawer, Button, Input, Label, Select, Switch, Textarea, Text, toast } from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import { parseCodesCsv, parseEditSyncRulesJson } from "./utils/parse-codes"

export type StockReconcileMode = "sellable_plus_reserved" | "precise" | "onhand"

export type OngoingIntegration = {
  id: string
  credential_key: string
  enabled: boolean
  stock_location_id: string
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

type FormState = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string
  status_poll_interval: string
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules_json: string
  shipped_status_codes_csv: string
  cancellable_status_codes_csv: string
}

const EMPTY_FORM: FormState = {
  credential_key: "",
  stock_location_id: "",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "",
  status_poll_interval: "",
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules_json: "",
  shipped_status_codes_csv: "",
  cancellable_status_codes_csv: "",
}

function toFormState(integration: OngoingIntegration): FormState {
  return {
    credential_key: integration.credential_key,
    stock_location_id: integration.stock_location_id,
    enabled: integration.enabled,
    stock_sync_enabled: integration.stock_sync_enabled,
    stock_sync_interval: integration.stock_sync_interval ?? "",
    status_poll_interval: integration.status_poll_interval ?? "",
    stock_reconcile_mode: integration.stock_reconcile_mode,
    edit_sync_rules_json: integration.edit_sync_rules
      ? JSON.stringify(integration.edit_sync_rules, null, 2)
      : "",
    shipped_status_codes_csv: (integration.shipped_status_codes ?? []).join(", "),
    cancellable_status_codes_csv: (integration.cancellable_status_codes ?? []).join(", "),
  }
}

type Props = {
  mode: "create" | "edit" | null
  integration: OngoingIntegration | null
  onClose: () => void
}

export function IntegrationDrawer({ mode, integration, onClose }: Props) {
  const open = mode !== null
  const isEdit = mode === "edit"
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    if (mode === "edit" && integration) {
      setForm(toFormState(integration))
    } else if (mode === "create") {
      setForm(EMPTY_FORM)
    }
    setError(null)
    setTestResult(null)
  }, [mode, integration])

  // Modal-only data (credential keys, stock locations) — gated on the Drawer
  // being open, per the separate display/modal query pattern. Neither has a
  // display-query counterpart on this page.
  const { data: credentialKeysData } = useQuery({
    queryFn: () => sdk.client.fetch<{ credential_keys: string[] }>("/admin/ongoing/credential-keys"),
    queryKey: ["ongoing-credential-keys"],
    enabled: open,
  })

  const { data: stockLocationsData } = useQuery({
    queryFn: () => sdk.admin.stockLocation.list({ limit: 100 }),
    queryKey: ["ongoing-stock-locations-for-drawer"],
    enabled: open,
  })

  const testConnection = useMutation({
    mutationFn: (credential_key: string) =>
      sdk.client.fetch<{
        success: boolean
        statuses?: { number: number; text: string }[]
        error?: string
      }>("/admin/ongoing/test-connection", { method: "POST", body: { credential_key } }),
    onSuccess: (result) => {
      if (result.success) {
        setTestResult(`Connected — ${result.statuses?.length ?? 0} order statuses available`)
        toast.success("Connection successful")
      } else {
        setTestResult(`Failed: ${result.error}`)
        toast.error(result.error ?? "Connection failed")
      }
    },
    onError: (err: Error) => {
      setTestResult(`Failed: ${err.message}`)
      toast.error(err.message)
    },
  })

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch("/admin/ongoing/integrations", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
      toast.success("Integration created")
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch(`/admin/ongoing/integrations/${integration?.id}`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
      toast.success("Integration updated")
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const handleSubmit = () => {
    setError(null)
    let shipped_status_codes: number[] | null
    let cancellable_status_codes: number[] | null
    let edit_sync_rules: Record<string, unknown> | null
    try {
      shipped_status_codes = parseCodesCsv(form.shipped_status_codes_csv)
      cancellable_status_codes = parseCodesCsv(form.cancellable_status_codes_csv)
      edit_sync_rules = parseEditSyncRulesJson(form.edit_sync_rules_json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid input")
      return
    }

    const shared = {
      enabled: form.enabled,
      stock_sync_enabled: form.stock_sync_enabled,
      stock_sync_interval: form.stock_sync_interval || null,
      status_poll_interval: form.status_poll_interval || null,
      stock_reconcile_mode: form.stock_reconcile_mode,
      edit_sync_rules,
      shipped_status_codes,
      cancellable_status_codes,
    }

    if (isEdit) {
      updateMutation.mutate(shared)
    } else {
      createMutation.mutate({
        ...shared,
        credential_key: form.credential_key,
        stock_location_id: form.stock_location_id,
      })
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{isEdit ? "Edit integration" : "Create integration"}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex-1 overflow-auto flex flex-col gap-y-4 p-4">
          <div className="flex flex-col gap-y-2">
            <Label>Credential key</Label>
            {isEdit ? (
              <Input value={form.credential_key} disabled />
            ) : (
              <Select
                value={form.credential_key}
                onValueChange={(value) => setForm({ ...form, credential_key: value })}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select a credential key" />
                </Select.Trigger>
                <Select.Content>
                  {(credentialKeysData?.credential_keys ?? []).map((key) => (
                    <Select.Item key={key} value={key}>
                      {key}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock location</Label>
            {isEdit ? (
              <Input value={form.stock_location_id} disabled />
            ) : (
              <Select
                value={form.stock_location_id}
                onValueChange={(value) => setForm({ ...form, stock_location_id: value })}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select a stock location" />
                </Select.Trigger>
                <Select.Content>
                  {(stockLocationsData?.stock_locations ?? []).map((loc) => (
                    <Select.Item key={loc.id} value={loc.id}>
                      {loc.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
            {!isEdit && (
              <Text size="small" className="text-ui-fg-subtle">
                Assigning a stock location runs setup automatically (fulfillment set, service
                zone, shipping option) and cannot be changed after the integration is created.
              </Text>
            )}
          </div>

          <div className="flex items-center justify-between">
            <Label>Enabled</Label>
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <Label>Stock sync enabled</Label>
            <Switch
              checked={form.stock_sync_enabled}
              onCheckedChange={(checked) => setForm({ ...form, stock_sync_enabled: checked })}
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock sync interval (ms)</Label>
            <Input
              value={form.stock_sync_interval}
              onChange={(e) => setForm({ ...form, stock_sync_interval: e.target.value })}
              placeholder="e.g. 300000"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Status poll interval (ms)</Label>
            <Input
              value={form.status_poll_interval}
              onChange={(e) => setForm({ ...form, status_poll_interval: e.target.value })}
              placeholder="e.g. 60000"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock reconcile mode</Label>
            <Select
              value={form.stock_reconcile_mode}
              onValueChange={(value) =>
                setForm({ ...form, stock_reconcile_mode: value as StockReconcileMode })
              }
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="sellable_plus_reserved">sellable_plus_reserved</Select.Item>
                <Select.Item value="precise">precise</Select.Item>
                <Select.Item value="onhand">onhand</Select.Item>
              </Select.Content>
            </Select>
          </div>

          {/* MVP editor: raw JSON. Out of scope for #40/#41 to build a structured
              rule builder. */}
          <div className="flex flex-col gap-y-2">
            <Label>Edit sync rules (JSON)</Label>
            <Textarea
              rows={6}
              value={form.edit_sync_rules_json}
              onChange={(e) => setForm({ ...form, edit_sync_rules_json: e.target.value })}
              placeholder='{"address": "resync", "line_items": "cancel_and_recreate"}'
            />
          </div>

          {/* Basic comma/space-separated input for MVP. #41 (blocked by #40) upgrades
              these two fields to a StatusCodePicker fed by this Drawer's own
              POST /admin/ongoing/test-connection statuses. */}
          <div className="flex flex-col gap-y-2">
            <Label>Shipped status codes</Label>
            <Input
              value={form.shipped_status_codes_csv}
              onChange={(e) => setForm({ ...form, shipped_status_codes_csv: e.target.value })}
              placeholder="e.g. 300, 320"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Cancellable status codes</Label>
            <Input
              value={form.cancellable_status_codes_csv}
              onChange={(e) => setForm({ ...form, cancellable_status_codes_csv: e.target.value })}
              placeholder="e.g. 100, 110"
            />
          </div>

          <div className="flex flex-col gap-y-2 border-t pt-4">
            <Button
              size="small"
              variant="secondary"
              disabled={!form.credential_key || testConnection.isPending}
              isLoading={testConnection.isPending}
              onClick={() => testConnection.mutate(form.credential_key)}
            >
              Test connection
            </Button>
            {testResult && (
              <Text size="small" className="text-ui-fg-subtle">
                {testResult}
              </Text>
            )}
          </div>

          {error && (
            <Text size="small" className="text-ui-fg-error">
              {error}
            </Text>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <div className="flex items-center justify-end gap-x-2">
            <Drawer.Close asChild>
              <Button size="small" variant="secondary" disabled={isPending}>
                Cancel
              </Button>
            </Drawer.Close>
            <Button size="small" onClick={handleSubmit} isLoading={isPending}>
              Save
            </Button>
          </div>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}
```

- [ ] **Step 7: Create the settings page**

Create `src/admin/routes/settings/ongoing/page.tsx`:

```tsx
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Container,
  Heading,
  Text,
  Button,
  Table,
  Badge,
  IconButton,
  DropdownMenu,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { EllipsisHorizontal, PencilSquare, Plus, Trash } from "@medusajs/icons"
import { sdk } from "../../../lib/sdk"
import { IntegrationDrawer, OngoingIntegration } from "./integration-drawer"

const IntegrationsSettingsPage = () => {
  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | null>(null)
  const [editing, setEditing] = useState<OngoingIntegration | null>(null)
  const queryClient = useQueryClient()
  const prompt = usePrompt()

  // Display query — loads on mount, no `enabled` gate.
  const { data, isLoading } = useQuery({
    queryFn: () =>
      sdk.client.fetch<{ integrations: OngoingIntegration[] }>("/admin/ongoing/integrations"),
    queryKey: ["ongoing-integrations"],
  })

  const handleDelete = async (integration: OngoingIntegration) => {
    const confirmed = await prompt({
      title: "Delete integration",
      description:
        `Deleting "${integration.credential_key}" only removes the Medusa-side integration row. ` +
        "The fulfillment set, service zone, and shipping option created for this stock location " +
        "are NOT removed and must be cleaned up manually if no longer needed.",
      variant: "danger",
      confirmText: "Delete",
      cancelText: "Cancel",
    })
    if (!confirmed) {
      return
    }
    try {
      await sdk.client.fetch(`/admin/ongoing/integrations/${integration.id}`, {
        method: "DELETE",
      })
      toast.success("Integration deleted")
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete integration")
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Ongoing Warehouse</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Manage Ongoing integrations, stock location assignments, and sync settings.
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            setEditing(null)
            setDrawerMode("create")
          }}
        >
          <Plus />
          Create integration
        </Button>
      </div>

      {isLoading ? (
        <div className="px-6 py-4">
          <Text size="small">Loading...</Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Credential key</Table.HeaderCell>
              <Table.HeaderCell>Stock location</Table.HeaderCell>
              <Table.HeaderCell>Enabled</Table.HeaderCell>
              <Table.HeaderCell>Reconcile mode</Table.HeaderCell>
              <Table.HeaderCell></Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(data?.integrations ?? []).map((integration) => (
              <Table.Row key={integration.id}>
                <Table.Cell>{integration.credential_key}</Table.Cell>
                <Table.Cell>{integration.stock_location_id}</Table.Cell>
                <Table.Cell>
                  <Badge color={integration.enabled ? "green" : "grey"}>
                    {integration.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>{integration.stock_reconcile_mode}</Table.Cell>
                <Table.Cell>
                  <DropdownMenu>
                    <DropdownMenu.Trigger asChild>
                      <IconButton size="small" variant="transparent">
                        <EllipsisHorizontal />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item
                        className="gap-x-2"
                        onClick={() => {
                          setEditing(integration)
                          setDrawerMode("edit")
                        }}
                      >
                        <PencilSquare className="text-ui-fg-subtle" />
                        Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item className="gap-x-2" onClick={() => handleDelete(integration)}>
                        <Trash className="text-ui-fg-subtle" />
                        Delete
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <IntegrationDrawer mode={drawerMode} integration={editing} onClose={() => setDrawerMode(null)} />
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Ongoing Warehouse",
})

export default IntegrationsSettingsPage
```

- [ ] **Step 8: Type-check the admin bundle**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: no errors. (Again: not `yarn build` — see "Global Constraints.")

- [ ] **Step 9: Lint**

Run: `yarn lint`
Expected: clean.

- [ ] **Step 10: Manual QA checklist**

In a consuming Medusa app with this plugin linked (`yarn dev` / `medusa plugin:develop`) and at least one `credential_key` configured in plugin options:

1. Navigate to Settings → Ongoing Warehouse (`/app/settings/ongoing`). The page loads with an empty table (or existing rows) and no console errors.
2. Click "Create integration" → the Drawer opens with the credential key and stock location Selects populated. Click "Test connection" before saving — it calls the live Ongoing API and shows a success/failure message without requiring a save first.
3. Fill in the form and Save → the row appears in the table, `createOngoingIntegrationWorkflow` runs `setupOngoingLocationWorkflow` (verify a fulfillment set/service zone/shipping option now exists on that stock location in Settings → Locations).
4. Click "Edit" on the new row → credential key and stock location render as read-only (disabled) inputs; other fields are editable and save via `POST /admin/ongoing/integrations/:id`.
5. Click "Delete" → the `usePrompt` confirmation names the fulfillment-set/service-zone/shipping-option teardown gap; confirming removes the row from the table.

- [ ] **Step 11: Commit**

```bash
git add src/admin/routes/settings/ongoing
git commit -m "feat(ongoing-admin): settings page — integration CRUD, assign location, test connection (#40)"
```

---

## Scope boundary with #41

This issue (#40) ships the settings page with **basic, functional editors** for `shipped_status_codes` and `cancellable_status_codes` (a comma/space-separated text `Input`, parsed client-side into `number[]`) and the `POST /admin/ongoing/test-connection` endpoint that returns `{ success, statuses }`. **Issue #41** (blocked by #40) replaces those two `Input` fields in `integration-drawer.tsx` with status-populated `StatusCodePicker` components fed by the same `test-connection` response — it does not need a new backend endpoint (do not build a separate `GET` statuses route) and should reuse `IntegrationDrawer`'s existing `testConnection` mutation and `credentialKeysData`/`stockLocationsData` queries rather than duplicating data loading.

> **§10 scope decision (recorded).** Spec §10 names `edit_sync_rules` as a third status-populated editor, but it ships here as a raw-JSON `<Textarea>` and is **not** upgraded to a `StatusCodePicker` — neither in #40 nor #41. This is a deliberate v1 deviation: `edit_sync_rules` is a per-category `{ address_contact, line_items } → codes` map, not a flat `number[]`, so a flat status picker doesn't fit. Accepted during the M5 /plan-milestone cross-plan review; a per-category picker is separate future work if wanted.

---

## Self-Review (completed during planning, updated after the revision)

- **Spec coverage (§10):** "list integrations" ✓ (Task 8 `GET`, Task 10 page); "create/edit form picks an available `credential_key`" ✓ (Task 3 + Drawer Select); "assigns the stock location (runs `setupOngoingLocationWorkflow`)" ✓ (Task 5's `createOngoingIntegrationWorkflow`); "sets stock + poll intervals" ✓ (`stock_sync_interval`, `status_poll_interval` fields); `stock_reconcile_mode` (spec's stale `stock_source_field`, corrected per the issue's resolved research) ✓; `edit_sync_rules` / `shipped_status_codes` / `cancellable_status_codes` editors ✓ (Task 10, MVP JSON/CSV inputs backed by a TDD'd parsing module, explicitly seamed for #41); "Test connection action" populated from `GET /orders/statuses` ✓ (Task 4, via `OngoingClient.getOrderStatuses`).
- **Cross-plan blocker resolved:** no route calls a module auto-CRUD mutation method directly; `createOngoingIntegrationWorkflow`'s row-insert step carries a real compensation (delete-on-failure), verified by a step-level test asserting the compensation handler calls `deleteOngoingIntegrations` with the right id, and by a route-level test asserting a workflow rejection never reaches a `res.json`/`res.status` call (Task 8's "propagates a workflow rejection… no orphaned-row success path" test). All three workflows also get their own TDD, not just their steps: `updateOngoingIntegrationWorkflow` and `deleteOngoingIntegrationWorkflow` each have a real-container, real-orchestrator workflow-level test (Task 6/7 Steps 5-8, mirroring `push-order-to-ongoing.test.ts`) in addition to their step-level tests; `createOngoingIntegrationWorkflow` is the sole, explicitly-documented exception (its nested `setupOngoingLocationWorkflow` needs fixtures this repo's pure-unit-test setup doesn't have — see the "Testing note" in Design decision 2), covered instead by its step-level test plus the route-level rejection-propagation test.
- **Admin type-gate corrected:** Task 1 Step 4 and Task 10 Step 8 both run `npx tsc -p src/admin/tsconfig.json --noEmit`, never `yarn build`, with the reason stated in "Global Constraints."
- **`[id]` test scoping corrected:** Task 9's test commands scope to `src/api/admin/ongoing/integrations/` (the parent directory), matching how `src/api/ongoing/webhooks/` is scoped in plan 35 — no bracketed path segment is ever passed to `yarn test` as a positional arg.
- **Pure logic no longer TDD-exempt:** `parseCodesCsv` and `parseEditSyncRulesJson` live in `utils/parse-codes.ts`, TDD'd in Task 10 Step 1-4 under the ordinary node-env Jest config before any component references them; only the React wiring around them is exempt.
- **Placeholder scan:** no `TBD`/`TODO`/`FIXME`; every code block is complete and directly usable; the #41 hand-off is described in prose plus a working MVP implementation, not a stub.
- **Type consistency:** `OngoingIntegration` (admin UI) matches the model's fields exactly; `CreateOngoingIntegrationRowInput`/`CreateIntegrationInput`, `UpdateOngoingIntegrationInput`/`UpdateIntegrationInput` pairs are structurally identical between the workflow-step layer and the route-validator layer (route composes/forwards, never renames a field); `STOCK_RECONCILE_MODES`/`StockReconcileMode` is defined once in `src/lib/ongoing/types.ts` and imported by both the workflow steps and the two `validators.ts` files — no duplicate enum definitions, and no `src/api/**` type is imported by `src/workflows/**` (layering is one-directional).
- **Immutability enforced server-side, not just in the UI:** `UpdateIntegrationInput`/`validateUpdateIntegrationInput` never reads `credential_key` or `stock_location_id` from the body; Task 9's "never forwards credential_key or stock_location_id" test asserts the workflow's `run({ input })` call never contains either key even when both are present in the request body.
- **Medusa rules honored:** GET/POST/DELETE only, no PUT/PATCH; `/admin/*` auto-authenticated (no manual middleware); module isolation (routes touch only the resolved `OngoingModuleService` for reads; mutations go through workflows); `MedusaError` used and allowed to propagate, not swallowed into a generic `Error`; imports are static and at the top of every file (no dynamic `import()`); **every mutation is now workflow-wrapped**, resolving the earlier draft's sole non-workflow-mutation exception.
- **Real symbols throughout:** `ONGOING_MODULE = "ongoing"` (`src/modules/ongoing/index.ts:5`); `OngoingModuleService` default export (`src/modules/ongoing/service.ts:117`); `getCredentials` (`service.ts:35`, sync, throws `MedusaError(INVALID_DATA)`); `OngoingClient.getOrderStatuses` (`src/lib/ongoing/client.ts:89-95`); `setupOngoingLocationWorkflow.runAsStep` composition precedent (`src/workflows/setup-location/setup-location.ts:114-156`); `createStep`/`StepResponse` signature incl. the `compensateInput` property name (`@medusajs/framework/workflows-sdk`, matching `src/workflows/setup-location/steps/upsert-integration-location.ts`'s existing snapshot/compensate shape); `cancelOngoingOrderStep`'s no-compensation shape (`src/workflows/steps/cancel-ongoing-order.ts:33-36`); `createMedusaContainer`/`asValue` real-container workflow test pattern (`src/workflows/__tests__/push-order-to-ongoing.test.ts:1-2,50-54`); `OngoingIntegration` model fields (`src/modules/ongoing/models/integration.ts:3-20`); `usePrompt`/`RenderPromptProps` (`@medusajs/ui`); `sdk.admin.stockLocation.list` (`@medusajs/js-sdk`); `src/admin/tsconfig.json` (`include: ["."]`, `noEmit: true`, `strict: true` — verified clean against the current worktree with `npx tsc -p src/admin/tsconfig.json --noEmit` during planning, including the `import.meta.env` reference in `src/admin/vite-env.d.ts:1`).
- **Real test commands:** `yarn test <path>` (jest, `roots: <rootDir>/src`, `testMatch **/__tests__/**/*.test.ts` per `jest.config.js`) for every backend/workflow/UI-logic task, always scoped to a real directory (never a bracketed path segment); `yarn test` for the full suite; `yarn lint` (`medusa lint`); `yarn build` (`medusa plugin:build`, backend-only gate); `npx tsc -p src/admin/tsconfig.json --noEmit` (admin-only gate).
- **No new runtime dependency risk:** `zod` deliberately avoided (see "Design decisions" #1); `@medusajs/js-sdk` is a `devDependency` only (admin bundle territory, Vite bundles it in — it is never imported from server-side `src/api`/`src/modules`/`src/workflows` code — the `src/admin/lib/sdk.ts` content is unchanged from the original draft and is the canonical text for #41/#42/#43 to match); `@tanstack/react-query` is not added to `package.json` per the admin-dashboard skill's yarn/npm guidance (already bundled by the host dashboard).

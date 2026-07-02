# Surface edit-blocked state in the order widget (render #91's persisted fields) (#93)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Checkboxes (`- [ ]`) track progress. **Both tasks below are type-shape / UI-composition changes with no new branching business logic and are exempt from `superpowers:test-driven-development`'s failing-test-first requirement, per `docs/superpowers/process.md`'s "Config, scripts, infra, and pure scaffolding are exempt"** — the exact same exemption already applied to the model-field task in `docs/superpowers/plans/2026-07-01-persist-edit-blocked-state-on-ongoingordersync-model-field-migration-subscriber-write-91.md` Task 2, and to the widget task in `docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md` Task 3. Each task explains concretely why below (Task 1: the GET route already forwards arbitrary fields via object spread, so no code change can make a "pass-through" test fail first; Task 2: conditional JSX rendering with no server round-trip, and this repo's `jest.config.js` (`testEnvironment: "node"`, `testMatch: ["**/__tests__/**/*.test.ts"]`) has no `.tsx`/jsdom test infrastructure, matching #42's own precedent). Both tasks are instead verified by the real TypeScript compiler and `yarn build`.

**Goal:** #91 added `edit_blocked_at` / `edit_blocked_category` / `edit_blocked_reason` to `OngoingOrderSync` and wired the two subscribers (`src/subscribers/order-updated.ts`, `src/subscribers/order-edit-confirmed.ts`) to write them, but explicitly left the admin surfacing out of scope. #42 built the order-detail widget but explicitly deferred edit-blocked rendering to #91. Neither plan implements the banner — this plan closes that gap: (1) widen the GET route's response row type to include the three `edit_blocked_*` fields, and (2) render an "Edit blocked" banner (category + reason) in the order widget when `edit_blocked_at` is set.

**Out of scope (explicitly, do not implement here):**
- Any change to the two subscribers, the `markOrderSyncEditBlockedWorkflow`/step, the model, or the migration — all already shipped by #91. This plan only reads and displays what #91 already persists.
- Any change to `POST /admin/ongoing/orders/[orderId]/repush` — untouched.
- Clearing/resetting the blocked banner is already handled server-side by #91's optional Task 6 (`markOrderSyncEditBlockedWorkflow(container).run({ input: { order_sync_id, blocked: false } })` on a successful re-sync, which nulls all three fields) — the widget only needs to render whatever the GET route returns; it does no client-side clearing logic.
- Bulk retry / dashboard-wide view (spec §10 "Dashboard page") — separate issue (#44 area).
- Adding `.tsx` component-level tests / jsdom test infrastructure — this repo has none (`jest.config.js`: `testEnvironment: "node"`, `testMatch: ["**/__tests__/**/*.test.ts"]`) and introducing it is a larger, separate infra decision not scoped to this issue (matches #42's own explicit choice not to add it).

---

## Research already read (cited, load-bearing)

- **`src/modules/ongoing/models/order-sync.ts:1-25`** (full file read) — confirms the exact 3 persisted field names and types this plan surfaces: `edit_blocked_at: model.dateTime().nullable()`, `edit_blocked_category: model.enum(["address_contact", "line_items"]).nullable()`, `edit_blocked_reason: model.text().nullable()` (lines 20-22), appended after `shipped_at: model.dateTime().nullable()` (line 19). No other new fields exist on the model beyond what #42's widget already renders.
- **`src/api/admin/ongoing/orders/[orderId]/sync/route.ts:1-102`** (full file read, current committed state) — the `GET` handler `listOngoingOrderSyncs({ medusa_order_id })`, then enriches each row with `tracking: OngoingOrderSyncTracking[]` via `enriched: OngoingOrderSyncWithTracking[] = syncs.map((s) => ({ ...s, tracking: ... }))` (lines 94-99). **Critical fact this plan's Task 1 relies on:** the `...s` spread forwards *every* field present on the raw service row into the JSON response, regardless of whether that field appears in the exported `OngoingOrderSyncRow` TypeScript type (lines 5-20) — the type is documentation/compile-time only, not a runtime allow-list. `OngoingOrderSyncRow` currently ends at `shipped_at: string | Date | null` (line 19) with no `edit_blocked_*` fields.
- **`src/admin/widgets/ongoing-order-sync.tsx:1-171`** (full file read, current committed state — note this differs slightly from the original `docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md` snippet: the shipped code additionally has `isLoading`/`isError` render branches and an `onError` toast on the mutation, added post-plan). Local `OngoingOrderSyncRow` type (lines 15-28) is **deliberately duplicated from the route's type, not imported** (per #42's plan note, preserved here: admin bundle uses `moduleResolution: "bundler"` via `src/admin/tsconfig.json`, server bundle uses `Node16` via root `tsconfig.json`; they compile separately, so pulling a server route file into the admin Vite bundle is avoided). Current type ends at `retry_count: number` before `tracking: OngoingOrderSyncTracking[]` (lines 26-27) — no `edit_blocked_*` fields today, confirming #42's "renders only persisted fields it knows about, no edit-blocked field at all" claim.
- **`STATE_BADGE_COLOR` const (`ongoing-order-sync.tsx:34-43`)** — the existing `Record<OngoingSyncState, "grey"|"blue"|"green"|"red"|"orange">` pattern this plan's new label maps follow (a plain object literal above the component, no hook, no test infra needed).
- **`ongoing-order-sync.tsx:116-160`** — the per-sync-row render block: header (order number + `Badge`, lines 118-123), status line (125-128), "Last synced" line (130-132), conditional tracking block (134-149, `sync.tracking.length > 0 && (...)`), conditional `last_error` block (151-155), and the `RepushButton` (157-159). This plan's banner is inserted between the "Last synced" `Text` (130-132) and the tracking block (134), following the same `{condition && (<div>...)}` conditional pattern already used twice in this file.
- **`docs/superpowers/plans/2026-07-01-persist-edit-blocked-state-on-ongoingordersync-model-field-migration-subscriber-write-91.md:334-498`** (Tasks 4-5, full read) — the **authoritative, already-shipped `edit_blocked_reason` vocabulary**: exactly three machine strings are ever persisted — `"no_edit_rules"`, `"status_unknown"`, `"status_blocked"` (derived in both subscribers from `decideOrderEditGate`'s precedence, mirrored at `order-updated.ts` and `order-edit-confirmed.ts`'s blocked branches). `"allowed"`/`"no_sync_row"` are never written to `edit_blocked_reason` (the row wouldn't exist to update in the `no_sync_row` case, and `"allowed"` is the non-blocked path, which instead **clears** the three fields to `null` per #91 Task 6). This plan's `EDIT_BLOCKED_REASON_LABEL` map covers exactly these 3 keys with a raw-string fallback for forward-compatibility.
- **`docs/superpowers/plans/2026-07-01-persist-edit-blocked-state-on-ongoingordersync-model-field-migration-subscriber-write-91.md` Task 1, Step 3, test 3 (lines 120-133)** — confirms a **defensive edge case this plan's widget must handle**: `markOrderSyncEditBlockedHandler` can be called with `blocked: true` and no `category`/`reason`, which still sets `edit_blocked_at` to a `Date` while leaving `edit_blocked_category`/`edit_blocked_reason` as `null`. The banner therefore cannot assume `edit_blocked_category`/`edit_blocked_reason` are non-null whenever `edit_blocked_at` is set; it needs its own `null` fallback text.
- **`docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:229-247`** (§8 "Order updates — full edit re-sync, gated") — "Blocked → skip + emit a warning event; surface in the admin order widget" (line 239) — the requirement this plan implements. `edit_sync_rules` categories are `address_contact` / `line_items` (§4 line 127), matching the model enum exactly.
- **`docs/superpowers/specs/2026-06-23-ongoing-warehouse-fulfillment-plugin-design.md:293-294`** (§10 "Admin UI") — "Order widget — Ongoing order number/id, current status code/text, tracking (parcels), last sync/error, re-push / retry button" — already delivered by #42; this plan is the missing edit-blocked line item for the same widget.
- **`jest.config.js`** (full file read) — `testEnvironment: "node"`, `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]` (note: `.ts` only, **not** `.tsx`), `@swc/jest` transform, `clearMocks: true`. Confirms no JSX/component test runner exists in this repo; Task 2's widget change cannot be driven by a red/green unit test without adding new test infrastructure, which is out of scope (see header).
- **`src/admin/tsconfig.json`** (full file read) — `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `jsx: "react-jsx"`, `moduleResolution: "bundler"`, `include: ["."]`, `exclude: ["**/__tests__/**"]`. This is the **actual type-gate** for the widget (per #42's own note: `yarn build`/`medusa plugin:build` excludes `src/admin` from the server `tsc` compile and bundles it via Vite/esbuild, which transpiles but does not type-check).
- **`~/.claude memory: npx-tsc-fake-success`** — `npx tsc` silently fakes a passing result in this sandbox, "esp. `src/admin`". This plan therefore uses `node_modules/.bin/tsc`, **not** `npx tsc`, for both type-gates (Task 1's server `tsconfig.json` gate and Task 2's `src/admin/tsconfig.json` gate) — a deliberate deviation from #42's own plan text, which used `npx tsc` and is superseded here by this more recent, verified finding.
- **`node_modules/@medusajs/ui/dist/esm/components/badge/badge.d.ts`** (installed package, read from the sibling checkout at `/Volumes/Projects/Medusa-projects/plugins/MedusaOngoingWarehousePlugin/node_modules` — this worktree has no `node_modules` of its own) — `Badge`'s `color` prop accepts `"green" | "red" | "blue" | "orange" | "grey" | "purple"`; its `size` variant (`badgeSizeVariants`) accepts `"2xsmall" | "xsmall" | "small" | "base" | "large"`.
- **`node_modules/@medusajs/ui/dist/esm/components/badge/badge.js`** (installed package, same sibling checkout) — confirms `Badge`'s own `color="orange"` implementation uses exactly the classes `bg-ui-tag-orange-bg text-ui-tag-orange-text [&_svg]:text-ui-tag-orange-icon border-ui-tag-orange-border` — these are real, shipped semantic Tailwind utility classes from the Medusa UI preset (not invented), so this plan's banner reuses them directly for visual consistency with the `Badge` it sits beside, per the `building-admin-dashboard-customizations` skill's `design-semantic-colors` rule ("Always use semantic color classes ... never hardcoded").
- **`medusa-dev:building-admin-dashboard-customizations` skill** (`SKILL.md` + `references/display-patterns.md` + `references/typography.md`, all read in full) — applied rules: `typo-labels`/`typo-descriptions` (`<Text size="small" leading="compact" weight="plus">` for labels, `<Text size="small" leading="compact" className="text-ui-fg-subtle">` for descriptions — this plan's new `Text` elements add `leading="compact"`, which the pre-existing widget code omits; this is new code following the skill, not a retrofit of existing lines), `typo-no-heading-widgets` (no `Heading` used — banner uses `Badge` + `Text` only), `design-semantic-colors` (the `ui-tag-orange-*` classes above), `design-medusa-components` (uses `Badge`/`Text`, no raw HTML text). No data-loading changes (no new query/mutation), so `data-*` rules are unaffected.
- **`medusa-dev:building-with-medusa` skill** (`SKILL.md`, read in full) — confirms this plan's route change stays compliant: no new mutation, no workflow needed (`arch-workflow-required` inapplicable — nothing is written), only `GET` (no PUT/PATCH introduced), no `query.graph`/`query.index` change, no price fields touched (`data-price-format` inapplicable — `edit_blocked_*` are not price fields).

---

## Global Constraints

- Medusa **2.16.0** pinned; TypeScript **5.6**; yarn **4.6.0**; Node **>= 20**.
- **No PUT/PATCH, no new mutation, no new workflow** — this plan only widens a `GET` response's TypeScript type and renders already-persisted, already-fetched data. `ONGOING_MODULE`/`query.graph` usage in `route.ts` is untouched.
- **Module isolation preserved** — no new cross-module or cross-file imports; the widget keeps its local, duplicated `OngoingOrderSyncRow` type per #42's established convention (do not import the route's type into `src/admin/**`).
- Admin bundle (`src/admin/**`) is excluded from the root `tsconfig.json` server compile (`tsconfig.json`'s `exclude`) and type-checked separately via `src/admin/tsconfig.json`.
- `jest.config.js`: `testEnvironment: "node"`, `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`, `@swc/jest` transform, `clearMocks: true`.
- **Use `node_modules/.bin/tsc`, never `npx tsc`**, for every type-check command in this plan (per the `npx-tsc-fake-success` finding cited above — `npx tsc` silently fakes success in this sandbox).

---

## File Structure

**Modify:**
- `src/api/admin/ongoing/orders/[orderId]/sync/route.ts` — widen `OngoingOrderSyncRow` with 3 new fields.
- `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts` — extend the `makeSyncRow` fixture and add one pass-through regression test.
- `src/admin/widgets/ongoing-order-sync.tsx` — widen the local `OngoingOrderSyncRow` type, add 2 label maps, add the banner block.

**No new files.**

**Depends on (already exists, unmodified, shipped by #91/#42):**
- `src/modules/ongoing/models/order-sync.ts` — the 3 persisted columns.
- `src/subscribers/order-updated.ts`, `src/subscribers/order-edit-confirmed.ts` — write the 3 fields via `markOrderSyncEditBlockedWorkflow`.
- `src/workflows/mark-order-sync-edit-blocked.ts` / `src/workflows/steps/mark-order-sync-edit-blocked.ts` — the write path.

---

## Task 1: Widen the GET route's response row type to include `edit_blocked_*` (scaffolding, exempt from TDD)

**Why exempt:** `route.ts`'s `GET` handler builds its response via `enriched: OngoingOrderSyncWithTracking[] = syncs.map((s) => ({ ...s, tracking: ... }))` (`route.ts:94-99`) — the `...s` spread already forwards every field the mocked/real service returns, whether or not that field is named in the `OngoingOrderSyncRow` TypeScript type. Since #91 already writes `edit_blocked_at`/`edit_blocked_category`/`edit_blocked_reason` onto the underlying `OngoingOrderSync` rows, `listOngoingOrderSyncs` (the module's auto-CRUD read) already returns them today, and the route already forwards them — **no runtime behavior changes in this task.** A red-then-green test is not possible here (there is no code change that could make a "the response includes these fields" test fail first). This task only widens the exported TypeScript type to document the contract and catch any future accidental narrowing; it is verified by the TypeScript compiler, with a regression test added to pin/document the pass-through contract (not to drive it).

**Files:**
- Modify: `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`
- Modify: `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts`

- [ ] **Step 1: Extend the test fixture and add a pass-through regression test**

Edit `src/api/admin/ongoing/orders/[orderId]/sync/__tests__/route.test.ts`. Extend `makeSyncRow`'s base object (currently lines 6-22) by adding 3 fields after `shipped_at`:

```ts
const makeSyncRow = (overrides: Record<string, unknown> = {}) => ({
  id: "osync_1",
  integration_id: "int_1",
  medusa_order_id: "order_1",
  medusa_fulfillment_id: "ful_1",
  ongoing_order_number: "1001-ful_1",
  ongoing_order_id: 555,
  latest_status_code: 320,
  latest_status_text: "Shipped",
  sync_state: "shipped",
  error_class: null,
  last_synced_at: "2026-07-01T00:00:00.000Z",
  last_error: null,
  retry_count: 0,
  shipped_at: "2026-07-01T00:00:00.000Z",
  edit_blocked_at: null,
  edit_blocked_category: null,
  edit_blocked_reason: null,
  ...overrides,
})
```

This flows automatically into all 6 existing test cases (they all build their expected response from `{ ...row, tracking: [...] }`, so both sides of every existing assertion gain the 3 new `null` fields symmetrically — no other existing test needs editing).

Append a new test case at the end of the `describe("GET /admin/ongoing/orders/:orderId/sync", ...)` block (after the existing `"dedupes fulfillment ids into a single batched query.graph call across multiple sync rows"` test, before the closing `})`):

```ts
  it("passes through edit_blocked_at/category/reason fields unchanged", async () => {
    const row = makeSyncRow({
      edit_blocked_at: "2026-07-02T10:00:00.000Z",
      edit_blocked_category: "line_items",
      edit_blocked_reason: "status_blocked",
    })
    const ongoingService = makeOngoingService([row])
    const query = makeQuery([])
    const res = makeRes()

    await GET(makeReq({ ongoingService, query }), res)

    expect(res.json).toHaveBeenCalledWith({
      syncs: [{ ...row, tracking: [] }],
    })
  })
```

- [ ] **Step 2: Widen the route's exported type**

Edit `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`. Current `OngoingOrderSyncRow` (lines 5-20):

```ts
export type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | Date | null
  last_error: string | null
  retry_count: number
  shipped_at: string | Date | null
}
```

Replace with:

```ts
export type OngoingOrderSyncRow = {
  id: string
  integration_id: string
  medusa_order_id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: "pending" | "sent" | "shipped" | "cancelled" | "error"
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | Date | null
  last_error: string | null
  retry_count: number
  shipped_at: string | Date | null
  edit_blocked_at: string | Date | null
  edit_blocked_category: "address_contact" | "line_items" | null
  edit_blocked_reason: string | null
}
```

No other line in `route.ts` changes — `GET`'s body (lines 50-102) is untouched; the `...s` spread at line 94-99 already forwards these fields at runtime.

- [ ] **Step 3: Run the test suite**

Run: `yarn test src/api/admin/ongoing/orders`
Expected: PASS — all 7 cases (the 6 pre-existing cases plus the new pass-through case), confirming the fixture extension didn't break any existing assertion and the new field pass-through is pinned.

- [ ] **Step 4: Type-check the server build**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors — confirms the widened `OngoingOrderSyncRow` type still satisfies every existing usage in `route.ts` (there are none outside this file that import it, per the research above, so this is a self-contained check).

---

## Task 2: Render the "Edit blocked" banner in the order widget (UI composition, exempt from TDD)

**Why exempt:** conditional JSX rendering driven by a boolean-ish check (`sync.edit_blocked_at` truthy) plus two small label lookups — the same complexity class as the pre-existing `STATE_BADGE_COLOR` map and the `RepushButton`'s `disabled`/`label` derivation, both of which #42's plan explicitly classified as UI composition exempt from TDD. This repo's `jest.config.js` has no `.tsx`/jsdom test runner (`testMatch: ["**/__tests__/**/*.test.ts"]`, `testEnvironment: "node"`), so a component-level red/green test is not feasible without adding new test infrastructure, which is out of scope for this issue. Verified instead by the real TypeScript compiler against `src/admin/tsconfig.json` (the widget's actual type-gate — `yarn build` transpiles but does not type-check `src/admin`) and `yarn build` as the packaging/bundle check.

**Files:**
- Modify: `src/admin/widgets/ongoing-order-sync.tsx`

- [ ] **Step 1: Widen the local row type**

Current `OngoingOrderSyncRow` type (lines 15-28):

```ts
type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: OngoingSyncState
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | null
  last_error: string | null
  retry_count: number
  tracking: OngoingOrderSyncTracking[]
}
```

Replace with:

```ts
type OngoingOrderSyncRow = {
  id: string
  medusa_fulfillment_id: string | null
  ongoing_order_number: string
  ongoing_order_id: number | null
  latest_status_code: number | null
  latest_status_text: string | null
  sync_state: OngoingSyncState
  error_class: "retryable" | "terminal" | null
  last_synced_at: string | null
  last_error: string | null
  retry_count: number
  edit_blocked_at: string | null
  edit_blocked_category: "address_contact" | "line_items" | null
  edit_blocked_reason: string | null
  tracking: OngoingOrderSyncTracking[]
}
```

(Kept local and duplicated from the route's type per #42's established convention — see Research above; do not import from `src/api/admin/ongoing/orders/[orderId]/sync/route.ts`.)

- [ ] **Step 2: Add the label maps**

Current `STATE_BADGE_COLOR` block (lines 34-43):

```ts
const STATE_BADGE_COLOR: Record<
  OngoingSyncState,
  "grey" | "blue" | "green" | "red" | "orange"
> = {
  pending: "grey",
  sent: "blue",
  shipped: "green",
  cancelled: "grey",
  error: "red",
}
```

Insert two new consts immediately after it (still before `const queryKeyFor = ...`):

```ts
const EDIT_BLOCKED_CATEGORY_LABEL: Record<"address_contact" | "line_items", string> = {
  address_contact: "Address / contact",
  line_items: "Line items",
}

const EDIT_BLOCKED_REASON_LABEL: Record<string, string> = {
  no_edit_rules: "No edit rules configured for the current status",
  status_unknown: "Order status is unknown",
  status_blocked: "Order status does not allow this edit",
  no_sync_row: "The Ongoing sync record no longer exists",
}
```

(The keys in `EDIT_BLOCKED_REASON_LABEL` are the machine strings the gate can persist as a blocked reason. `no_edit_rules` / `status_unknown` / `status_blocked` are the three common ones #91's subscribers persist; `no_sync_row` is additionally reachable at `order-updated.ts`'s post-workflow site (#94) in the race where the sync row is deleted between `listOngoingOrderSyncs` and the workflow's internal gate lookup — `sync-order-edit-to-ongoing.ts` returns `blocked` with that reason. `EDIT_BLOCKED_REASON_LABEL` is typed `Record<string, string>`, not keyed by a closed union, so any further unrecognized reason string still falls through to the raw-string fallback in Step 3 rather than a TypeScript error.)

- [ ] **Step 3: Insert the banner**

Current lines 130-134 (the "Last synced" line immediately followed by the tracking block):

```tsx
          <Text size="small" className="text-ui-fg-subtle">
            Last synced: {sync.last_synced_at ? new Date(sync.last_synced_at).toLocaleString() : "—"}
          </Text>

          {sync.tracking.length > 0 && (
```

Replace with (inserting the banner between the two, keeping the tracking block's opening line unchanged):

```tsx
          <Text size="small" className="text-ui-fg-subtle">
            Last synced: {sync.last_synced_at ? new Date(sync.last_synced_at).toLocaleString() : "—"}
          </Text>

          {sync.edit_blocked_at && (
            <div className="bg-ui-tag-orange-bg border-ui-tag-orange-border flex flex-col gap-y-1 rounded-md border px-3 py-2">
              <div className="flex items-center gap-x-2">
                <Badge color="orange" size="2xsmall">
                  Edit blocked
                </Badge>
                <Text size="small" leading="compact" weight="plus" className="text-ui-tag-orange-text">
                  {sync.edit_blocked_category
                    ? EDIT_BLOCKED_CATEGORY_LABEL[sync.edit_blocked_category]
                    : "Unknown edit type"}
                </Text>
              </div>
              <Text size="small" leading="compact" className="text-ui-tag-orange-text">
                {sync.edit_blocked_reason
                  ? (EDIT_BLOCKED_REASON_LABEL[sync.edit_blocked_reason] ?? sync.edit_blocked_reason)
                  : "Reason not recorded"}
              </Text>
            </div>
          )}

          {sync.tracking.length > 0 && (
```

Notes the implementer must honour:
- `sync.edit_blocked_at` is the gate (truthy iff #91's subscribers most recently wrote `blocked: true`); `edit_blocked_category`/`edit_blocked_reason` can independently be `null` per the defensive test case cited above, hence both have their own `null` fallback ("Unknown edit type" / "Reason not recorded") rather than assuming they're always populated together with `edit_blocked_at`.
- `EDIT_BLOCKED_REASON_LABEL[sync.edit_blocked_reason] ?? sync.edit_blocked_reason` falls back to the raw persisted string for any reason not in the 3-entry map (forward-compatible if #91's gate ever adds a new reason without this plan being updated in lockstep).
- No new `useQuery`/`useMutation` — this task renders fields already present in the existing `SyncResponse`/`useQuery` fetch (`ongoing-order-sync.tsx:85-88`), once Task 1 widens what `GET` puts in that JSON. No display/modal query-separation concern applies (no modal exists in this widget).
- `Badge`, `size="2xsmall"`, and the `bg-ui-tag-orange-*`/`text-ui-tag-orange-*`/`border-ui-tag-orange-*` classes are all verified against the installed `@medusajs/ui` package (see Research above), not invented.

- [ ] **Step 4: Type-check the widget**

Run: `node_modules/.bin/tsc -p src/admin/tsconfig.json --noEmit`
Expected: no errors — this is the real type-gate for `src/admin/**` (strict mode, `noUnusedLocals`/`noUnusedParameters: true`); a wrong `Badge`/`Text` prop or an unused import/local would fail here.

---

## Task 3: Final verification and commit

- [ ] **Step 1: Full unit test suite**

Run: `yarn test`
Expected: all suites pass, including the extended `route.test.ts` from Task 1.

- [ ] **Step 2: Lint**

Run: `yarn lint`
Expected: `medusa lint` reports no errors on the modified files.

- [ ] **Step 3: Type-check both compile targets**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors (repeats Task 1 Step 4 as a final confirmation against the full server tree).

Run: `node_modules/.bin/tsc -p src/admin/tsconfig.json --noEmit`
Expected: no errors (repeats Task 2 Step 4 as a final confirmation against the full admin tree).

- [ ] **Step 4: Build**

Run: `yarn build`
Expected: `medusa plugin:build` succeeds — `.medusa/server` includes the recompiled `sync` route and the rebundled widget.

- [ ] **Step 5: Commit**

```bash
git add src/api/admin/ongoing/orders src/admin/widgets/ongoing-order-sync.tsx
git commit -m "feat(ongoing-admin): surface edit-blocked state in order widget (#93)"
```

(`git add src/api/admin/ongoing/orders` is the directory form, not a literal `[orderId]` pathspec — git's pathspec matcher treats `[orderId]` as a glob character class, not a literal segment, so a literal path containing `[orderId]` must be staged via its containing directory. This matches `docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md`'s own `Task 4 Step 4` commit command for the same `[orderId]` route tree. The `repush/` subtree is untouched by this plan, but including it in the `git add` is harmless — no working-tree changes exist there to stage.)

---

## Self-Review (completed during planning)

- **Issue scope honoured literally:** exactly the two touch points named in the issue — the GET route row type (Task 1) and the widget JSX banner (Task 2) — no subscriber/model/migration changes (already shipped by #91), no `repush` route changes, no dashboard-page work.
- **Field names verified against the real, currently-committed model**, not assumed: `src/modules/ongoing/models/order-sync.ts:20-22` read directly — `edit_blocked_at`, `edit_blocked_category` (`"address_contact" | "line_items"`), `edit_blocked_reason` (free text, but constrained in practice to 3 machine strings by the subscribers per #91's plan).
- **TDD-exemption is justified concretely, not asserted:** Task 1 shows the exact line (`route.ts:94-99`, `...s` spread) proving no runtime behavior changes, so no red test is possible; Task 2 cites this repo's actual `jest.config.js` (`testMatch: **/__tests__/**/*.test.ts`, `testEnvironment: "node"`) proving no component-test runner exists, matching #42's own precedent rather than inventing a new one.
- **`npx tsc` avoided everywhere** in favor of `node_modules/.bin/tsc`, per the verified `npx-tsc-fake-success` finding — a deliberate, cited deviation from #42's own plan text (which predates this finding).
- **Defensive null-field edge case handled, not assumed away:** the banner has independent `null` fallbacks for `edit_blocked_category`/`edit_blocked_reason`, justified by #91 Task 1's own test 3 (`blocked: true` called without `category`/`reason` still sets `edit_blocked_at`).
- **Reason vocabulary is closed and verified, not guessed:** `EDIT_BLOCKED_REASON_LABEL`'s 3 keys (`no_edit_rules`, `status_unknown`, `status_blocked`) are exactly the 3 strings #91's two subscribers persist (cited with line ranges), with a raw-string fallback for forward-compatibility rather than a hard TypeScript union that would break on an unanticipated value.
- **Medusa admin skill patterns applied to new code, not retrofitted onto old code:** the new `Text` elements use `leading="compact"` per `typo-labels`/`typo-descriptions` even though this widget's pre-existing `Text` elements (written before this skill's rules were re-verified) omit it — that pre-existing inconsistency is left alone as out of scope.
- **Semantic colors only:** `bg-ui-tag-orange-bg` / `text-ui-tag-orange-text` / `border-ui-tag-orange-border` are copied verbatim from the installed `@medusajs/ui` `Badge` component's own `orange` variant (`node_modules/@medusajs/ui/dist/esm/components/badge/badge.js`), not invented or hardcoded hex/rgb values.
- **`building-with-medusa` skill checked for the route change and found inapplicable beyond what's already followed:** no new mutation, no PUT/PATCH, no `query.graph`/`query.index` change — Task 1 is a pure type widening on an existing, already-compliant `GET` route.
- **No forbidden tokens** — every code block above is complete (no `TODO`/`TBD`/`FIXME`/`<...>`/`XXX`); both "exempt from TDD" justifications are concrete, cited reasoning, not unresolved gaps.
- **Real test commands throughout**, matching this repo's existing `yarn test <path>` substring-match convention (verified against `docs/superpowers/plans/2026-07-01-order-widget-status-parcel-tracking-re-push-retry-42.md` and `2026-07-01-persist-edit-blocked-state-on-ongoingordersync-model-field-migration-subscriber-write-91.md`'s own invocations); full suite `yarn test`; gates `yarn lint`, `node_modules/.bin/tsc --noEmit -p tsconfig.json`, `node_modules/.bin/tsc -p src/admin/tsconfig.json --noEmit`, `yarn build`.

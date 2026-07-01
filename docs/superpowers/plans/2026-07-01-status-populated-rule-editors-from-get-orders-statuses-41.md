# Status-Populated Rule Editors (StatusCodePicker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Ongoing settings form (#40) two checkbox-group rule editors — for `shipped_status_codes` and `cancellable_status_codes` — populated from the live Ongoing order-status list that #40's "Test connection" action already fetches, per spec §10 ("editors populated from `GET /orders/statuses` via a Test connection action").

**Architecture:** A presentational `StatusCodePicker` component (`@medusajs/ui` `Checkbox` per status `{number, text}`) backed by a pure `toggleStatusCode` helper that does the add/remove-from-array logic. The picker is dumb: it takes the full status list, the currently-selected `number[]`, and an `onChange`, and knows nothing about where the statuses come from or how the form persists them. #40's Drawer form lives in **`src/admin/routes/settings/ongoing/integration-drawer.tsx`** (exported `IntegrationDrawer`) — **not** `page.tsx`, which only renders the integrations Table and mounts `<IntegrationDrawer>`. #40 owns fetching statuses (via its `POST /admin/ongoing/test-connection` action) and owns `IntegrationDrawer`'s `FormState`; this plan's only touch on that file is (a) changing the two status-code fields in `FormState` from CSV strings to `number[]` and (b) replacing their CSV `<Input>` fields with two `<StatusCodePicker>` instances bound to that state. `page.tsx` needs no changes from this plan.

**Tech Stack:** React 18.2, `@medusajs/ui` 4.1.16 (`Checkbox`, `Label`, `Text` — already a devDependency, do not add), TypeScript 5.6 strict via `src/admin/tsconfig.json` (`jsx: react-jsx`, `moduleResolution: bundler`), existing Jest + `@swc/jest` unit-test setup (`jest.config.js`, `yarn test`) for the pure-logic helper.

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0). Package manager **yarn 4.6.0**, Node **>= 20**.
- `@medusajs/ui` is already a `package.json` devDependency (4.1.16) — do not add packages. `@tanstack/react-query` and `@medusajs/js-sdk` are bundled/owned by #40 — do not add them here.
- `@medusajs/ui` 4.1.16 has no native multi-select component (open feature request, GH discussion #10455) — the rule editors are a `Checkbox`-per-status group, not a `Select`/`Combobox`.
- Wire format for both rule fields is a plain `number[]` (`src/modules/ongoing/models/integration.ts:14-16`: `shipped_status_codes`/`cancellable_status_codes` are `model.json().nullable()`; `src/jobs/status-poll.ts:103-106` reads them as `Array.isArray(integration.shipped_status_codes) ? integration.shipped_status_codes : []` then `.includes(order.statusNumber)`). The picker must emit/accept exactly `number[]`.
- `src/admin/tsconfig.json` is a separate TS project (`include: ["."]`, `jsx: "react-jsx"`, `moduleResolution: "bundler"`, `noEmit: true`) from the root `tsconfig.json` (which `exclude`s `src/admin` entirely). Vite/esbuild (`@medusajs/admin-bundler`, used by `medusa plugin:build`) transpiles TSX **without type-checking** — confirmed by inspecting `node_modules/@medusajs/admin-bundler/dist/index.js` (no `fork-ts-checker`/`vite-plugin-checker`/`typescript` reference). **`yarn build` alone is not a type gate for admin code.** The real type gate is `npx tsc -p src/admin/tsconfig.json --noEmit`; `yarn build` is only the packaging/bundle-succeeds check.
- Do not define the status-option type by importing from `src/lib/ongoing/types.ts` (server-side, root `tsconfig.json` project) into `src/admin` — keep the admin/server TS-project boundary clean. Define the shape locally in the new component file; it structurally matches `OngoingOrderStatus` (`src/lib/ongoing/types.ts:26-29`, `{ number: number; text: string }`) so #40's test-connection response drops straight into the prop.
- No placeholders, no `TBD`. Every code block below is complete and runnable as written.

---

## Ownership boundary — depends on #40, do NOT recreate

Issue #41 is **blocked-by #40** ("Settings page + Test-connection endpoint"). This plan builds strictly on top of #40's deliverables and must not create or duplicate them:

- `src/admin/lib/sdk.ts` (the `@medusajs/js-sdk` client instance) — **owned by #40**. This plan does not touch it.
- `package.json` `@medusajs/js-sdk` devDependency — **owned by #40**. Do not add.
- `src/admin/routes/settings/ongoing/page.tsx` (renders the integrations Table, mounts `<IntegrationDrawer>`) — **owned by #40, no changes from this plan.** It holds no form fields, so there is nothing here for #41 to wire into.
- `src/admin/routes/settings/ongoing/integration-drawer.tsx` (exported `IntegrationDrawer` — the Drawer form: `credential_key`, `stock_location_id`, intervals, `edit_sync_rules` Textarea, and the two status-code fields) — **owned by #40**. Task 3 below **modifies** this file (changes the two status-code fields' type in `FormState` and replaces their CSV `<Input>` fields with `<StatusCodePicker>`) but does not create it, and does not touch `credential_key`/`stock_location_id`/interval fields or the `edit_sync_rules` Textarea.

> **§10 scope decision (recorded).** Spec §10 lists three status-populated editors (`edit_sync_rules`, `shipped_status_codes`, `cancellable_status_codes`). This issue deliberately covers only the two flat `number[]` code lists. `edit_sync_rules` is a per-category `{ address_contact, line_items } → codes` structure, not a flat list, so it stays a raw-JSON `<Textarea>` (owned by #40) for v1 rather than a `StatusCodePicker`. Accepted as a documented deviation during the M5 /plan-milestone cross-plan review; a per-category picker, if wanted later, is separate work.
- `POST /admin/ongoing/test-connection` (returns `{ success: boolean; statuses: { number: number; text: string }[] }`) — **owned by #40**. This plan consumes that response shape as a prop; it does not add a new endpoint (no separate `GET /statuses` route).
- `ongoing.sync.*` events — **owned by #44**. Not touched here.

**Depends on (must already exist before Task 3 runs):**
- `src/admin/routes/settings/ongoing/integration-drawer.tsx` — created by #40. Its `FormState` interface currently models the two rule-editor fields as **CSV strings** bound to plain text `<Input>`s: `shipped_status_codes_csv: string` and `cancellable_status_codes_csv: string`. A `toFormState(integration)` function serializes the loaded `OngoingIntegration`'s `number[]` columns into these CSV strings for initial state, and `handleSubmit` calls a `parseCodesCsv(csv: string): number[]` helper to convert them back to `number[]` before sending the update request. A mutation/handler wired to `POST /admin/ongoing/test-connection` stores its success response in component state, accessible as `{ success: boolean; statuses: { number: number; text: string }[] }`.

Task 3 **changes this data flow**: it removes the two `_csv: string` fields from `FormState` in favor of live `shipped_status_codes: number[]` / `cancellable_status_codes: number[]`, so the CSV round-trip and the `parseCodesCsv` calls for these two fields are removed as part of this plan (see Task 3 for the exact edits). If, when Task 3 is executed, #40's actual local state-variable names (e.g. the `useState`/`useMutation` variable holding `FormState`, or the Test-connection mutation variable) differ from the assumed `formData`/`setFormData` and `testConnection` naming used below (the conventional Drawer-form pattern from `medusa-dev:building-admin-dashboard-customizations` → `references/forms.md`), adapt only those variable names to match the real file — the **`StatusCodePicker` prop contract (`statuses`, `selected`, `onChange`, `disabled`) and the **`FormState`** field names (`shipped_status_codes`, `cancellable_status_codes`) do not change**.

---

## File Structure

**Create:**
- `src/admin/routes/settings/ongoing/utils/toggle-status-code.ts` — pure `toggleStatusCode(selected, statusNumber, checked)` array helper (add/remove, kept sorted ascending).
- `src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts` — unit tests for the helper (runs under the existing root `jest.config.js`; no new test infra needed).
- `src/admin/routes/settings/ongoing/components/StatusCodePicker.tsx` — the `Checkbox`-group component: exports `StatusCodePickerOption`, `StatusCodePickerProps`, `StatusCodePicker`.

**Modify:**
- `src/admin/routes/settings/ongoing/integration-drawer.tsx` (created by #40) — change `FormState`'s two status-code fields from CSV strings to `number[]`, update `toFormState` and `handleSubmit` accordingly, and replace the two CSV `<Input>` fields with `<StatusCodePicker>` instances, one for `shipped_status_codes`, one for `cancellable_status_codes`. `page.tsx` is **not** modified by this plan.

**Depends on:** see "Ownership boundary" section above.

---

## Task 1: Pure `toggleStatusCode` helper (TDD)

The picker's only piece of non-trivial logic is "add this status number to the selected list if checked, remove it if unchecked, keep the list free of duplicates and stable-sorted." Isolate it as a plain function so it is unit-testable under the existing node-environment Jest config (no DOM, no React needed) — the component itself is a thin renderer around this function and is verified by the TypeScript build gate in Task 2 instead.

**Files:**
- Create: `src/admin/routes/settings/ongoing/utils/toggle-status-code.ts`
- Test: `src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts`

**Interfaces:**
- Produces: `toggleStatusCode(selected: number[], statusNumber: number, checked: boolean): number[]` — used by `StatusCodePicker` in Task 2.

- [ ] **Step 1: Write the failing test**

Create `src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts`:

```ts
import { toggleStatusCode } from "../toggle-status-code"

describe("toggleStatusCode", () => {
  it("adds a status number when checked and not already selected", () => {
    expect(toggleStatusCode([100, 200], 300, true)).toEqual([100, 200, 300])
  })

  it("keeps the result sorted ascending regardless of insertion order", () => {
    expect(toggleStatusCode([300, 100], 200, true)).toEqual([100, 200, 300])
  })

  it("is a no-op when checking a status number that is already selected", () => {
    expect(toggleStatusCode([100, 200], 100, true)).toEqual([100, 200])
  })

  it("removes a status number when unchecked", () => {
    expect(toggleStatusCode([100, 200, 300], 200, false)).toEqual([100, 300])
  })

  it("is a no-op when unchecking a status number that is not selected", () => {
    expect(toggleStatusCode([100, 200], 300, false)).toEqual([100, 200])
  })

  it("returns an empty array when the last selected code is unchecked", () => {
    expect(toggleStatusCode([100], 100, false)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts`
Expected: FAIL — `Cannot find module '../toggle-status-code'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/admin/routes/settings/ongoing/utils/toggle-status-code.ts`:

```ts
export function toggleStatusCode(
  selected: number[],
  statusNumber: number,
  checked: boolean
): number[] {
  if (checked) {
    if (selected.includes(statusNumber)) {
      return selected
    }
    return [...selected, statusNumber].sort((a, b) => a - b)
  }
  return selected.filter((code) => code !== statusNumber)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/settings/ongoing/utils/toggle-status-code.ts src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts
git commit -m "feat(ongoing-admin): add toggleStatusCode helper for rule-editor checkbox groups"
```

---

## Task 2: `StatusCodePicker` component

Build the `Checkbox`-per-status group. Empty-state note (deliberate, not accidental): statuses are fetched by #40's "Test connection" action on **button click, not page mount** (spec §10), so on a fresh page load `statuses` is `[]` even though `selected` may already contain saved codes (e.g. `shipped_status_codes: [400, 500]` loaded from the integration record). This is **data-safe** — no checkbox is rendered for an unknown code, so nothing in `selected` is dropped or overwritten; if the user saves without clicking "Test connection" first, the previously-saved codes are preserved untouched because the component never emits `onChange` for codes it doesn't render. The trade-off is pure visibility: until "Test connection" is run, the user sees an explanatory empty-state message instead of their saved selections. This is acceptable because #40 owns the "when do we fetch statuses" decision (spec §10 explicitly ties population to the Test-connection action, not mount); the picker only needs to not corrupt data before that fetch happens.

**Files:**
- Create: `src/admin/routes/settings/ongoing/components/StatusCodePicker.tsx`

**Interfaces:**
- Consumes: `toggleStatusCode` from `../utils/toggle-status-code` (Task 1).
- Produces (consumed by Task 3 and by #40's `integration-drawer.tsx`):
  - `export interface StatusCodePickerOption { number: number; text: string }`
  - `export interface StatusCodePickerProps { label: string; statuses: StatusCodePickerOption[]; selected: number[]; onChange: (next: number[]) => void; disabled?: boolean }`
  - `export const StatusCodePicker: (props: StatusCodePickerProps) => JSX.Element`

- [ ] **Step 1: Write the component**

Create `src/admin/routes/settings/ongoing/components/StatusCodePicker.tsx`:

```tsx
import { Checkbox, Label, Text } from "@medusajs/ui"
import { toggleStatusCode } from "../utils/toggle-status-code"

export interface StatusCodePickerOption {
  number: number
  text: string
}

export interface StatusCodePickerProps {
  label: string
  statuses: StatusCodePickerOption[]
  selected: number[]
  onChange: (next: number[]) => void
  disabled?: boolean
}

export const StatusCodePicker = ({
  label,
  statuses,
  selected,
  onChange,
  disabled,
}: StatusCodePickerProps) => {
  const handleToggle = (statusNumber: number, checked: boolean) => {
    onChange(toggleStatusCode(selected, statusNumber, checked))
  }

  return (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">
        {label}
      </Label>
      {statuses.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">
          Run &quot;Test connection&quot; to load statuses from Ongoing.
        </Text>
      ) : (
        <div className="flex flex-col gap-y-2">
          {statuses.map((status) => {
            const inputId = `${label}-status-${status.number}`
            return (
              <div key={status.number} className="flex items-center gap-x-2">
                <Checkbox
                  id={inputId}
                  checked={selected.includes(status.number)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    handleToggle(status.number, checked === true)
                  }
                />
                <Label htmlFor={inputId} size="small">
                  {status.number} — {status.text}
                </Label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

Note on `onCheckedChange`: `@medusajs/ui`'s `Checkbox` (`node_modules/@medusajs/ui/dist/esm/components/checkbox/checkbox.d.ts`) wraps Radix's `Checkbox` primitive; its `onCheckedChange` callback receives `CheckboxCheckedState = boolean | "indeterminate"` (`node_modules/@medusajs/ui/dist/esm/components/checkbox/types.d.ts`). The `checked === true` comparison above correctly treats `"indeterminate"` as unchecked (this component never sets `indeterminate`, so it only ever receives `true`/`false` in practice, but the comparison is defensive against the wider type).

- [ ] **Step 2: Type-check the component**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: `TypeScript compilation completed` with no errors reported for `StatusCodePicker.tsx` or `toggle-status-code.ts`.

(This is the real type gate for admin TSX — `medusa plugin:build`'s Vite/esbuild pipeline transpiles without type-checking, confirmed by inspecting `@medusajs/admin-bundler`'s bundled output for a type-checker plugin and finding none. `yarn build` in Task 3 verifies the bundle *builds*, not that it *type-checks*.)

- [ ] **Step 3: Commit**

```bash
git add src/admin/routes/settings/ongoing/components/StatusCodePicker.tsx
git commit -m "feat(ongoing-admin): add StatusCodePicker checkbox-group component"
```

---

## Task 3: Wire `StatusCodePicker` into #40's `integration-drawer.tsx`

`page.tsx` (per #40) only renders the integrations Table and mounts `<IntegrationDrawer>` — it has no form fields, so it needs **no changes** from this plan. The Drawer form itself lives in `src/admin/routes/settings/ongoing/integration-drawer.tsx` (exported `IntegrationDrawer`). Its `FormState` currently models the two rule-editor fields as CSV strings (`shipped_status_codes_csv: string`, `cancellable_status_codes_csv: string`) bound to plain `<Input>`s, converted to `number[]` only at submit via `parseCodesCsv`. This task replaces that CSV round-trip with live `number[]` state rendered through `StatusCodePicker`. Locate the existing code by content (search anchors), not line numbers, since the exact file was written by #40's own plan.

**Files:**
- Modify: `src/admin/routes/settings/ongoing/integration-drawer.tsx`

**Interfaces:**
- Consumes: `StatusCodePicker`, `StatusCodePickerOption` from `./components/StatusCodePicker` (Task 2).
- Consumes from #40: `IntegrationDrawer`'s `FormState` interface and its `useState`/`setFormData` pair (assumed named `formData`/`setFormData` per the `medusa-dev:building-admin-dashboard-customizations` forms pattern), the `toFormState(integration)` initializer, the `handleSubmit` function, and the Test-connection mutation/state holding the fetched statuses as `{ success: boolean; statuses: { number: number; text: string }[] }` (assumed accessible as `testConnection.data?.statuses`, e.g. from a `useMutation` named `testConnection`). **If #40's actual local variable names differ, substitute them; the `StatusCodePicker` prop contract (`statuses`, `selected`, `onChange`, `disabled`) and the `FormState` field names introduced below (`shipped_status_codes`, `cancellable_status_codes`) do not change.**

- [ ] **Step 1: Add the import**

At the top of `src/admin/routes/settings/ongoing/integration-drawer.tsx`, alongside the other local imports, add:

```tsx
import { StatusCodePicker } from "./components/StatusCodePicker"
```

- [ ] **Step 2: Change `FormState`'s two status-code fields from CSV strings to `number[]`**

Find the `FormState` interface (or type) declaration. Remove:

```ts
shipped_status_codes_csv: string
cancellable_status_codes_csv: string
```

and add in their place:

```ts
shipped_status_codes: number[]
cancellable_status_codes: number[]
```

- [ ] **Step 3: Update `toFormState` to populate the fields directly from the model**

Find the `toFormState(integration)` function (or equivalent initializer that maps a loaded `OngoingIntegration` record onto `FormState` for the Drawer's initial/reset state). Find the lines building the CSV strings, e.g.:

```ts
shipped_status_codes_csv: (integration.shipped_status_codes ?? []).join(","),
cancellable_status_codes_csv: (integration.cancellable_status_codes ?? []).join(","),
```

Replace them with a direct array copy (no CSV join), matching how `src/jobs/status-poll.ts:103-106` already guards this same JSON column:

```ts
shipped_status_codes: Array.isArray(integration.shipped_status_codes)
  ? integration.shipped_status_codes
  : [],
cancellable_status_codes: Array.isArray(integration.cancellable_status_codes)
  ? integration.cancellable_status_codes
  : [],
```

- [ ] **Step 4: Remove the `parseCodesCsv` calls for these two fields in `handleSubmit`**

Find the `handleSubmit` function. Find the lines converting the CSV strings back to `number[]` before sending the update request, e.g.:

```ts
shipped_status_codes: parseCodesCsv(formData.shipped_status_codes_csv),
cancellable_status_codes: parseCodesCsv(formData.cancellable_status_codes_csv),
```

Replace them with a direct pass-through, since `formData` now already holds `number[]`:

```ts
shipped_status_codes: formData.shipped_status_codes,
cancellable_status_codes: formData.cancellable_status_codes,
```

`parseCodesCsv` is untouched as a function — it is only removed from these two call sites. The `edit_sync_rules` JSON Textarea field has its own, separate JSON-parse logic in `handleSubmit` and is not touched by this task.

- [ ] **Step 5: Replace the two CSV `<Input>` fields with `<StatusCodePicker>`**

Find the two `<Input>` fields bound to `formData.shipped_status_codes_csv` / `formData.cancellable_status_codes_csv` in the Drawer body JSX (per spec §10 these sit alongside the `edit_sync_rules` editor, all "populated from `GET /orders/statuses` via a Test connection action" — the `edit_sync_rules` Textarea is the nearest stable anchor). Replace both `<Input>` fields with:

```tsx
<div className="flex flex-col gap-y-2">
  <StatusCodePicker
    label="Shipped status codes"
    statuses={testConnection.data?.statuses ?? []}
    selected={formData.shipped_status_codes}
    onChange={(next) =>
      setFormData({ ...formData, shipped_status_codes: next })
    }
    disabled={updateIntegration.isPending}
  />
</div>

<div className="flex flex-col gap-y-2">
  <StatusCodePicker
    label="Cancellable status codes"
    statuses={testConnection.data?.statuses ?? []}
    selected={formData.cancellable_status_codes}
    onChange={(next) =>
      setFormData({ ...formData, cancellable_status_codes: next })
    }
    disabled={updateIntegration.isPending}
  />
</div>
```

(`updateIntegration.isPending` follows the `medusa-dev:building-admin-dashboard-customizations` "always disable actions during mutations" rule — substitute #40's actual save-mutation variable name if different; the intent is: disable the checkboxes while a save is in flight, matching the rest of the form's fields.)

- [ ] **Step 6: Type-check the full admin project**

Run: `npx tsc -p src/admin/tsconfig.json --noEmit`
Expected: `TypeScript compilation completed` with no errors. This catches any mismatch between the assumed `formData`/`testConnection` shape and #40's real implementation — fix the substituted variable names (not the `FormState`/`StatusCodePicker` field or prop names) until this passes. `src/admin/tsconfig.json` has `noUnusedLocals: true`: if removing the two `parseCodesCsv` call sites (Step 4) leaves the `parseCodesCsv` function or its import completely unused elsewhere in `integration-drawer.tsx`, this step will report it — delete the now-dead function/import so the check passes. Do not remove or alter the `edit_sync_rules` field's own JSON-parse logic, which is independent of `parseCodesCsv`.

- [ ] **Step 7: Verify the plugin still builds**

Run: `yarn build`
Expected: exits 0, producing `.medusa/server` (including the bundled admin assets). This is the packaging check — it confirms module resolution and the bundle succeed, not that types are correct (that's Step 6).

- [ ] **Step 8: Commit**

```bash
git add src/admin/routes/settings/ongoing/integration-drawer.tsx
git commit -m "feat(ongoing-admin): wire StatusCodePicker into shipped/cancellable rule editors (#41)"
```

---

## Verification (full plan)

Run in order from the repo root:

1. `yarn test src/admin/routes/settings/ongoing/utils/__tests__/toggle-status-code.test.ts` — expect PASS (6 tests).
2. `npx tsc -p src/admin/tsconfig.json --noEmit` — expect `TypeScript compilation completed`, no errors. This is the primary gate for the two new/modified TSX-adjacent files (`StatusCodePicker.tsx`, `integration-drawer.tsx`), since `yarn build`'s Vite/esbuild pipeline does not type-check.
3. `yarn build` — expect exit 0 (packaging/bundle-succeeds check).

No jsdom/React-Testing-Library harness is configured in this repo (`jest.config.js` has `testEnvironment: "node"` and `testMatch: ["**/__tests__/**/*.test.ts"]` — `.tsx` files are not matched and there is no `jsdom` environment installed). A component-render test for `StatusCodePicker` is therefore not feasible without adding new test infrastructure (out of scope for this narrow plan); the pure `toggleStatusCode` unit test plus the `tsc --noEmit` type gate are the two available correctness checks.

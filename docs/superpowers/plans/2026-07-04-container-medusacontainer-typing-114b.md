# #114-b: Type `container: any` → `MedusaContainer` in workflow steps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `{ container }: { container: any }` with `{ container }: { container: MedusaContainer }` across all 18 workflow-step handler sites, so container.resolve calls are type-checked and renaming a module-service method breaks compilation everywhere it's used.

**Architecture:** Pure type-only rewrite. Import `MedusaContainer` from `@medusajs/framework/types` at each affected file. Replace the parameter type. Tighten the few remaining `container.resolve(ONGOING_MODULE) as any` sites to `as OngoingModuleService` in the same pass since the plan is already touching them.

**Tech Stack:** TypeScript, Medusa v2 `@medusajs/framework/types`.

## Global Constraints

- No runtime behavior change. This plan touches only type annotations and one narrowing of `as any` → `as OngoingModuleService`.
- Existing `container.resolve(ONGOING_MODULE) as OngoingModuleService` casts stay — they are the current idiomatic pattern in this codebase and cannot be avoided without generating types from `resolve`'s Awilix cradle.
- Test files under `src/**/__tests__/` that use `const container: any = createMedusaContainer()` are OUT OF SCOPE for this plan (they are internal test doubles, not module boundaries) and MUST NOT be modified.

## File Structure

**Modify (18 files, ~22 `container: any` sites — line numbers current as of 2026-07-04; re-grep before editing):**

- `src/workflows/steps/apply-order-shipment.ts:32`
- `src/workflows/steps/cancel-ongoing-order.ts:17`
- `src/workflows/steps/create-ongoing-integration-row.ts:25`, `:46`
- `src/workflows/steps/decide-ongoing-cancel.ts:40`
- `src/workflows/steps/delete-ongoing-integration.ts:10`
- `src/workflows/steps/fetch-ongoing-inventory.ts:9`
- `src/workflows/steps/load-sync-for-shipment.ts:24`
- `src/workflows/steps/mark-order-sync-cancelled.ts:9`
- `src/workflows/steps/mark-order-sync-edit-blocked.ts:14`
- `src/workflows/steps/mark-order-sync-shipped.ts:19`
- `src/workflows/steps/push-order-record-sync.ts:31`
- `src/workflows/steps/query-fulfillment-order.ts:25`
- `src/workflows/steps/reconcile-inventory-levels.ts:20`
- `src/workflows/steps/resolve-integration-context.ts:16`
- `src/workflows/steps/retry-ongoing-syncs.ts:25`
- `src/workflows/steps/update-ongoing-integration.ts:36`, `:73`

Additionally, in the same pass, tighten these `as any` residuals to `as OngoingModuleService`:

- `src/workflows/steps/mark-order-sync-edit-blocked.ts:16` — `container.resolve(ONGOING_MODULE) as any` → `as OngoingModuleService`
- `src/workflows/steps/mark-order-sync-shipped.ts:21` — same
- `src/workflows/steps/resolve-integration-context.ts:18` — `const service: any = container.resolve(ONGOING_MODULE)` → `const service = container.resolve(ONGOING_MODULE) as OngoingModuleService`

---

## Task 1: Replace `container: any` sitewide, plus targeted `as any` → `as OngoingModuleService` narrowing

**Files:** All 18 files listed in File Structure.

**Interfaces produced/consumed:** None runtime. Types only.

- [ ] **Step 1: Confirm current site list matches what this plan enumerates**

Run: `rg -n "container:\s*any" src/workflows/steps/ src/lib/ongoing/ src/providers/ 2>/dev/null`
Compare against the 18-file list above. If sites have shifted (added/removed/moved) since 2026-07-04, update the list before editing. Test files (`src/**/__tests__/`) are out of scope — filter them out.

Also confirm the three `as any` narrowing targets still exist:

```bash
rg -n "resolve\(ONGOING_MODULE\)\s+as\s+any" src/workflows/steps/
rg -n "const service:\s*any\s*=\s*container\.resolve" src/workflows/steps/
```

- [ ] **Step 2: Verify baseline is green before editing**

Run: `yarn lint && yarn build && yarn test`
Expected: 0 lint errors, build succeeds, all tests pass. If anything fails, stop and diagnose — you must have a clean baseline before mechanical rewrites so any breakage the plan introduces is attributable.

- [ ] **Step 3: For each file, add the import if missing and replace the annotation**

For every file in the list, apply the exact same shape. Example — `src/workflows/steps/apply-order-shipment.ts:32`:

Before:
```ts
// (existing imports)

// ...
{ container }: { container: any }
```

After:
```ts
import type { MedusaContainer } from "@medusajs/framework/types"
// (existing imports)

// ...
{ container }: { container: MedusaContainer }
```

The import placement: add `import type { MedusaContainer } from "@medusajs/framework/types"` immediately below the existing framework imports, or at the top of the imports section if none exist. If a file already imports something from `@medusajs/framework/types`, add `MedusaContainer` to that existing import instead of a duplicate line.

For files with two sites (`create-ongoing-integration-row.ts`, `update-ongoing-integration.ts`), replace both occurrences — the handler and its compensation.

- [ ] **Step 4: Apply the three `as any` → `as OngoingModuleService` narrowings**

In each of the three files:

`src/workflows/steps/mark-order-sync-edit-blocked.ts:16`:
```ts
// Before:
const ongoing = container.resolve(ONGOING_MODULE) as any
// After:
const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
```

`src/workflows/steps/mark-order-sync-shipped.ts:21`: same substitution.

`src/workflows/steps/resolve-integration-context.ts:18`:
```ts
// Before:
const service: any = container.resolve(ONGOING_MODULE)
// After:
const service = container.resolve(ONGOING_MODULE) as OngoingModuleService
```

If `OngoingModuleService` isn't already imported in the file, add:
```ts
import type OngoingModuleService from "../../modules/ongoing/service"
```
(Match the exact import path convention the rest of the file uses — some files use relative, some use path aliases; follow the file's existing pattern.)

- [ ] **Step 5: Verify no `container: any` remains in workflow-step SOURCE files**

Run: `rg -n "container:\s*any" src/workflows/steps/`
Expected: no matches. (Test files under `__tests__/` are out of scope, but `rg src/workflows/steps/` naturally excludes them because they live in subdirs.)

Run: `rg -n "container:\s*any" src/`
Expected: only test-file matches remain (matches the seven test files enumerated in the source review). If any non-test source file still matches, add it to the pass and re-run.

Also re-check the three narrowing targets are gone:

```bash
rg -n "resolve\(ONGOING_MODULE\)\s+as\s+any" src/workflows/steps/
rg -n "const service:\s*any\s*=\s*container\.resolve" src/workflows/steps/
```
Expected: no matches.

- [ ] **Step 6: Type-check strictly**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 errors. If a real type error surfaces (e.g., a step calls a container-resolved service method that doesn't exist on `OngoingModuleService`), STOP — that is a latent bug the type narrowing surfaced. Log it, open a bug issue with a repro, and either fix it inline (if trivial and in-scope) or revert the narrowing for THAT single file with a `// TODO(#<new-bug>): container narrowed to any pending fix` comment. Do not silently downgrade to `any` without a linked issue.

Rationale for using `tsc --noEmit` directly: per project memory, `npx tsc` fakes success in this sandbox; `node_modules/.bin/tsc` is the real type-check.

- [ ] **Step 7: Full test suite**

Run: `yarn test`
Expected: All tests pass. No runtime behavior changed, so any test failure indicates a genuine regression — do not proceed until green.

- [ ] **Step 8: Lint + build**

Run: `yarn lint && yarn build`
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add src/workflows/steps/
git commit -m "refactor(workflows): type container as MedusaContainer in step handlers (#114-b)

Replaces 22 sites of { container }: { container: any } with the
framework-exported MedusaContainer type. Also narrows three
container.resolve(ONGOING_MODULE) as any residuals to as
OngoingModuleService. Type-only; no runtime change."
```

---

## Self-Review

- **Spec coverage** (`docs/superpowers/specs/2026-07-04-tighten-any-type-holes-at-module-boundaries-114-design.md`, sub-issue #114-b): "Replace `container: any` with `MedusaContainer` imported from `@medusajs/framework/types`" — Task 1 Step 3. "Tighten `container.resolve(ONGOING_MODULE) as any` residuals to `as OngoingModuleService`" — Task 1 Step 4. All covered.
- **Placeholders:** None. Every step names an exact command or an exact file+substitution.
- **Type consistency:** `MedusaContainer` imported as a type-only import (no runtime cost). `OngoingModuleService` import path deferred to "match the file's existing pattern" — that is not a placeholder because Task 1 Step 4 explicitly instructs the implementer to check the existing imports and match; the correct exact path in this repo is stable but varies by file (relative depth).
- **Scope:** Test-file container:any sites are explicitly out of scope per Global Constraints. That's a deliberate boundary: the test-double `any` at `const container: any = createMedusaContainer()` is a different concern (test ergonomics) and would be its own follow-up if worth fixing.

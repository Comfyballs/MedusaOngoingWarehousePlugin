# #114-c: Type EVENT_BUS resolves as `IEventBusModuleService` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every `container.resolve(Modules.EVENT_BUS) as any` / `: any = container.resolve(Modules.EVENT_BUS)` / `(container as any).resolve(Modules.EVENT_BUS)` with a typed resolve, so `eventBus.emit(...)` payload shape and method name are type-checked.

**Architecture:** Pure type-only rewrite. Import `IEventBusModuleService` from `@medusajs/types` at each affected file. Replace the `any` cast with `container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)` (or the equivalent `as IEventBusModuleService` for the sites that use the cast form).

**Tech Stack:** TypeScript, Medusa v2 `@medusajs/types`.

## Global Constraints

- No runtime behavior change. Only type annotations move.
- `.emit(...)` call sites MUST NOT be reshaped. If a call site's payload doesn't match `IEventBusModuleService`'s `.emit` signature, STOP and treat it as a latent bug (see Task 1 Step 5).

## File Structure

**Modify (7 files, current site line numbers as of 2026-07-04 — re-grep before editing):**

- `src/jobs/retry-failed-syncs.ts:66` — `const eventBus = (container as any).resolve(Modules.EVENT_BUS)`
- `src/jobs/stock-sync.ts:100` — `const eventBus: any = container.resolve(Modules.EVENT_BUS)`
- `src/subscribers/order-canceled.ts:35` — `const eventBus = container.resolve(Modules.EVENT_BUS) as any`
- `src/subscribers/order-edit-confirmed.ts:76` — `const eventBus = container.resolve(Modules.EVENT_BUS)` (already untyped-clean but not narrowed; add generic to lock the type)
- `src/subscribers/order-updated.ts:113` — same as above
- `src/workflows/steps/mark-order-sync-shipped.ts:23` — `const eventBus: any = container.resolve(Modules.EVENT_BUS)`
- `src/workflows/steps/push-order-record-sync.ts:35` — same

**Do not modify:**
- `src/jobs/__tests__/retry-failed-syncs.test.ts:11` — test double using `EVENT_BUS: "event_bus"` (test-registration string, not a runtime resolve site).
- `src/providers/ongoing-fulfillment/__tests__/push-order-to-ongoing.test.ts:58` — comment only, no code.

---

## Task 1: Type every EVENT_BUS resolve with `IEventBusModuleService`

**Files:** All 7 source files listed above.

**Interfaces produced/consumed:** None runtime. Types only.

- [ ] **Step 1: Confirm the site list is still current**

Run: `rg -n "EVENT_BUS" src/ | grep -vE "(__tests__|test\.ts$|// )"`
Compare against the 7-file list above. If sites have shifted or moved, update the list before editing.

- [ ] **Step 2: Verify clean baseline**

Run: `yarn lint && yarn build && yarn test`
Expected: 0 errors, all tests pass.

- [ ] **Step 3: Rewrite each of the 7 sites**

The canonical replacement per site:

For **cast form** (`... as any` / `: any =`):
```ts
// Before:
const eventBus = container.resolve(Modules.EVENT_BUS) as any
// After:
const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
```

Or equivalently, if the file already uses the type-annotation form:
```ts
// Before:
const eventBus: any = container.resolve(Modules.EVENT_BUS)
// After:
const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
```

For the **`(container as any).resolve` form** at `src/jobs/retry-failed-syncs.ts:66`:
```ts
// Before:
const eventBus = (container as any).resolve(Modules.EVENT_BUS)
// After:
const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
```
If this site's `(container as any)` cast was covering a `container: any` param already fixed by #114-b, the cast is now redundant. If #114-b hasn't merged yet, keep the outer cast around the parameter narrowing:
```ts
const eventBus = (container as MedusaContainer).resolve<IEventBusModuleService>(Modules.EVENT_BUS)
```
— but re-check after rebase: if #114-b merged first, drop the parameter cast.

For **already-untyped-but-not-narrowed sites** at `src/subscribers/order-edit-confirmed.ts:76` and `src/subscribers/order-updated.ts:113`:
```ts
// Before:
const eventBus = container.resolve(Modules.EVENT_BUS)
// After:
const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
```

Add the import in every file. If `@medusajs/types` is already imported, add `IEventBusModuleService` to the existing import list; else add a new type-only import:

```ts
import type { IEventBusModuleService } from "@medusajs/types"
```

Place immediately below the existing framework imports at the top of the file.

- [ ] **Step 4: Verify no more `as any` on EVENT_BUS resolves anywhere in source**

Run: `rg -n "EVENT_BUS" src/ | grep -vE "(__tests__|test\.ts$|// )" | grep -E "(as any|:\s*any)"`
Expected: no matches.

- [ ] **Step 5: Type-check strictly and audit emit call sites**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

If an `eventBus.emit(...)` call site now surfaces a type error, DO NOT re-cast to `any`. Instead:
1. Read the `IEventBusModuleService.emit` signature in `node_modules/@medusajs/types/dist/event-bus/event-bus-module.d.ts`.
2. Reshape the call site's payload to match. This is a real latent bug the plan is closing.
3. If reshaping is non-trivial (>5 lines) or changes runtime behavior, STOP — open a follow-up bug issue, revert that ONE call site to `any` with a `// TODO(#<new-bug>): eventBus.emit shape mismatch pending fix` comment linking the issue, and continue with the other sites. Do not silently drop the narrowing.

- [ ] **Step 6: Full test suite + lint + build**

Run: `yarn test && yarn lint && yarn build`
Expected: All tests pass, 0 lint errors, build succeeds. Any test failure indicates the type narrowing changed runtime behavior (e.g., a mock was returning something incompatible with `IEventBusModuleService`) — fix the mock, don't undo the narrowing.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/ src/subscribers/ src/workflows/steps/
git commit -m "refactor: type EVENT_BUS resolves as IEventBusModuleService (#114-c)

Replaces 7 sites of container.resolve(Modules.EVENT_BUS) as any (and
equivalents) with container.resolve<IEventBusModuleService>(...).
Type-only; no runtime change. emit() call sites now type-checked."
```

---

## Self-Review

- **Spec coverage** (design doc, sub-issue #114-c): "Type `resolve(Modules.EVENT_BUS)` as `IEventBusModuleService` from `@medusajs/types`" — Task 1 Step 3. "No runtime change; type-only" — Task 1 Step 6 verifies via green tests. Covered.
- **Placeholders:** None. Every step is a concrete command or a concrete file-and-substitution instruction.
- **Type consistency:** `IEventBusModuleService` used everywhere; import path `@medusajs/types` matches the framework-exported type.
- **Interaction with #114-b:** `src/jobs/retry-failed-syncs.ts:66` uses `(container as any).resolve` — this site depends on whether #114-b already tightened `container: any`. Task 1 Step 3 documents both possibilities and the branching rule.

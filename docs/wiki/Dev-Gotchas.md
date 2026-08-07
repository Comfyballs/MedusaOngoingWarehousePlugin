This page collects the non-obvious traps in this repo's toolchain and packaging — the things that waste an afternoon if you hit them cold. Read it before your first build. For the review rules, see [[Dev Medusa Rules]]; for the commands themselves, see [[Dev Contributing]].

## Node 26 breaks lint and build

Node 26 removed `SlowBuffer`. A transitive dependency (`buffer-equal-constant-time`, pulled in via `jwa` for JWT/webhook-auth) uses it, so `yarn lint` and `yarn build` crash under Node 26. Run those commands under **Node 20 or 22** (via `nvm use 22`).

The repo works around this in two places, but the fix is not total:

- `package.json` `resolutions` patches `buffer-equal-constant-time@1.0.1` with `.yarn/patches/buffer-equal-constant-time-npm-1.0.1-41826f3419.patch`.
- Both jest configs remap the module to `__mocks__/buffer-equal-constant-time.js`, a shim that reimplements the API without `SlowBuffer`. It is wired via `moduleNameMapper` in each config, not auto-discovered — it sits outside `src/`, so Jest's automatic `__mocks__` resolution does not apply and it must stay in **both** configs.

> **Caution**
> The mock and yarn patch cover the test path; the yarn patch may also cover build and lint, but that was not re-verified live. Keep running lint and build under Node 20/22 rather than relying on the patch.

The same applies to a **consuming app** you link this plugin into: a dev server started under Node 26 can boot and still fail to bundle the plugin's admin extensions, which reads as "my admin change did not arrive". Check the Node version of the process serving the port you are browsing, not just the one in your shell — see [[Dev Local App Testing]].

## `npx tsc` reports fake success in this sandbox

`npx tsc` can exit 0 without actually type-checking here. Use the local binary for a real type-check, especially for `src/admin`:

```bash
node_modules/.bin/tsc --noEmit
```

## `plugin:db:generate` needs a live database

`npx medusa plugin:db:generate` (run from this plugin directory after changing a `src/modules/*` model) does not work against nothing. It needs:

- a running Postgres instance,
- `DB_*` environment variables pointing at it, and
- a `medusa-<module>` database (here, `medusa-ongoing`).

The consuming app applies the generated migrations with `npx medusa db:migrate`. Three real migrations already exist under `src/modules/ongoing/migrations/`, so this recipe has been exercised repeatedly — see [[Dev Architecture]] for what each migration adds.

## RTK truncates git diff output

If you use the RTK proxy, `git diff` and `gh pr diff` are silently compacted, which can hide changes. Get the full diff with:

```bash
rtk git diff --no-compact
```

Or read the changed files directly.

## Packaging: `.medusa/server` is what ships

`package.json` `files: [".medusa/server"]` — the **build output**, not `src/`, is published. A consuming app imports parts of the plugin through the `exports` map, which points at the compiled output:

```
./workflows      -> .medusa/server/src/workflows/index.js
./modules/*      -> .medusa/server/src/modules/*/index.js
./providers/*    -> .medusa/server/src/providers/*/index.js
./admin          -> .medusa/server/src/admin/index.{mjs,js}
./*              -> .medusa/server/src/*.js
```

The fulfillment provider is imported via `./providers/*`. There is also a redundant `./.medusa/server/src/modules/*` entry alongside `./modules/*` — harmless, but do not be surprised by it. If an import from a consuming app fails, check that you built (`yarn build`) and that the path matches an `exports` key.

## `yarn pack` silently produces an empty package

`.gitignore` ignores `.medusa`, and yarn 4 applies `.gitignore` **on top of** the `files` allowlist. So `yarn pack` — and therefore `yarn npm publish` — emits a tarball containing only `package.json` and `README.md`, with the entire build output missing. The command succeeds; nothing warns you.

`npm` does not consult `.gitignore` when `files` is present, so publish through npm and verify the contents first:

```bash
npm pack --dry-run
```

The listing must show the `.medusa/server/**` tree. The same root cause breaks installing this plugin as a git dependency: the build output is not committed, and the build hook is `prepublishOnly`, which npm does not run on git installs. `npx medusa plugin:publish` (yalc) is unaffected — it honors the `files` allowlist and copies the build output correctly, which is why the local flow in [[Dev Local App Testing]] works with no publish at all.

## tsconfig: Node16 resolution, decorators, admin excluded

The root `tsconfig.json` targets ES2021 with `module`/`moduleResolution: "Node16"` and `experimentalDecorators` plus `emitDecoratorMetadata` on — Medusa's DI and model decorators need this. It **excludes `src/admin`** from the server build: the admin UI is bundled separately by the Medusa admin (Vite) pipeline and has its own `src/admin/tsconfig.json` (`moduleResolution: "bundler"`, `noEmit`, strict). So a server-build type error and an admin type error surface through different configs.

## Migrations workflow when a model changes

Changing a data model under `src/modules/ongoing/models/` means the DB schema drifts from the code until you regenerate migrations:

```bash
# From this plugin directory:
npx medusa plugin:db:generate
```

Commit the generated migration and the updated `.snapshot-medusa-ongoing.json`. The consuming app runs `npx medusa db:migrate`. See the database prerequisites above.

**Never hand-author a migration timestamp.** Medusa records every module's migrations in one `mikro_orm_migrations` table shared by the whole consuming app, keyed by the bare migration name — there's no per-module namespace. A hand-picked round timestamp (`HH0000`/`HH3000`) is exactly the kind another module is likely to have already used; MikroORM treats a name match as "already run" and **silently skips** the migration, with no error until a later write hits the missing column (`MedusaOngoingWarehousePlugin-cb3`). Always generate names with `npx medusa plugin:db:generate`, which stamps the real clock at second precision. [`src/modules/ongoing/__tests__/migration-names.test.ts`](https://github.com/Comfyballs/MedusaOngoingWarehousePlugin/blob/main/src/modules/ongoing/__tests__/migration-names.test.ts) enforces this — it fails the build on a round timestamp, a duplicate name, or a class/filename mismatch.

## Ongoing rate limits and parallel requests

Ongoing rate-limits concurrent calls and recommends serializing requests per goods owner. The client's `Throttle` defaults to concurrency **1**, and `getClient` caches one client (one throttle) per credential key so all process-wide calls to one goods owner are serialized. When writing batch syncs, do not fan out parallel calls to the same warehouse — let the throttle serialize them. See the Ongoing [parallel-requests](https://developer.ongoingwarehouse.com/parallel-requests) note and [[Dev Architecture]].

## A retryable row with no fulfilment id is dead-lettered immediately

In `retry-failed-syncs.ts`, an `error/retryable` row whose `medusa_fulfillment_id` is null cannot be re-pushed (the push workflow requires a fulfillment id), so the job dead-letters it on first sight: `error_class` flips to `terminal` via the same CAS guard as the normal path, `retry_count` is left unchanged (no attempt is spent), a warning is logged, and `ongoing.sync.order_dead_lettered` is emitted with `medusa_fulfillment_id: null`. No production code path writes a null fulfillment id — such rows only arise from historical data or manual DB edits. (Before bead `dpa` was fixed, these rows were warned-and-skipped every tick forever with no escape path.)

## A variant SKU rename silently orphans inbound stock sync

Medusa copies a variant's SKU onto its linked inventory item exactly **once**, at
variant-creation time (`@medusajs/core-flows` `create-product-variants.js`:
`sku: variantInput.sku`). `update-product-variants.js` never propagates a later SKU
edit to the inventory item — it only reacts to `manage_inventory` toggling. So renaming
a variant's SKU in the admin leaves the variant and its inventory item permanently
disagreeing about the SKU.

That divergence splits this plugin's two Ongoing-facing paths, because they each read
the SKU from a different entity:

- **Outbound** (`resolveArticleNumber`, `src/lib/ongoing/resolve-article-number.ts`)
  reads `product_variant.sku` — pushes the **new** SKU to Ongoing as `articleNumber`.
- **Inbound** (`reconcileInventoryLevelsStep`,
  `src/workflows/steps/reconcile-inventory-levels.ts`) matches Ongoing rows via
  `listInventoryItems({ sku })` — still the **old** inventory-item SKU.

The renamed article's stock permanently stops syncing: the Ongoing row matches 0
Medusa inventory items every tick, forever, until the inventory item's SKU is fixed.
`reconcileInventoryLevelsStep` detects this case (bead
`MedusaOngoingWarehousePlugin-bkh`): on the unmatched path only, it does one batched
`product_variant` lookup by the still-unmatched SKUs and logs a specific "rename
orphan" warning (naming the SKU, and explaining Medusa's lack of propagation) instead
of the generic "matched 0 inventory items" warning, whenever a variant with that SKU
does exist. There is no automatic repair — an operator has to correct the inventory
item's SKU (or the module's stock-sync outcome must be read from logs; a dashboard
surface for this is tracked separately, bead `MedusaOngoingWarehousePlugin-hhw.3`).

## graphify graph is stale

`graphify-out/GRAPH_REPORT.md` was generated on 2026-06-23 from the pre-integration scaffold (6 nodes) and does not reflect the current codebase. `CLAUDE.md` still tells agents to consult it and to run `graphify update .` after code changes. Until someone regenerates it (bead `de5`), do not trust the graph for architecture questions — use [[Dev Architecture]]. If you modify code in a session, running `graphify update .` keeps the graph current (AST-only, no API cost) per the repo rule.

## Related pages

- [[Dev Contributing]]
- [[Dev Testing]]
- [[Dev Architecture]]
- [[Dev Medusa Rules]]

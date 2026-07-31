This page collects the non-obvious traps in this repo's toolchain and packaging — the things that waste an afternoon if you hit them cold. Read it before your first build. For the review rules, see [[Dev Medusa Rules]]; for the commands themselves, see [[Dev Contributing]].

## Node 26 breaks lint and build

Node 26 removed `SlowBuffer`. A transitive dependency (`buffer-equal-constant-time`, pulled in via `jwa` for JWT/webhook-auth) uses it, so `yarn lint` and `yarn build` crash under Node 26. Run those commands under **Node 20 or 22** (via `nvm use 22`).

The repo works around this in two places, but the fix is not total:

- `package.json` `resolutions` patches `buffer-equal-constant-time@1.0.1` with `.yarn/patches/buffer-equal-constant-time-npm-1.0.1-41826f3419.patch`.
- Both jest configs remap the module to `__mocks__/buffer-equal-constant-time.js`, a shim that reimplements the API without `SlowBuffer`. It is wired via `moduleNameMapper` in each config, not auto-discovered — it sits outside `src/`, so Jest's automatic `__mocks__` resolution does not apply and it must stay in **both** configs.

> **Caution**
> The mock and yarn patch cover the test path; the yarn patch may also cover build and lint, but that was not re-verified live. Keep running lint and build under Node 20/22 rather than relying on the patch.

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

## Ongoing rate limits and parallel requests

Ongoing rate-limits concurrent calls and recommends serializing requests per goods owner. The client's `Throttle` defaults to concurrency **1**, and `getClient` caches one client (one throttle) per credential key so all process-wide calls to one goods owner are serialized. When writing batch syncs, do not fan out parallel calls to the same warehouse — let the throttle serialize them. See the Ongoing [parallel-requests](https://developer.ongoingwarehouse.com/parallel-requests) note and [[Dev Architecture]].

## A retryable row with no fulfilment id is dead-lettered immediately

In `retry-failed-syncs.ts`, an `error/retryable` row whose `medusa_fulfillment_id` is null cannot be re-pushed (the push workflow requires a fulfillment id), so the job dead-letters it on first sight: `error_class` flips to `terminal` via the same CAS guard as the normal path, `retry_count` is left unchanged (no attempt is spent), a warning is logged, and `ongoing.sync.order_dead_lettered` is emitted with `medusa_fulfillment_id: null`. No production code path writes a null fulfillment id — such rows only arise from historical data or manual DB edits. (Before bead `dpa` was fixed, these rows were warned-and-skipped every tick forever with no escape path.)

## graphify graph is stale

`graphify-out/GRAPH_REPORT.md` was generated on 2026-06-23 from the pre-integration scaffold (6 nodes) and does not reflect the current codebase. `CLAUDE.md` still tells agents to consult it and to run `graphify update .` after code changes. Until someone regenerates it (bead `de5`), do not trust the graph for architecture questions — use [[Dev Architecture]]. If you modify code in a session, running `graphify update .` keeps the graph current (AST-only, no API cost) per the repo rule.

## Related pages

- [[Dev Contributing]]
- [[Dev Testing]]
- [[Dev Architecture]]
- [[Dev Medusa Rules]]

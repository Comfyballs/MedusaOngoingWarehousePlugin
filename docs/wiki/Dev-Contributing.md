This page tells you how to set up a development environment, run the quality gates, and get a change merged. It covers the toolchain, the day-to-day commands, branch and commit conventions, the required Medusa-aware review, and how work is tracked. For the runtime design, see [[Dev Architecture]]; for the traps that will bite you, read [[Dev Gotchas]] before your first build. To see a change running inside a real Medusa app rather than a jest config, see [[Dev Local App Testing]].

## Development environment

You need:

- **Node 20, 22, or 24** via a version manager such as `nvm`. Node **>= 20** is required (`engines.node`), but **Node 26 breaks `yarn lint` and `yarn build`** — it removed `SlowBuffer`. See [[Dev Gotchas]] for the full story and the shim. Pin a working version:
  ```bash
  nvm install 24 && nvm use 24
  ```
- **Yarn 4.6.0** — the repo declares `packageManager: "yarn@4.6.0"`, so Corepack will select it automatically. Enable Corepack if you have not:
  ```bash
  corepack enable
  ```

Install dependencies:

```bash
yarn install
```

## Commands

| Command | What it runs | When |
|---|---|---|
| `yarn build` | `medusa plugin:build`, then stamps `.medusa/server` with a build id (UTC timestamp + short git sha + dirty flag) — see [[Dev Local App Testing]] | Before merge; to reproduce the shipped output |
| `yarn dev` | `medusa plugin:develop` — watch mode, publishes locally via yalc to a linked Medusa app | Iterating against a consuming app |
| `yarn push:local` | `scripts/push-to-local-app.mjs` — builds, publishes, and pushes into every (or one named) yalc-linked local app, and verifies the update actually landed | Updating an already-linked app; see [[Dev Local App Testing]] |
| `yarn lint` | `medusa lint` (ESLint flat config, `@medusajs/eslint-plugin` recommended) | Before every commit |
| `yarn test` | `jest` — the unit suite (excludes `*.live.test.ts`) | Before every commit |
| `yarn test:live` | `jest --config jest.integration.config.js` — the live Ongoing API harness | When you touch the Ongoing client; needs sandbox creds |

The stamped build id is logged at boot next to `[ongoing] validated N warehouse integration(s)`, so a bug report can quote exactly which build a linked app is running.

When you change a `src/modules/*` data model, regenerate migrations from this plugin directory:

```bash
npx medusa plugin:db:generate
```

The consuming app applies them with `npx medusa db:migrate`. This command needs a live Postgres and `DB_*` env vars — see [[Dev Gotchas]]. Testing is covered in depth on [[Dev Testing]].

## Branch naming

Use `<type>/<slug>`, where `<type>` mirrors the conventional-commit type and the slug is a short descriptive kebab-case phrase:

```
feat/ongoing-delta-inventory-sync
fix/ongoing-client-openapi-conformance
test/ongoing-live-integration-harness
chore/remove-completed-superpowers-plans
```

A slug may embed a bead or epic fragment when it helps (for example `chore/va3.1-lint-warnings`, a child of epic `va3`).

## Commit messages

Use **Conventional Commits** with a scope. The scopes in use are `ongoing`, `ongoing-admin`, and `beads`:

```
fix(ongoing): route OngoingClient through node http/https, not global fetch
feat(ongoing-admin): shared query hook for uniform loading/error/empty states
chore(beads): close 9sp (Layer 1 harness delivered)
```

Reference the **bead ID**, not a GitHub issue number. GitHub Issues is retired (all open issues were closed on 2026-07-05 with a "moved to beads" comment). Put the bead reference in the body or in a trailing parenthetical, for example `(bead sw8)` or the full id `MedusaOngoingWarehousePlugin-1783216052060-66-b0ad5eb4`. Do **not** write `Closes #N`.

> **Note**
> The repo's `.github/pull_request_template.md` still prints `Closes #`. That is stale — replace it with the bead reference when you open a PR.

Work tracking lives in `bd` (beads). Create the bead **before** you write code. See [[Dev Beads]].

## Pull request flow

1. Create (or claim) a bead for the work: `bd update <id> --claim`.
2. Branch off `main` with a `<type>/<slug>` name.
3. Make the change. If it alters plugin options, a public extension-point shape (provider methods, module models, route paths), or install/build commands, **update the relevant wiki page in the same PR** — see [[Dev Documentation Maintenance]].
4. Run the local quality gates: `yarn lint`, `yarn build`, `yarn test` (and `yarn test:live` for Ongoing-client changes).
5. Open the PR. Reference the bead ID in the description.
6. Get the required Medusa-aware review (below).
7. Merge only after the review is clean or its findings are addressed.

`.github/workflows/ci.yml` runs `yarn lint`, `yarn build`, and `yarn test` (the L1 unit suite) automatically on every PR into `main` and on push to `main`, pinned to **Node 22** via Corepack/yarn 4.6.0. It does **not** run `yarn test:integration` or `yarn test:live` — those need a real Postgres / live Ongoing sandbox CI doesn't have — so a green CI run is not a substitute for running those locally when they apply. CI is in addition to, not instead of, the required review below.

## Required review before merge

Before merging **any** PR, a Medusa-aware code review must happen first. The reviewer must have loaded the **`medusa-dev:building-with-medusa`** skill; for PRs touching `src/admin/**`, also **`medusa-dev:building-admin-dashboard-customizations`**. A generic review misses Medusa-specific defects — mutations not wrapped in workflows, PUT/PATCH routes, broken module isolation, wrong `query.graph` vs `query.index` usage, non-`async` service methods, `MedusaError` vs generic `Error`, price format, and workflow-composition rules. Those rules are spelled out on [[Dev Medusa Rules]].

The reviewer runs `yarn lint`, `yarn build`, and the test suite, and confirms the diff against the skill's rule categories. This is in addition to the generic `superpowers:requesting-code-review` skill.

`docs/audits/2026-07-15-s1k-wms-integration-audit.md` is a worked example of this review applied to the whole plugin — use it as a template for scope and rigour, but treat its specific findings as historical (several were fixed after it was written).

## Related pages

- [[Dev Architecture]]
- [[Dev Testing]]
- [[Dev Local App Testing]]
- [[Dev Gotchas]]
- [[Dev Beads]]
- [[Dev Medusa Rules]]
- [[Dev Documentation Maintenance]]

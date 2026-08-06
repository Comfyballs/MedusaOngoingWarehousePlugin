This page explains the plugin's three automated test suites — the fast unit suite, the Postgres-backed Medusa integration suite, and the live Ongoing API harness — how to run each, the environment they need, and how to write tests that match the existing conventions. For the toolchain around them, see [[Dev Contributing]]; for the Node-version and shim traps, see [[Dev Gotchas]]. To exercise the plugin by hand inside a real consuming app, see [[Dev Local App Testing]].

## Three suites

The plugin follows a three-layer strategy: fast unit tests (mock everything), Medusa integration tests (real Postgres, Ongoing stubbed), and live contract tests (real Ongoing sandbox). Each suite has its own jest config so the slow/external ones never run in the default suite.

| Command | Config | Layer | What it runs |
|---|---|---|---|
| `yarn test` | `jest.config.js` | L1 unit | Every `**/__tests__/**/*.test.ts` under `src/`, **excluding** `*.live.test.ts`. No external services. |
| `yarn test:integration` | `jest.config.integration.js` | L2 Medusa | `integration-tests/**/*.spec.ts` — boots the `ongoing` module, and a full in-process app, against a **real Postgres**; Ongoing never contacted. |
| `yarn test:live` | `jest.integration.config.js` | L3 live | `**/__tests__/**/*.live.test.ts`, against the **real** Ongoing API. |

Manual testing in an installed app sits outside this table — it needs a consuming Medusa app rather than a jest config, and it is the only way to cover packaging resolution, admin bundling, and the operator flow. See [[Dev Local App Testing]].

> **Note**
> The two integration configs have deliberately similar but distinct names: `jest.config.integration.js` (L2, Postgres) vs `jest.integration.config.js` (L3, live Ongoing). The `.config.integration` one is the Medusa/Postgres harness; the `.integration.config` one is the live Ongoing harness.

### Unit suite (`yarn test`)

- `testMatch: ["**/__tests__/**/*.test.ts"]`, rooted at `src`.
- `testPathIgnorePatterns` includes `\\.live\\.test\\.ts$` — live tests are excluded here by design.
- Transforms with `@swc/jest` (see `.swcrc`: ES2021, decorators on, CommonJS output).
- `moduleNameMapper` remaps `buffer-equal-constant-time` to the `__mocks__` shim (Node 26 `SlowBuffer` fix — see [[Dev Gotchas]]).
- `clearMocks: true`.

This is the suite you run on every commit. It is self-contained — no external services, no credentials.

### Medusa integration suite (`yarn test:integration`)

Layer 2 boots the plugin's `ongoing` module inside a **real DB-backed Medusa module container** using `moduleIntegrationTestRunner` from `@medusajs/test-utils`, exercising the wiring the unit suite mocks: module registration, the `validate-options` loader, migrations/schema, and the module service against Postgres. Ongoing is **never** contacted over the network — HTTP is stubbed (see below).

Current specs:

- `integration-tests/ongoing-module.spec.ts` — boot smoke (module registers, migrates, resolves; loader ran).
- `integration-tests/push-order-to-ongoing.spec.ts` — drives the real `pushOrderToOngoing` workflow (real order-mapper + real SKU resolver) and asserts the real `OngoingOrderSync` row transitions `pending → sent`, plus the error-row-on-failure path.
- `integration-tests/fulfillment-provider.spec.ts` — the fulfillment provider's `createFulfillment` / `cancelFulfillment` end-to-end into the real module + workflows.
- `integration-tests/subscribers.spec.ts` — the order-canceled, order-edit-confirmed, and order-updated subscribers against real rows.
- `integration-tests/shipment-status.spec.ts` — the webhook receiver and status interpretation.
- `integration-tests/stock-sync.spec.ts` — inventory reconciliation, delta and full sweep.
- `integration-tests/sync-lock.spec.ts` — the stock-sync lock that keeps concurrent runs from overlapping.
- `integration-tests/full-app.spec.ts` — the fidelity harness: boots a **full in-process Medusa app** via `medusaIntegrationTestRunner` against the fixture config in `integration-tests/full-app-fixture/`, so Medusa core drives `createFulfillment` through the real `@medusajs/medusa/fulfillment` module and `query.graph` resolves real cross-module links. This is the layer that catches module-isolation and link-alias defects the module container cannot.
- `integration-tests/_shared/l2.ts` — shared harness: fake plugin options, a fake `query.graph` (the core Order/Product modules are absent from a module container, so cross-module reads are faked), and a `createMedusaContainer()` that registers the **real** module service alongside those fakes so the real workflow orchestrator runs.

**How Ongoing HTTP is stubbed:** with [`nock`](https://github.com/nock/nock). `OngoingClient`'s default transport is Node's `https` module, which nock intercepts; Postgres uses raw sockets via `pg` and is unaffected. Specs `nock(ONGOING_BASE_URL).put("/orders")...` etc. and `nock.cleanAll()` in `afterEach`.

- `testMatch: ["**/integration-tests/**/*.spec.ts"]`, rooted at `integration-tests/` (outside `src/`, so `yarn test` never picks these up). Specs end in `.spec.ts` (not `.test.ts`).
- `setupFiles: ["<rootDir>/integration-tests/setup-env.ts"]` fills conventional Medusa local `DB_*` defaults (`127.0.0.1:5432 postgres/postgres`) when unset, so the suite runs out of the box; CI overrides via real env.
- `testTimeout: 60_000` — booting a module and running migrations against Postgres is far slower than a unit test; the runner creates and drops a temp database per run.
- Same `buffer-equal-constant-time` shim as the other configs.
- Seed rows **per test** in a `beforeEach` (the runner resets the DB and re-inits the module each test); the `service` handed to `testSuite` is a live proxy, valid only after that per-test init.

**Requires a running Postgres and Node 20, 22, or 24.** The `test:integration` script sets `NODE_OPTIONS=--experimental-vm-modules` (the module loader uses dynamic `import()`), and Node 26 breaks the mikro-orm/migration path (see [[Dev Gotchas]]). The runner reads connection details from env and creates/drops its own throwaway temp database (via `pg-god`, a devDependency); it never writes to an existing app database:

```bash
nvm use 24
export DB_HOST=127.0.0.1      # default (setup-env.ts) 127.0.0.1
export DB_PORT=5432           # default 5432
export DB_USERNAME=postgres   # a role that may CREATE/DROP DATABASE
export DB_PASSWORD=postgres
yarn test:integration
```

The `DB_USERNAME` role must be allowed to create and drop databases. Nothing here needs Ongoing credentials. No local Postgres? Any standard local Postgres works — e.g. the docker Postgres from a sibling Medusa app (`docker compose up -d` in that app, then point `DB_*` at it).

**What L2 still cannot reach:** the full-app harness boots from a fixture config that registers this plugin's module and provider by **source path**, so it proves the runtime wiring but not the packaging. Whether an installed package resolves through its `exports` map, and whether the admin extensions survive a consuming app's admin build, are only answerable in a real app — see [[Dev Local App Testing]].

### Live harness (`yarn test:live`)

The Layer 3 live integration harness exercises the real Ongoing API to catch conformance drift the unit suite cannot (it mocks the transport). It currently lives at `src/lib/ongoing/__tests__/client.live.test.ts`.

- `setupFiles: ["<rootDir>/jest.integration.setup.js"]` loads `.env.integration` (git-ignored) into `process.env` **before** any test module runs.
- `testTimeout: 60_000` — a single order round-trip can wait on Ongoing's sequential per-goods-owner write processing.
- Same `buffer-equal-constant-time` shim as the unit config.

The live test **self-skips** unless `ONGOING_LIVE` is exactly `"1"`, so `yarn test:live` is safe to run without credentials (it just skips and produces no signal).

## Live harness environment

Copy `.env.integration.example` to `.env.integration` (git-ignored) and fill in **sandbox** values:

```bash
ONGOING_LIVE=1            # master switch; read-path live tests run only when exactly "1"
ONGOING_URL=             # REST base URL, MUST include the /api/v1 suffix, no trailing slash
                          # e.g. https://api.ongoingsystems.se/<instance>/api/v1
ONGOING_USER=            # basic-auth user
ONGOING_PASS=            # basic-auth pass
ONGOING_GOODS_OWNER=     # integer goods-owner id of the SANDBOX warehouse
ONGOING_LIVE_HEAVY=0     # optional: full order-history pagination sweep (minutes-long); off by default
ONGOING_LIVE_WRITES=0    # gates the write round-trip (putArticle -> putOrder -> cancelOrder)
```

> **Warning**
> `ONGOING_LIVE_WRITES=1` creates and then cancels a **real order** in the warehouse. Set it only against a throwaway sandbox goods owner, never a production tenant.

`ONGOING_LIVE_HEAVY=1` walks every order at concurrency 1 and can take minutes on a real warehouse — leave it off unless you are specifically testing pagination.

## Mocks

- `__mocks__/buffer-equal-constant-time.js` is a manual Jest mock that reimplements `bufferEq`/`install`/`restore` with plain `Buffer`, since Node 26 removed `SlowBuffer`. It is wired into **both** jest configs via `moduleNameMapper` (it lives outside `src/`, so Jest's automatic `__mocks__` discovery does not find it — keep it in both configs).
- Unit tests inject fakes rather than hitting the network: `OngoingClient` accepts a `fetchImpl` and a `sleep`, so client tests supply a stub transport and a controllable clock. Follow that pattern rather than mocking modules globally.

## Writing tests

Match the existing layout and style:

- **Location**: co-locate tests in a `__tests__/` folder next to the code under test (for example `src/workflows/steps/__tests__/`). Test files at every level of `src/` already follow this.
- **Naming**: `*.test.ts` for unit tests; `*.live.test.ts` **only** for tests that must hit the real Ongoing API. The `.live` suffix is what keeps a test out of the default suite, so never give a live test a plain `.test.ts` name.
- **Pure functions first**: much of the logic (order mapper, retry policy, gate decisions, burst-union, payload mapping) is pure and tested directly with no Medusa container. Prefer extracting a pure helper and testing it over spinning up infrastructure.
- **Injected dependencies**: for the client and steps, pass fakes (`fetchImpl`, `sleep`, a stub module service) rather than reaching for real services.
- **Live tests must self-skip**: gate the body on `process.env.ONGOING_LIVE === "1"` (and `ONGOING_LIVE_WRITES` for write paths) so the suite is safe to run without credentials.

Run the suite you affected before committing; run `yarn test:live` against a sandbox when you change the Ongoing client. CI (`.github/workflows/ci.yml`) runs `yarn test` (L1 only) on every PR and push to `main`; `test:integration` and `test:live` are not wired into CI and stay manual gates — see [[Dev Contributing]].

## Related pages

- [[Dev Local App Testing]]
- [[Dev Contributing]]
- [[Dev Gotchas]]
- [[Dev Architecture]]
- [[Dev Medusa Rules]]

This page shows you how to install this plugin into a Medusa app on your own machine and exercise it by hand, without publishing to a package registry. It is for contributors who need to see the plugin behave inside a real app; for the automated suites, see [[Dev Testing]].

## Why a real app

The automated suites stop short of the app boundary. `yarn test` mocks everything, `yarn test:integration` boots the `ongoing` module (and, in `full-app.spec.ts`, a full in-process app from a fixture config), and `yarn test:live` only exercises the Ongoing client. None of them cover:

- **Packaging resolution** — whether a consuming app can actually resolve `@comfyballs/medusa-plugin-ongoing-warehouse/providers/ongoing-fulfillment` through the `exports` map and the built `.medusa/server` output.
- **Admin bundling** — whether the dashboard, settings page, and order widget survive the consuming app's admin build and render next to that app's own extensions.
- **Scheduled jobs** — `status-poll`, `stock-sync`, and `retry-failed-syncs` firing on their real cron cadence in a long-running process.
- **The operator experience** — creating an integration through the admin, pricing the shipping option, and watching a real order move.

## Prerequisites

- A Medusa v2 app on 2.16.0 or newer, with its Postgres running.
- Node 20, 22, or 24. Not Node 26 — see [[Dev Gotchas]].
- Ongoing **sandbox** credentials. Never point a local app at a production goods owner.

## Step 1 — publish to the local store

Medusa's CLI ships a local package store backed by [yalc](https://github.com/wclr/yalc); nothing goes to npm. From this plugin directory:

```bash
yarn build
npx medusa plugin:publish
```

That prints `@comfyballs/medusa-plugin-ongoing-warehouse@0.0.1 published in store`. While iterating, run the watch-mode equivalent instead, which rebuilds and re-publishes on every save:

```bash
yarn dev
```

The store copy contains only the `files` allowlist — `.medusa/server` and `package.json`. It carries **no nested `node_modules`**, which is what keeps the plugin's own `@medusajs/*` copies out of the consuming app. Resolution falls through to the app's own dependencies, so there is only ever one framework instance.

## Step 2 — add the plugin to the app

From the consuming app's backend directory:

```bash
npx medusa plugin:add @comfyballs/medusa-plugin-ongoing-warehouse
yarn install
```

Use the app's own package manager for the second command — `pnpm install` or `npm install` if the app is not on yarn.

> **Caution**
> `plugin:add` writes a **local-path dependency** (`file:.yalc/...`) into the app's `package.json` and creates `.yalc/` and `yalc.lock`. A hosting platform that builds from git cannot resolve any of it, so a deploy from a commit containing them fails. Add `.yalc/` and `yalc.lock` to the app's `.gitignore` and keep the dependency line out of every commit.

Then confirm the app resolves exactly one copy of the framework — two copies break Awilix registration identity, `MedusaService` base classes, and `defineLink`, with symptoms that look like anything but a duplicate dependency:

```bash
yarn why @medusajs/framework    # or: pnpm why @medusajs/framework
```

## Step 3 — register the plugin and the provider

Follow [[User Setup Guide]] for the config shape. Two registrations are required: the plugin itself, and the fulfillment provider under the core fulfillment module.

> **Warning**
> The fulfillment module's provider loader **disables every provider not listed in your config**. It reads the configured providers, then sets `is_enabled = false` on every `fulfillment_provider` row that is missing from that list. If the app previously relied on the implicit default and you now declare the module to add `ongoing`, list `@medusajs/medusa/fulfillment-manual` (id `manual`) alongside it — otherwise `manual_manual` is disabled at boot and every existing shipping option bound to it stops working. Check the rows before and after your first boot:
>
> ```bash
> psql -d <your-app-database> -c "select id, is_enabled from fulfillment_provider;"
> ```

## Step 4 — apply migrations and set credentials

Put the sandbox credentials in the app's `.env` (see [[User Configuration Reference]] for names), then apply the plugin's module migrations and link tables from the app directory:

```bash
npx medusa db:migrate
```

This creates the `ongoing_integration` and `ongoing_order_sync` tables plus the three `defineLink` tables. It touches no core Medusa table, and re-running it is a no-op.

## Step 5 — boot and verify

Start the app and read the boot log before touching the admin. The options validator runs at startup and fails the boot on a bad `integrations` array rather than failing at first use, so a clean start is real signal:

```
[ongoing] validated N warehouse integration(s)
```

Then walk the surfaces in order, stopping at the first failure:

| Check | Where | Expected |
|---|---|---|
| Module loaded | boot log | the `[ongoing] validated ...` line, no Awilix resolution errors |
| Jobs registered | boot log | `status-poll`, `stock-sync`, `retry-failed-syncs` |
| Settings page | `/app/settings/ongoing` | integration list renders; **Create integration** works |
| Connection | settings page | **Test connection** succeeds against the sandbox |
| Dashboard | `/app/ongoing` | syncs table renders |
| Order widget | any order detail page | the Ongoing panel renders |
| Order push | fulfill an order on an Ongoing shipping option | the order appears in Ongoing; the sync row reaches `synced` |

For the full operator walkthrough behind those last rows, see [[User Verification]].

## Iterating

With `yarn dev` running in this repo, a save rebuilds and re-publishes to the store, and the consuming app picks the change up on its next restart. Restart the app after changes to migrations, module registration, or plugin options — those are read once at boot.

## Check a registry install before calling it done

The yalc flow links a directory, which can mask a broken `files` or `exports` field. Once, before you consider the install verified, confirm the real tarball is correct:

```bash
npm pack --dry-run
```

The listing must contain the `.medusa/server/**` tree. If it shows only `package.json` and `README.md`, the build output is missing and a published package would be empty — see the packing trap in [[Dev Gotchas]].

## Removing the plugin

To back the app out cleanly:

```bash
npx yalc remove @comfyballs/medusa-plugin-ongoing-warehouse
yarn install
```

Then drop the plugin and provider entries from `medusa-config.ts`. The database tables from Step 4 are **not** removed by uninstalling — drop `ongoing_integration`, `ongoing_order_sync`, and the three link tables by hand if you want the schema gone too.

## Related pages

- [[Dev Testing]]
- [[Dev Gotchas]]
- [[User Setup Guide]]
- [[User Verification]]
- [[Dev Contributing]]

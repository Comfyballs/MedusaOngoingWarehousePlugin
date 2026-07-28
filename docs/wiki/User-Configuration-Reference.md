This page is a complete reference for every plugin option, environment-variable convention, and the two configurable JSON structures (`edit_sync_rules` and status codes). Look here when you need an option's type, default, or validation behavior. For a guided walkthrough, see [[User Setup Guide]].

## Root plugin options

You pass these in the consuming app's `medusa-config.ts` under the plugin's `options`.

| Option | Type | Required | Default | Controls |
|---|---|---|---|---|
| `integrations` | `OngoingCredentials[]` | Yes (array, may be empty) | — | One entry per Ongoing goods owner; each binds one-to-one to a single Medusa stock location. See the per-integration table below and the mapping in [[User Ongoing Concepts]]. |
| `defaultStockSyncInterval` | `string` (milliseconds, as a decimal string) | No | `"600000"` (10 minutes) | Fallback stock-sync interval used when an integration row leaves `stock_sync_interval` blank. |
| `defaultStatusPollInterval` | `string` (milliseconds) | No | `"60000"` (1 minute) | Fallback status-poll interval used when an integration row leaves `status_poll_interval` blank. |
| `rateLimitConcurrency` | `number` | No | `1` | Maximum concurrent Ongoing API calls per goods owner. Ongoing recommends fully sequential calls — leave at `1` unless Ongoing support advises otherwise. |

> **Note**
> These options are validated at startup. `rateLimitConcurrency` must be an integer `>= 1`, and `defaultStockSyncInterval` / `defaultStatusPollInterval` must parse to a positive integer number of milliseconds. A bad value fails the boot with a clear `INVALID_DATA` error instead of surfacing later mid-request or silently disabling a poll.

## Per-integration credentials

Each item in the `integrations` array has this shape (`OngoingCredentials`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | `string` | Yes | The credential key referenced everywhere else — the admin UI, the webhook URL path, and database rows. Must be unique across the array. |
| `baseUrl` | `string` | Yes | Ongoing REST base URL. **Must include `/api/v1`** and have no trailing slash, for example `https://api.ongoingsystems.se/<instance>/api/v1`. |
| `username` | `string` | Yes | Ongoing REST API user. |
| `password` | `string` | Yes | Ongoing REST API password. Sent as HTTP Basic auth. |
| `goodsOwnerId` | `number` | Yes | Ongoing's numeric goods-owner id for this warehouse. |
| `webhookSecret` | `string` | No, but required for webhooks | The static `X-Auth-Token` value the webhook route checks. If unset, the webhook route rejects **all** requests for that key with `401`. |

## Boot-time validation

The plugin validates options in a module loader that runs at server startup, so a bad config **fails fast** rather than silently misbehaving. All failures throw a `MedusaError` of type `INVALID_DATA`:

- `integrations` is not an array → `[ongoing] plugin options must include an \`integrations\` array`.
- A required field (`key`, `baseUrl`, `username`, `password`, `goodsOwnerId`) is `undefined`, `null`, or `""` → `[ongoing] integration "<key>" is missing required option "<field>"`. If the row has no `key`, the message uses `<missing key>`.
- Two entries share a `key` → `[ongoing] duplicate credential key "<key>" in integrations`.

On success, the plugin logs `[ongoing] validated N warehouse integration(s)` at info level. Watch for this line to confirm your config loaded.

Credentials never touch the database. Only the credential `key` is stored in Medusa; the base URL, username, password, and goods-owner id stay in app config.

## Environment-variable convention

Credentials are secrets, so pass them through environment variables rather than literals. There is no fixed variable naming scheme — you choose the names and reference them in `medusa-config.ts`. A common pattern names variables per integration key:

```bash
# .env in the consuming Medusa app
ONGOING_A_URL=https://api.ongoingsystems.se/<instance>/api/v1
ONGOING_A_USER=<your-ongoing-user>
ONGOING_A_PASS=<your-ongoing-password>
ONGOING_A_GOODS_OWNER=42
ONGOING_A_WEBHOOK_SECRET=<a-long-random-string>
```

```ts
// medusa-config.ts
options: {
  integrations: [
    {
      key: "warehouse-a",
      baseUrl: process.env.ONGOING_A_URL,
      username: process.env.ONGOING_A_USER,
      password: process.env.ONGOING_A_PASS,
      goodsOwnerId: Number(process.env.ONGOING_A_GOODS_OWNER),
      webhookSecret: process.env.ONGOING_A_WEBHOOK_SECRET,
    },
  ],
}
```

> **Note**
> `goodsOwnerId` is a `number`. Wrap the environment variable in `Number(...)` — environment variables are always strings.

The live test harness uses its own separate variables (`ONGOING_URL`, `ONGOING_USER`, `ONGOING_PASS`, `ONGOING_GOODS_OWNER`, and switches). Those are unrelated to your runtime config — see [[User Verification]].

## Per-integration settings (set in the admin)

These are stored on the integration row and edited in the admin Settings UI, not in `medusa-config.ts`. `credential_key` and `stock_location_id` are **immutable after creation**; everything else is editable.

| Setting | Type | Default | Controls |
|---|---|---|---|
| `credential_key` | string (from configured keys) | — | Which configured goods owner this integration uses. Immutable. |
| `stock_location_id` | string | — | Which Medusa stock location this warehouse serves. Immutable. Assigning it runs location setup automatically. |
| `enabled` | boolean | `true` | Master switch. Disabled integrations are skipped by all jobs. |
| `stock_sync_enabled` | boolean | `true` | Whether the stock-sync job runs for this integration. |
| `stock_sync_interval` | string (ms) or blank | blank → inherits `defaultStockSyncInterval` | How often stock is pulled from Ongoing. |
| `status_poll_interval` | string (ms) or blank | blank → inherits `defaultStatusPollInterval` | How often order status is polled from Ongoing. |
| `stock_reconcile_mode` | `sellable_plus_reserved` \| `precise` \| `onhand` | `sellable_plus_reserved` | How Ongoing quantities map to Medusa stock. See below. |
| `edit_sync_rules` | JSON object or null | null (edits blocked) | Which order edits re-push at which Ongoing statuses. See below. |
| `shipped_status_codes` | number array or null | null | Ongoing statuses that mean "shipped". |
| `cancellable_status_codes` | number array or null | null | Ongoing statuses at which a cancel may be sent. |

## Stock reconcile modes

`stock_reconcile_mode` controls how an Ongoing quantity becomes a Medusa `stocked_quantity`:

- **`sellable_plus_reserved`** (default) — reconstructs Medusa's `stocked = sellable + reserved` invariant so Medusa's own reservations are not double-deducted. The computed value is `max(0, sellable + min(medusa_reserved, allocated))`.
- **`precise`** — like the default, but scopes reservations to orders already synced to Ongoing: `max(0, sellable + reserved_scoped_to_synced_orders)`.
- **`onhand`** — uses Ongoing's on-hand quantity directly: `max(0, numberOfItems)`.

All three also write `incoming_quantity` from Ongoing's `toReceiveNumberOfItems`.

## `edit_sync_rules` structure

`edit_sync_rules` gates which order edits are re-pushed to Ongoing, per edit category, for the order's current Ongoing status. It is a raw JSON object with two arrays of status codes:

```json
{
  "address_contact": [220, 230],
  "line_items": [220]
}
```

- `address_contact` — status codes at which address, contact, and email edits may re-push.
- `line_items` — status codes at which line-item and shipping-line edits may re-push.

An edit re-pushes only when the order's current Ongoing status code is listed under its category. If the category is absent or empty, edits of that category are blocked.

> **Warning**
> If `edit_sync_rules` is null or empty (the default right after creating an integration), **every order edit is blocked** with reason `no_edit_rules`. Configure this before you rely on edit syncing. See [[User How It Works]] for the edit flow and [[User Troubleshooting]] for clearing a blocked edit.

## Status-code selection

`shipped_status_codes` and `cancellable_status_codes` are number arrays chosen in the admin from the live status list returned by **Test connection**. Codes already stored on an integration stay visible and editable as soon as you open the form — they render as bare code checkboxes (without a label) until you click **Test connection**, which loads the full status list from Ongoing and enriches each code with its text. See the walkthrough in [[User Setup Guide]].

## Migrations

The module ships several migrations. After installing or updating the plugin in your app, apply them:

```bash
npx medusa db:migrate
```

## Related pages

- [[User Setup Guide]]
- [[User How It Works]]
- [[User Troubleshooting]]
- [[Documentation Guidelines]]

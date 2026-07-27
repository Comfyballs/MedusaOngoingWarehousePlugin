This page walks you through a recommended setup: install the plugin, register it and its fulfillment provider in `medusa-config.ts`, create an integration in the admin, price the auto-created shipping option, set a carrier, and configure the Ongoing-side webhook. For a fast first-order path, see [[User Quickstart]]; for every option's details, see [[User Configuration Reference]].

## Prerequisites

- A Medusa v2 app on **2.16.0** (the version this plugin is pinned to), Node **20 or newer**.
- Ongoing REST API credentials for at least one goods owner (base URL including `/api/v1`, username, password, and goods-owner id). These come from Ongoing — see [[User Ongoing Concepts]].
- At least one Medusa **stock location** to bind the warehouse to.

## Step 1 — install the plugin

Add the plugin to your Medusa app:

```bash
yarn add MedusaOngoingWarehousePlugin
```

The published artifact is the plugin's build output (`.medusa/server`). If you install from a local checkout instead of a registry, run `yarn build` in the plugin repo first, or use `yarn dev` for a yalc-linked watch build.

## Step 2 — register the plugin and provider

Two registrations are required, and the second is easy to miss:

1. Register the **plugin** to load the module, jobs, subscribers, admin UI, and webhook route.
2. Register the **fulfillment provider** under the core fulfillment module, so orders can actually be fulfilled through Ongoing.

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: "MedusaOngoingWarehousePlugin",
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
        rateLimitConcurrency: 1,
      },
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          {
            resolve: "MedusaOngoingWarehousePlugin/providers/ongoing-fulfillment",
            id: "ongoing",
            options: {},
          },
        ],
      },
    },
  ],
})
```

The provider is registered through the plugin's `providers/*` export path — `MedusaOngoingWarehousePlugin/providers/ongoing-fulfillment` — which resolves to the compiled provider `index.js`.

> **Warning**
> Do not rename the provider `id` (`"ongoing"`) once shipping options exist. Medusa derives the runtime provider id as `fp_ongoing_<config-id>` and shipping-option provider ids as `ongoing_<optionId>` (for example `ongoing_ongoing-standard`). Renaming it orphans existing shipping options and requires a migration.

## Step 3 — set environment variables and apply migrations

Put your credentials in the app's `.env` (see the convention in [[User Configuration Reference]]), then apply the plugin's migrations:

```bash
npx medusa db:migrate
```

## Step 4 — restart and confirm the config loaded

Restart the Medusa app. The option validator runs at boot. A misconfigured `integrations` array fails startup with a clear `[ongoing] ...` error. A good config logs:

```
[ongoing] validated N warehouse integration(s)
```

Watch for that line before continuing.

## Step 5 — create an integration in the admin

Open **Settings → Ongoing Warehouse** in the Medusa admin. Click **Create integration** and fill in the form:

1. **Credential key** — a dropdown populated from your configured plugin options. If it is empty, your `integrations` option is missing or misconfigured.
2. **Stock location** — the Medusa stock location this warehouse serves (the picker lists up to 100 locations). This is immutable after creation.
3. **Test connection** — click this **before** touching the status-code pickers. It calls Ongoing with the selected credential key and, on success, shows `Connected — N order statuses available` and loads the live status list into the two status-code pickers.
4. **Shipped status codes** and **Cancellable status codes** — check the codes that mean "shipped" and "cancellable" for this goods owner. See [[User Ongoing Concepts]].
5. **Enabled** / **Stock sync enabled** — leave both on unless you have a reason not to.
6. **Stock sync interval** / **Status poll interval** — leave blank to inherit the global defaults.
7. **Stock reconcile mode** — usually `sellable_plus_reserved`. See [[User Configuration Reference]].
8. **Edit sync rules (JSON)** — optional at creation, but note edits are blocked until you set it. See the JSON shape in [[User Configuration Reference]].

> **Note**
> When you open the **Edit** drawer for an existing integration, any status codes already stored show up immediately as checkboxes — as bare code numbers (without their text label) until you click **Test connection**, which loads the full live list and adds the labels. You only need Test connection to *discover new* codes or see their labels; you never need it just to view or un-check codes you already saved. On the **create** form there are no stored codes yet, so click Test connection first to load the list.

On save, the plugin runs a workflow that **auto-provisions everything the location needs to fulfill via Ongoing**:

- Reuses the location's existing fulfillment set, or creates one named "Ongoing Fulfillment".
- Creates a service zone named "Ongoing" scoped to the location's country.
- Creates one flat-rate shipping option named "Ongoing Fulfillment" with provider id `ongoing_ongoing-standard`, **seeded at price 0**.
- Links the integration to the stock location.

If any step fails, the whole creation rolls back — you never get a half-created integration.

## Step 6 — price the shipping option

The auto-created shipping option is a **placeholder priced at 0**. Its description reads "Auto-created by the Ongoing plugin. Edit name, price, and carrier before going live."

> **Warning**
> Edit the "Ongoing Fulfillment" shipping option's price (and name) before you go live, or customers will get free shipping through Ongoing.

## Step 7 — set the carrier (way of delivery)

To tell Ongoing which carrier to use, set `way_of_delivery` (and optionally `transporter`) on the shipping option's `data`. There is **no admin form field for this** — set it through the shipping-option API or whatever raw shipping-option data surface your admin exposes. Accepted shapes:

```json
{ "way_of_delivery": "dhl-express" }
```

```json
{
  "way_of_delivery": { "code": "dhl-express", "name": "DHL Express" },
  "transporter": {
    "transporterCode": "DHL",
    "transporterServiceCode": "EXP",
    "paymentAdvanced": false
  }
}
```

The config is validated when you save the shipping option: a malformed `way_of_delivery`/`transporter` is rejected then, not at order-push time. If you leave it unset, orders still push and warehouse staff pick the carrier manually in Ongoing.

## Step 8 — configure the webhook on the Ongoing side

For near-real-time status and shipment updates, register a webhook in Ongoing (a manual step in Ongoing's admin or via Ongoing support) pointed at your app:

```
POST https://<your-medusa-app>/ongoing/webhooks/<credential_key>
```

Set the `X-Auth-Token` request header to the `webhookSecret` you configured for that integration.

- Use the credential `key` from your plugin options as the last URL segment.
- **Register the webhook for the full active-status range, not "shipped only."** The plugin uses non-shipped status changes to keep edit/cancel gating fresh, so restricting it to shipped events loses that benefit.
- If you did not set `webhookSecret`, the route rejects every request with `401`. Set it and restart before configuring Ongoing.

The webhook is optional — the every-minute status-poll job is the backstop — but it makes shipment and status updates near-instant.

## Editing an integration later

Use the **Edit** action (a side drawer) in Settings → Ongoing Warehouse. `credential_key` and `stock_location_id` are shown as disabled — they cannot change. The same Test-connection-first rule applies to the status-code pickers in the edit drawer.

## Deleting an integration

Deleting removes **only the Medusa-side integration row**. The fulfillment set, service zone, and shipping option created during setup are **not** removed and must be cleaned up manually if no longer needed. The admin shows this warning before you confirm.

## Related pages

- [[User Quickstart]]
- [[User Configuration Reference]]
- [[User How It Works]]
- [[User Verification]]
- [[User Ongoing Concepts]]

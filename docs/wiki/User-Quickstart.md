This tutorial takes you from an installed plugin to a first order pushed into Ongoing Warehouse. Follow it end to end once; the linked reference pages have the full detail for later. If you are new to Ongoing's concepts, skim [[User Ongoing Concepts]] first.

## Before you start

You need:

- A Medusa v2 app on 2.16.0, Node 20 or newer.
- Ongoing REST credentials for one goods owner: base URL (including `/api/v1`), username, password, and goods-owner id.
- A Medusa stock location.

## 1. Install

```bash
yarn add MedusaOngoingWarehousePlugin
```

## 2. Register the plugin and the fulfillment provider

Both registrations matter — the second is easy to forget, and without it you cannot fulfill through Ongoing.

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

Set the referenced environment variables in your app's `.env`.

## 3. Apply migrations and restart

```bash
npx medusa db:migrate
```

Restart the app and confirm the logs show:

```
[ongoing] validated N warehouse integration(s)
```

## 4. Create an integration

In the admin, go to **Settings → Ongoing Warehouse → Create integration**:

1. Pick your **credential key** and a **stock location**.
2. Click **Test connection** — it should report `Connected — N order statuses available`.
3. Check the **shipped** and **cancellable** status codes (they only appear after Test connection).
4. Save.

Saving auto-provisions a fulfillment set, service zone, and a shipping option named "Ongoing Fulfillment" for that location.

## 5. Price the shipping option and set edit rules

The auto-created shipping option is **priced at 0**. Edit its price (and name) before going live.

Order edits are **blocked by default** until you set `edit_sync_rules`. If you want address or line-item edits to sync, configure the rules now — see [[User Configuration Reference]].

## 6. Push your first order

1. Place an order that uses the Ongoing shipping option.
2. Create a fulfillment for it.
3. Open the order detail page and confirm the **Ongoing Warehouse** widget shows a `sent` badge and an Ongoing order number.
4. Confirm the order appears in Ongoing's own UI.

That's a working integration. From here, Ongoing's shipment updates flow back automatically via the status-poll job (every minute) and, if you configure it, the webhook.

## Next steps

- Configure the webhook and carrier: [[User Setup Guide]].
- Understand what runs automatically: [[User How It Works]].
- Verify each piece: [[User Verification]].
- Operate it day to day: [[User Daily Operation]].

## Related pages

- [[User Setup Guide]]
- [[User How It Works]]
- [[User Configuration Reference]]
- [[User Ongoing Concepts]]

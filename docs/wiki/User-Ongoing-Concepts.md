This page explains the Ongoing Warehouse concepts you need to know before setting up the plugin, and how each one maps to Medusa. Read it once so the rest of the user documentation makes sense.

## Goods owner

A **goods owner** (`goodsOwnerId`) is Ongoing's tenant concept. Every article, order, and inventory record in an Ongoing warehouse belongs to a specific goods owner. Your Ongoing REST credentials are scoped to one goods owner.

In this plugin, **one goods owner maps to one Medusa stock location**. Each entry in the plugin's `integrations` option describes a single goods owner, and creating an integration in the admin binds that goods owner to exactly one stock location.

## Articles

An **article** is Ongoing's product/SKU record (`articleNumber`, `articleName`, and so on). This plugin uses the **Medusa variant SKU verbatim as the Ongoing `articleNumber`** — there is no separate mapping table.

Two consequences follow:

- A SKU must be **unique across all Medusa variants**, or the order push fails with a terminal error.
- The plugin does **not** pre-sync your whole catalog. It upserts (`PUT /articles`) only the SKUs referenced by an order, immediately before pushing that order.

## Ways of delivery and transporters

A **way of delivery** is Ongoing's carrier/shipping-method concept. Ongoing's transport-system integration uses it to auto-book a shipment with a carrier. A **transporter** is the specific carrier and service.

This plugin lets you attach a `way_of_delivery` code (and optional `transporter` details) to a Medusa shipping option's `data`. If you omit it, orders still push to Ongoing, and warehouse staff pick the carrier manually in Ongoing. See [[User Configuration Reference]] for the exact shape.

## Order statuses

Ongoing tracks each order through a **numeric status lifecycle**. This plugin polls the active-through-shipped range (status codes 100–999). The exact numbers and labels are **tenant-specific** — each goods owner configures its own set — which is why the admin UI fetches them live from Ongoing rather than hard-coding a list.

Because codes vary per tenant, you tell the plugin which codes mean "shipped" and which mean "cancellable" per integration:

- **Shipped status codes** — when an order reaches one of these, the plugin creates the Medusa shipment and writes tracking back.
- **Cancellable status codes** — the plugin only sends a cancel to Ongoing when the order's current status is in this list.

## Webshop flow

Ongoing documents a recommended integration sequence for a webshop or OMS, and this plugin follows it:

1. **ProcessArticle** — upsert the articles an order needs (`PUT /articles`).
2. **GetInventory** — poll stock levels back into Medusa (`GET /articles`).
3. **ProcessOrder** — upsert the order (`PUT /orders`).
4. **GetOrdersByQuery** — poll order and shipment status (`GET /orders`).

See the [Ongoing webshop flow documentation](https://developer.ongoingwarehouse.com/webshop-flow) for the source pattern.

## Webhooks

Ongoing can send outbound webhooks (for example, order status changed or picked) authenticated with a static `X-Auth-Token` header. This plugin receives them at a dedicated route. Registering the webhook is a **manual step in Ongoing's own admin** — the plugin does not automate it. See [[User Setup Guide]] for the URL shape and header.

## Where credentials come from

You get your Ongoing REST API credentials — base URL, username, password, and goods-owner id — from **Ongoing's own support or onboarding process**. They are external to Medusa; the plugin cannot provision them.

## Related pages

- [[User Setup Guide]]
- [[User Configuration Reference]]
- [[User How It Works]]

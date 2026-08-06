This page explains the Ongoing Warehouse concepts you need to know before setting up the plugin, and how each one maps to Medusa. Read it once so the rest of the user documentation makes sense.

## Goods owner

A **goods owner** (`goodsOwnerId`) is Ongoing's tenant concept. Every article, order, and inventory record in an Ongoing warehouse belongs to a specific goods owner. One set of Ongoing REST credentials can reach **several** goods owners.

So the credential key and the goods owner are separate concerns, and each goods owner still gets its own dedicated stock location:

```text
credential key  →  goods owner  ⇄  Medusa stock location  ⇄  integration row
(key, in config)   (set in admin)   (stock_location_id)      (one per pair)
```

- Each entry in the plugin's `integrations` option describes **one Ongoing account** — base URL, user, password — under a unique credential `key`. It carries no goods owner.
- Creating an integration in the admin picks a credential `key`, sets the **goods-owner id** that integration serves, and binds it to **exactly one** Medusa stock location. Several integrations may share one credential key, each with a different goods owner.
- The stock location side stays **unique and exclusive**: a location can be served by only one goods owner. You **cannot** point two goods owners at the same location, and the database enforces this — so a location you create is effectively *dedicated* to the single goods owner you bind it to.
- The binding is **immutable after creation** — to change which location a goods owner uses, delete the integration and create a new one.

**To serve one goods owner:** create a Medusa stock location, add that goods owner to the `integrations` option, then create an integration binding the two. See [[User Setup Guide]].

**To serve several goods owners:** repeat the whole pattern once per goods owner — N goods owners means N `integrations` entries, N stock locations, and N integration rows. There is no shared-location or many-to-one arrangement.

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

### Canonical lifecycle and stages

Ongoing's [documented status list](https://docs.ongoingwarehouse.com/manuals/statuses) maps to the semantic **stages** the plugin acts on. The canonical codes (Norwegian sandbox labels in parentheses) are:

| Code | Label | Stage | Plugin behavior |
|-----:|-------|-------|-----------------|
| 200 | Åpen (open) | created | Tracked; status recorded for edit/cancel gating |
| 300 | Plukk (picking) | picking | Tracked |
| 320 | Skrevet ut (pick list printed) | picking | Tracked |
| 400 | Plukket (picked) | picked | Tracked — **picked ≠ shipped** |
| 425 | Sendt/Dellevert (sent / partly delivered) | **shipped** | Creates the Medusa shipment + tracking |
| 450 | Sendt (sent) | **shipped** | Creates the Medusa shipment + tracking |
| 451 | Klar til henting (ready for pickup) | **shipped** | Creates the Medusa shipment + tracking |
| 475 | Retur (return) | returned | Handled by the separate return path |
| 500 | Hentet (picked up) | **delivered** | Records the pickup-point collection |
| 1000 | Annullert (cancelled) | cancelled | Terminal |

**Pickup orders are a two-step:** an order is *sent* (450 → shipped, Medusa shipment created) and later *picked up* at the pickup point (500 → delivered). The plugin records both — reaching "delivered" no longer swallows the transition the way a flat "shipped" flag once did. If a `500` arrives without the plugin ever having seen a shipped code (a missed poll), it backfills the Medusa shipment first, then records delivery.

### Per-integration overrides

Because codes vary per tenant, you can tell the plugin which codes mean "shipped", "delivered", and "cancellable" per integration. **Leaving a list empty derives sensible defaults from the canonical table above** (shipped: 425/450/451; delivered: 500), so a fresh integration works without hand-picking codes.

- **Shipped status codes** — when an order reaches one of these, the plugin creates the Medusa shipment and writes tracking back.
- **Delivered status codes** — when an order reaches one of these (canonical: 500, pickup collection), the plugin records the order as delivered/picked-up. A configured delivered code always takes precedence over a shipped code for the same number.
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

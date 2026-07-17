This page is a checklist for confirming the integration actually works — from a boot-time config check through a real test order, webhook, and inventory check — plus the optional live API harness you can run against your own sandbox Ongoing account. For setup itself, see [[User Setup Guide]].

## Non-destructive checks

Run these first. None of them create orders in your live warehouse.

### 1. Boot-time validation

Restart the Medusa app and check the logs. A good config logs:

```
[ongoing] validated N warehouse integration(s)
```

A misconfigured `integrations` array fails startup with a clear `[ongoing] ...` error. If you don't see the success line, fix the config before going further (see [[User Configuration Reference]]).

### 2. Test connection

In **Settings → Ongoing Warehouse**, open Create or Edit and click **Test connection**. On success it shows `Connected — N order statuses available` and lists the real order statuses for that goods owner. This confirms the base URL and credentials work and populates the status-code pickers.

You can also call it directly:

```bash
curl -X POST https://<your-medusa-app>/admin/ongoing/test-connection \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"credential_key": "warehouse-a"}'
```

A `{"success": true, "statuses": [...]}` response means Ongoing is reachable and the credentials work. A `{"success": false, "error": "..."}` response means Ongoing was reachable but the call failed.

### 3. Create an integration against a real stock location

Creating an integration exercises the auto-provisioning workflow end-to-end. Afterward, confirm the "Ongoing Fulfillment" shipping option appears on that location's fulfillment set. Remember to price it (see [[User Setup Guide]]).

## End-to-end test order

This creates a real order in your warehouse — use a sandbox goods owner if you can.

1. Place an order (in the storefront or admin) that uses the Ongoing shipping option.
2. Create a fulfillment for it.
3. On the order detail page, confirm the **Ongoing Warehouse** widget appears with a `sent` badge and an Ongoing order number.
4. Confirm the order actually landed in Ongoing's own UI.

## Webhook verification

Simulate a webhook delivery:

```bash
curl -X POST https://<your-medusa-app>/ongoing/webhooks/<credential_key> \
  -H "X-Auth-Token: <webhookSecret>" \
  -H "Content-Type: application/json" \
  -d '{"goodsOwnerId": <id>, "orderStatus": {"number": <code>, "text": "..."}}'
```

Interpret the result:

- **`401`** — auth is misconfigured (wrong secret, `webhookSecret` unset, or wrong credential key).
- **`400`** — the payload shape is wrong.
- **`200`** — accepted. Check logs and the sync row to confirm it matched a tracked order.

## Inventory sync check

After about one stock-sync interval:

- Confirm the integration's last-stock-sync timestamp and delta cursor advanced.
- Confirm a known SKU's Medusa `stocked_quantity` reflects Ongoing's sellable quantity.
- The dashboard Connection Health panel gives an at-a-glance (but not live) signal.

## Ongoing WMS dashboard check

After some activity, open **Ongoing WMS** and confirm the summary strip and the failed/pending table populate, and that bulk Retry and the order-widget Re-push button work as described in [[User Daily Operation]].

## Live API integration harness (optional, deeper check)

The plugin ships a real test suite that runs against the live Ongoing API. It is the closest thing to an official "do my Ongoing credentials actually work with this plugin" check, and it is safe to run — it never runs in the default `yarn test` or CI, and self-skips entirely unless you opt in.

> **Caution**
> Point the harness at a **sandbox** goods owner. The write path (opt-in) creates a real article and order in the warehouse.

### Setup

From the plugin repo:

```bash
cp .env.integration.example .env.integration
```

Fill in your sandbox values in `.env.integration`:

```bash
ONGOING_LIVE=1
ONGOING_URL=https://api.ongoingsystems.se/<instance>/api/v1
ONGOING_USER=<your-ongoing-user>
ONGOING_PASS=<your-ongoing-password>
ONGOING_GOODS_OWNER=<sandbox-goods-owner-id>
```

`ONGOING_URL` must include `/api/v1`. The read-path tests run only when `ONGOING_LIVE=1`.

### Run

```bash
yarn test:live
```

By default this runs **read-only** checks: it authenticates and fetches order statuses, fetches inventory and validates every row against the real schema (catching upstream API drift), and runs a delta inventory sweep over the last hour.

### Optional deeper runs

- `ONGOING_LIVE_HEAVY=1` — also walks the entire order history via cursor pagination to prove pagination terminates on real data. This can take minutes on a live warehouse.
- `ONGOING_LIVE_WRITES=1` — **mutates the warehouse**: creates a real test article and order, reads it back, then attempts to cancel it. Sandbox only, never production.

## Related pages

- [[User Setup Guide]]
- [[User Daily Operation]]
- [[User Troubleshooting]]
- [[User Configuration Reference]]

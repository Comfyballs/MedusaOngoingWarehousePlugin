This page maps the symptoms you see to their likely cause and a concrete fix. It covers sync states, common failure modes, the edit-blocked state, orphaned syncs, the address-resync script, and what to grep in logs. For the underlying behavior, see [[User How It Works]].

## Read the sync state first

Most problems show up as a sync row's state and error class on the order widget or the dashboard table (see [[User Daily Operation]]).

| State | Meaning | What to do |
|---|---|---|
| `pending` | Push not yet confirmed | Transitional. If it persists, check logs for a crash during push, then run orphan repair (below). |
| `sent` | Pushed, awaiting shipment | Normal. Wait for a shipped status from poll or webhook. |
| `shipped` | Shipment and tracking created | Done. For a pickup order, still watched for the pickup collection (→ `delivered`). |
| `delivered` | Pickup order collected at the pickup point (status 500) | Done. Terminal. |
| `cancelled` | Canceled in Medusa and Ongoing | Done. Terminal. |
| `error` + `retryable` | Transient failure | The retry job will retry automatically with backoff. No action needed unless it dead-letters. |
| `error` + `terminal` | Deterministic failure | Fix the underlying data, then re-push from the order widget. The retry job will **not** touch it. |

## Common failure modes

| Symptom | Likely cause | Class | Fix |
|---|---|---|---|
| Test connection fails; pushes fail immediately | Bad credentials or base URL (wrong user/pass, or `baseUrl` missing `/api/v1`) | terminal | Fix the credentials in `medusa-config.ts` / env vars and restart. Re-run Test connection. |
| Push errors "matched 0 Medusa variants" / "matched N Medusa variants" / "line item has no SKU" | The SKU is missing or not unique across variants | terminal | Give the variant a SKU, or make the SKU unique. Then re-push. |
| Push errors about a missing recipient name, postal code, or country | The shipping address is incomplete | terminal | Complete the order's shipping address, then re-push. |
| Sync stuck in `error` + `retryable`, never resolving | Ongoing is returning 429 or 5xx, or the network is down | retryable | The client auto-retries and the job retries with backoff. If it dead-letters after 5 attempts, investigate Ongoing availability, then re-push. |
| A shipping option won't save with a way-of-delivery error | Malformed `way_of_delivery` / `transporter` on the option's `data` | n/a | Fix the shape (see [[User Configuration Reference]]). This is caught at save time, never at push time. |
| A cancel doesn't take; fulfillment stays active | Order's Ongoing status is not in `cancellable_status_codes` | n/a | Expected — Ongoing is still shipping. This prevents Medusa and Ongoing disagreeing. Cancel is refused deliberately. |
| Push errors "unexpected_body_shape" | A proxy or misconfigured endpoint returned non-JSON on a 200 | terminal | Check `baseUrl` points at the real Ongoing API, not an HTML error page or proxy. |

## Edit-blocked state and how to clear it

A blocked edit shows an orange **Edit blocked** callout on the order widget with a reason:

- **`no_edit_rules`** — the integration has no `edit_sync_rules` (or none for this edit category). This is the default right after creating an integration.
- **`status_unknown`** — no poll or webhook has reported an Ongoing status for this order yet.
- **`status_blocked`** — a status is known, but it is not in the `edit_sync_rules` allow-list for that category.
- **`no_sync_row`** — the Ongoing sync record no longer exists.

To fix:

1. For `no_edit_rules`, configure `edit_sync_rules` on the integration (see [[User Configuration Reference]]).
2. For `status_blocked`, add the relevant status code to the category's allow-list, or wait for the order to reach an allowed status.
3. For `status_unknown`, wait for the next poll or webhook to report a status.

There is no button to manually dismiss the flag. It **clears automatically** on the next successful re-sync for that category — for example, editing the order again once the rules allow it.

## Orphaned syncs and repair

A historical bug could leave a row stuck in `sent` with no Ongoing order id. New installs should not hit this, but if you suspect it (a `sent` row that never ships and has no Ongoing order number in Ongoing), run the repair endpoint:

```bash
curl -X POST https://<your-medusa-app>/admin/ongoing/syncs/repair-orphaned \
  -H "Authorization: Bearer <admin-token>"
```

It flips any such rows to `error` + `retryable` so the normal retry job re-pushes them. It is idempotent and safe to run repeatedly — a second run finds nothing. There is no admin-UI button for this; it is an operations endpoint.

## Resyncing dropped address changes

`src/scripts/resync-dropped-address-changes.ts` is a one-off repair for a fixed historical bug where an address or contact change bundled with another edit could be silently dropped. A fresh install does not need it. If you are recovering data from before the fix, copy the script into your **consuming app's** `src/scripts/` and run:

```bash
npx medusa exec ./src/scripts/resync-dropped-address-changes.ts --since-days=90 --dry-run
```

Drop `--dry-run` to apply. It scans order-change history for candidates and replays the now-fixed handler. It logs a warning per order where the replay was a no-op (a newer event superseded the historic change) — those need manual review.

## Webhook didn't update anything

The webhook route always acks `200`, even when the internal work fails — so Ongoing will **not** redeliver a webhook that failed on the Medusa side. If a webhook did not seem to do anything:

1. Confirm the webhook URL uses the correct credential key and points at `/ongoing/webhooks/<credential_key>`.
2. Confirm the `X-Auth-Token` header equals the integration's `webhookSecret`, and that `webhookSecret` is actually set (an unset secret rejects all requests with `401`).
3. Check application logs for `[ongoing] webhook: ...`.
4. Remember the every-15-minutes poll job is the backstop — status and shipment will catch up even if a webhook was lost.

## What to grep in logs

Every log line is prefixed `[ongoing]` and scoped further:

- `[ongoing] validated N warehouse integration(s)` — config loaded correctly at boot.
- `[ongoing] stock-sync: ...`, `[ongoing] status-poll: ...`, `[ongoing] retry: ...` — the three jobs.
- `[ongoing] webhook: rejected request (auth)` — a `401`; check the secret and token.
- `[ongoing] webhook: ... unparseable payload ...` — a `400`; check the payload shape.
- `[ongoing] order.updated for <id>: ...`, `[ongoing] order.canceled: ...`, `[ongoing] order-edit.confirmed for <id>: ...` — the subscribers.
- `[resync] order <id> flagged as candidate but replay no-op'd ...` — from the address-resync script.

## Related pages

- [[User How It Works]]
- [[User Configuration Reference]]
- [[User Daily Operation]]
- [[User Verification]]

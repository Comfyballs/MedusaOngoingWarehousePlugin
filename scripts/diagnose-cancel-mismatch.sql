-- Diagnostic (issue #109): find fulfillments where Medusa's core
-- `fulfillment.canceled_at` was set while the Ongoing order behind it is NOT
-- actually cancelled at Ongoing.
--
-- Root cause: before this fix, `OngoingFulfillmentProviderService
-- .cancelFulfillment` returned `{ canceled: false, reason: "status_not_cancellable" }`
-- WITHOUT throwing when Ongoing's own status had moved past the integration's
-- `cancellable_status_codes` window. Medusa's core `FulfillmentModuleService
-- .cancelFulfillment` (verified @medusajs/fulfillment 2.16.0,
-- fulfillment-module-service.js:711-728) only inspects throw/no-throw and
-- unconditionally sets `fulfillment.canceled_at` on any non-throwing return —
-- so any fulfillment cancelled BEFORE this fix shipped may still be shipping
-- at Ongoing while Medusa shows it as cancelled.
--
-- This is a DIAGNOSTIC query only — it does not repair anything. A row
-- returned here needs a human to check the order in Ongoing's own UI/API and
-- decide: cancel it there manually, or (if Ongoing already shipped it)
-- correct the Medusa side to reflect that. Do not run an UPDATE off the back
-- of this query without checking Ongoing first — Ongoing is the system of
-- record for shipping state, not Medusa.
--
-- Run against the CONSUMING Medusa app's Postgres database (this plugin repo
-- has no database of its own). Both tables live in that same database:
-- `fulfillment` from `@medusajs/fulfillment`, `ongoing_order_sync` from this
-- plugin's `ongoing` module (see src/modules/ongoing/models/order-sync.ts).
--
--   psql "$DATABASE_URL" -f scripts/diagnose-cancel-mismatch.sql

SELECT
  f.id           AS medusa_fulfillment_id,
  f.canceled_at  AS medusa_canceled_at,
  s.id           AS ongoing_order_sync_id,
  s.ongoing_order_number,
  s.ongoing_order_id,
  s.sync_state   AS ongoing_sync_state,
  s.latest_status_code,
  s.latest_status_text
FROM fulfillment f
JOIN ongoing_order_sync s
  ON s.medusa_fulfillment_id = f.id
WHERE f.canceled_at IS NOT NULL
  AND s.sync_state <> 'cancelled'
ORDER BY f.canceled_at DESC;

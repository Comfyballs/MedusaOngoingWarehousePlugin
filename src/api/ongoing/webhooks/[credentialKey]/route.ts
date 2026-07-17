import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { timingSafeEqual } from "crypto"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import type {
  OngoingCredentials,
  WebhookOrderPayload,
} from "../../../../lib/ongoing/types"
import { dispatchVerifiedShipment } from "./dispatch-shipment"
import { dispatchStatusRefresh } from "./dispatch-status-refresh"
import { dispatchReturnStatus } from "./dispatch-return-status"

// Timing-safe equality. timingSafeEqual throws on unequal-length buffers, so we
// guard byteLength first; an early length-difference return is acceptable here
// (it does not leak the secret, only that the token is the wrong length).
function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(presented, "utf8")
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

function parsePayload(body: unknown): WebhookOrderPayload | null {
  if (!body || typeof body !== "object") {
    return null
  }
  const b = body as Record<string, unknown>
  const status = b.orderStatus as Record<string, unknown> | undefined
  if (
    typeof b.goodsOwnerId !== "number" ||
    !status ||
    typeof status.number !== "number"
  ) {
    return null
  }
  // Only goodsOwnerId and orderStatus.number are contractually required above.
  // tracking/parcels flow into the shipment mapper, which calls .filter() on them —
  // a malformed non-array would throw there and be swallowed as a silent shipment
  // drop. Normalize array-typed fields to undefined when they arrive malformed.
  if (b.tracking !== undefined && !Array.isArray(b.tracking)) {
    delete b.tracking
  }
  if (b.parcels !== undefined && !Array.isArray(b.parcels)) {
    delete b.parcels
  }
  return b as unknown as WebhookOrderPayload
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const credentialKey = req.params.credentialKey
  const ongoing = req.scope.resolve(ONGOING_MODULE) as {
    getCredentials: (key: string) => OngoingCredentials
    listOngoingIntegrations: (filter: {
      credential_key: string
    }) => Promise<Array<{ id: string; shipped_status_codes: number[] | null }>>
  }

  // --- Auth: unknown credentialKey -> uniform 401 ---
  let credentials: OngoingCredentials
  try {
    credentials = ongoing.getCredentials(credentialKey)
  } catch {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Auth: missing webhookSecret -> uniform 401 (force explicit config) ---
  const secret = credentials.webhookSecret
  if (!secret) {
    logger.warn(
      `[ongoing] webhook: rejected request — no webhookSecret configured for "${credentialKey}"`
    )
    res.sendStatus(401)
    return
  }

  // --- Auth: X-Auth-Token timing-safe compare -> uniform 401 ---
  const header = req.headers["x-auth-token"]
  const presented = Array.isArray(header) ? header[0] : header
  if (typeof presented !== "string" || !tokensMatch(secret, presented)) {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Parse body -> 400 on unparseable/malformed (after auth) ---
  const payload = parsePayload(req.body)
  if (!payload) {
    logger.warn(
      `[ongoing] webhook: unparseable payload for "${credentialKey}"`
    )
    res.sendStatus(400)
    return
  }

  // --- Auth (defense in depth): goodsOwnerId must match -> uniform 401 ---
  if (payload.goodsOwnerId !== credentials.goodsOwnerId) {
    logger.warn(`[ongoing] webhook: rejected request (auth)`)
    res.sendStatus(401)
    return
  }

  // --- Status gate: in-band (shipped) statuses run the shipment-sync seam;
  // every other status refreshes latest_status_code so edit/cancel gating is
  // near-real-time rather than poll-interval-stale (R9). Both ack 200.
  //
  // NOTE: the value of the out-of-band branch depends on the webhook being
  // registered in Ongoing for ALL selected status changes, not shipped-only —
  // Ongoing order webhooks fire on any selected status change
  // (https://developer.ongoingwarehouse.com/webhook-order). Register the webhook
  // for the full active-status range the poll job covers.
  // The post-auth path touches the DB (listOngoingIntegrations) and a nullable
  // model column. Wrap it so a transient DB/config error acks 200 instead of a 500:
  // the status-poll job is the reconciliation backstop, and a 5xx would only make
  // Ongoing retry-flood against a transient failure. (Uniform-401 surface is intact
  // — auth already ran above.)
  try {
    const [integration] = await ongoing.listOngoingIntegrations({
      credential_key: credentialKey,
    })

    if (!integration) {
      // Warn (not debug): deleting an integration while Ongoing still delivers is
      // silent data loss at production log levels unless it's visible.
      logger.warn(
        `[ongoing] webhook: no integration bound to "${credentialKey}"; acknowledging no-op — webhook deliveries are being dropped until an integration is configured`
      )
      res.sendStatus(200)
      return
    }

    // --- Return-status: orthogonal to the shipped/out-of-band split below. A
    // return-flagged (isReturn/isReturnParcel) tracking/parcel entry can arrive on a
    // webhook for ANY order status, not just the ones configured as "shipped", so
    // this runs unconditionally instead of living inside either branch. Detects and
    // records via its own idempotent, always-swallowing dispatcher (see
    // dispatch-return-status.ts) — never throws, so it can't affect the ack below.
    await dispatchReturnStatus(req.scope, {
      payload,
      integrationId: integration.id,
      credentialKey,
    })

    const shippedCodes = (integration.shipped_status_codes ?? []) as number[]
    if (shippedCodes.length === 0) {
      logger.warn(
        `[ongoing] webhook: integration "${credentialKey}" has no shipped_status_codes configured; shipment dispatch will never fire until they are set`
      )
    }
    if (!shippedCodes.includes(payload.orderStatus.number)) {
      // Out-of-band status: refresh the sync row's status, then ack 200.
      await dispatchStatusRefresh(req.scope, {
        payload,
        integrationId: integration.id,
        credentialKey,
      })
      res.sendStatus(200)
      return
    }

    // --- In-band: hand off to the #36 shipment-sync seam, then ack 200 ---
    await dispatchVerifiedShipment(req.scope, {
      payload,
      integrationId: integration.id,
      credentialKey,
    })
    res.sendStatus(200)
  } catch (error) {
    logger.error(
      `[ongoing] webhook: post-auth handling failed for "${credentialKey}": ${
        (error as Error).message
      }`
    )
    res.sendStatus(200)
  }
}

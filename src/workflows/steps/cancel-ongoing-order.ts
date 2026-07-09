import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { OngoingApiError } from "../../lib/ongoing/errors"
import { ONGOING_MODULE } from "../../modules/ongoing"
import type OngoingModuleService from "../../modules/ongoing/service"

export type CancelStepInput = {
  ongoingOrderId: number
  credentialKey: string
}

export type CancelStepResult = {
  cancelled: boolean
  swallowed: boolean
}

// Ongoing's DELETE /orders/{id} documents only its 200 shape (openapi v57) — no
// machine-readable error code — and its operational rule is "you can only cancel
// an order if the warehouse has not started working on it". So a terminal 4xx
// from cancelOrder covers TWO very different cases:
//   (a) the order is already cancelled → our desired end-state already holds,
//       so the cancel is an idempotent success and is safe to swallow.
//   (b) any OTHER refusal — order already picked/allocated/shipped, malformed
//       id, auth/permission, contract violation — is a REAL failure. Swallowing
//       it as success writes a false terminal "cancelled" state while Ongoing
//       keeps shipping (#111, residual from CRIT-3).
// The only signal separating (a) from (b) is the human-readable message Ongoing
// returns, so match the "already cancelled" phrasing SPECIFICALLY and default
// everything else to (b) (re-throw → retryFailedSyncs / caller surfaces it).
//
// The match is deliberately tight: `already <been> cancel...`. A looser
// "mentions cancel" test would wrongly swallow "order already shipped and cannot
// be cancelled" — a genuinely-uncancellable order — as a success.
//
// Known residual (accepted): the pattern is substring/positive-match only, so a
// hypothetical negated phrasing that still places "already" directly before
// "cancel" (e.g. "not already cancelled") would false-swallow. There is no
// machine-readable Ongoing error code to key on instead, and no such phrasing is
// known to be emitted; if one appears, tighten here. The inverse miss (a real
// already-cancelled order phrased without the space, e.g. "already-cancelled")
// fails SAFE — it re-throws into retryFailedSyncs rather than corrupting state.
const ALREADY_CANCELLED_RE = /already\s+(?:been\s+)?cancel/i

function messageText(err: OngoingApiError): string {
  const parts: string[] = [err.message]
  const body = err.body
  if (typeof body === "string") {
    parts.push(body)
  } else if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>
    // Ongoing error bodies are undocumented; message casing varies by endpoint.
    const m = rec.message ?? rec.Message ?? rec.error ?? rec.Error
    if (typeof m === "string") {
      parts.push(m)
    }
  }
  return parts.join(" ")
}

export function isAlreadyCancelledError(err: OngoingApiError): boolean {
  return err.kind === "terminal" && ALREADY_CANCELLED_RE.test(messageText(err))
}

export const cancelOngoingOrderHandler = async (
  input: CancelStepInput,
  { container }: { container: MedusaContainer }
): Promise<StepResponse<CancelStepResult>> => {
  const ongoing = container.resolve(ONGOING_MODULE) as OngoingModuleService
  const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
  const client = ongoing.getClient(input.credentialKey)

  try {
    await client.cancelOrder(input.ongoingOrderId)
    logger.info(
      `[ongoing] cancel-ongoing-order: cancelled ongoing_order_id=${input.ongoingOrderId}`
    )
    return new StepResponse({ cancelled: true, swallowed: false })
  } catch (err) {
    if (err instanceof OngoingApiError && isAlreadyCancelledError(err)) {
      // Order is already cancelled at Ongoing: our desired end-state holds, so
      // this is an idempotent success. Any OTHER terminal 4xx (already
      // shipped/picked, bad id, auth) falls through and re-throws below (#111).
      logger.info(
        `[ongoing] cancel-ongoing-order: already cancelled ongoing_order_id=${input.ongoingOrderId}, swallowing`
      )
      return new StepResponse({ cancelled: false, swallowed: true })
    }
    // Log Ongoing's OWN reason (which lives in err.body for a real client
    // error), not just the generic `Ongoing DELETE /orders/{id} failed (4xx)`
    // wrapper — otherwise the exact failure this PR stops swallowing (e.g.
    // "already shipped and cannot be cancelled") is invisible to operators.
    const detail =
      err instanceof OngoingApiError ? messageText(err) : (err as Error).message
    logger.error(
      `[ongoing] cancel-ongoing-order: failed ongoing_order_id=${input.ongoingOrderId} error=${detail}`
    )
    throw err
  }
}

export const cancelOngoingOrderStep = createStep(
  "cancel-ongoing-order",
  cancelOngoingOrderHandler
)

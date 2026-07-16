import { MedusaError } from "@medusajs/framework/utils"
import type { CodeNamePair, PostOrderTransporter } from "./types"

export type OngoingCarrierMapping = {
  wayOfDelivery?: CodeNamePair
  transporter?: PostOrderTransporter
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Reads the optional Ongoing carrier configuration an admin sets on the Ongoing
 * shipping option's `data`. Two accepted shapes:
 *
 *   { way_of_delivery: "dhl-express" }
 *   { way_of_delivery: { code: "dhl-express", name: "DHL Express" },
 *     transporter: { transporterCode: "DHL", transporterServiceCode: "EXP",
 *                    paymentAdvanced: false } }
 *
 * LENIENT: never throws — malformed persisted config yields no mapping so an order
 * still pushes (Ongoing falls back to a manual carrier pick). Config-time
 * validation (throw-on-malformed) is `assertValidOngoingCarrierConfig`, called
 * from the provider's validateFulfillmentData when the shipping option is created.
 */
export function extractOngoingCarrier(data: unknown): OngoingCarrierMapping {
  if (!data || typeof data !== "object") {
    return {}
  }
  const d = data as Record<string, unknown>
  const result: OngoingCarrierMapping = {}

  const wod = d.way_of_delivery
  if (nonEmptyString(wod)) {
    result.wayOfDelivery = { code: wod.trim() }
  } else if (wod && typeof wod === "object") {
    const code = (wod as Record<string, unknown>).code
    if (nonEmptyString(code)) {
      const name = (wod as Record<string, unknown>).name
      result.wayOfDelivery = nonEmptyString(name)
        ? { code: code.trim(), name: name.trim() }
        : { code: code.trim() }
    }
  }

  const tr = d.transporter
  if (tr && typeof tr === "object") {
    const t = tr as Record<string, unknown>
    const transporter: PostOrderTransporter = {}
    if (nonEmptyString(t.transporterCode)) {
      transporter.transporterCode = t.transporterCode.trim()
    }
    if (nonEmptyString(t.transporterServiceCode)) {
      transporter.transporterServiceCode = t.transporterServiceCode.trim()
    }
    if (typeof t.paymentAdvanced === "boolean") {
      transporter.paymentAdvanced = t.paymentAdvanced
    }
    if (Object.keys(transporter).length > 0) {
      result.transporter = transporter
    }
  }

  return result
}

/**
 * STRICT config-time guard: if the shipping option's `data` carries a
 * way_of_delivery/transporter but it is malformed, fail at shipping-option
 * creation (validateFulfillmentData) rather than silently dropping the carrier at
 * order-push time. A missing config is fine (returns without throwing).
 */
export function assertValidOngoingCarrierConfig(data: unknown): void {
  if (!data || typeof data !== "object") {
    return
  }
  const d = data as Record<string, unknown>

  if ("way_of_delivery" in d && d.way_of_delivery != null) {
    const wod = d.way_of_delivery
    const ok =
      nonEmptyString(wod) ||
      (typeof wod === "object" && nonEmptyString((wod as Record<string, unknown>).code))
    if (!ok) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] shipping option "way_of_delivery" must be a non-empty code string ` +
          `or an object with a non-empty "code" (got ${JSON.stringify(wod)})`
      )
    }
  }

  if ("transporter" in d && d.transporter != null) {
    const tr = d.transporter
    if (typeof tr !== "object") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] shipping option "transporter" must be an object with transporterCode / ` +
          `transporterServiceCode / paymentAdvanced (got ${JSON.stringify(tr)})`
      )
    }
    const t = tr as Record<string, unknown>
    // Match the way_of_delivery branch's strictness: a present code that isn't a
    // non-empty string passes here but is silently dropped by the lenient
    // extractOngoingCarrier at push time — catch it at config time instead.
    for (const key of ["transporterCode", "transporterServiceCode"] as const) {
      if (key in t && t[key] != null && !nonEmptyString(t[key])) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `[ongoing] shipping option "transporter.${key}" must be a non-empty string ` +
            `(got ${JSON.stringify(t[key])})`
        )
      }
    }
    if ("paymentAdvanced" in t && t.paymentAdvanced != null && typeof t.paymentAdvanced !== "boolean") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `[ongoing] shipping option "transporter.paymentAdvanced" must be a boolean ` +
          `(got ${JSON.stringify(t.paymentAdvanced)})`
      )
    }
  }
}

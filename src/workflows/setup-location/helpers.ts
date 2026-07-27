import { MedusaError } from "@medusajs/framework/utils"
import {
  ONGOING_SHIPPING_OPTION_NAME,
  ONGOING_SEED_PRICE_AMOUNT,
  ONGOING_SEED_OPTION_TYPE,
} from "./constants"

export type QueriedShippingOption = { id: string; provider_id?: string }
export type QueriedServiceZone = { id: string; shipping_options?: QueriedShippingOption[] }
export type QueriedFulfillmentSet = { id: string; service_zones?: QueriedServiceZone[] }
export type QueriedLocation = {
  id: string
  fulfillment_sets?: QueriedFulfillmentSet[]
}

export type FulfillmentSetMode = "auto" | "reuse" | "create"

export function composeProviderId(identifier: string, optionId: string): string {
  return `${identifier}_${optionId}`
}

export function decideReuse(
  location: QueriedLocation,
  mode: FulfillmentSetMode = "auto"
): {
  reuse: boolean
  fulfillmentSetId?: string
} {
  // "create" forces a new fulfillment set even when one already exists.
  if (mode === "create") {
    return { reuse: false }
  }
  // "auto" (default) and "reuse" both reuse-if-exists, else create.
  const sets = location.fulfillment_sets || []
  if (sets.length > 0) {
    return { reuse: true, fulfillmentSetId: sets[0].id }
  }
  return { reuse: false }
}

// --- setup-location guard helpers (bead 0dc) ---
// These throw a clear MedusaError instead of letting an unguarded [0] index or a
// missing nested field surface as a raw TypeError. They live here (not inline in
// the workflow) because @medusajs/no-throw-in-transform forbids throwing directly
// in a transform() callback — a called helper is the sanctioned pattern.

export type QueriedStockLocation = {
  id: string
  address?: { country_code?: string | null } | null
  fulfillment_sets?: QueriedFulfillmentSet[]
}

export function requireStockLocation(
  location: QueriedStockLocation | undefined,
  stockLocationId: string
): QueriedStockLocation {
  if (!location) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] setup-location: stock location "${stockLocationId}" not found`
    )
  }
  return location
}

export function requireCountryCode(location: QueriedStockLocation): string {
  const code = location.address?.country_code
  if (!code) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `[ongoing] setup-location: stock location "${location.id}" has no address.country_code; set the location address before wiring Ongoing`
    )
  }
  return code
}

export function requireDefaultShippingProfileId(
  profile: { id: string } | undefined
): string {
  if (!profile) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] setup-location: no default shipping profile found; create one before wiring Ongoing`
    )
  }
  return profile.id
}

export function requireServiceZoneId(zone: { id: string } | undefined): string {
  if (!zone) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `[ongoing] setup-location: service zone creation returned no zone`
    )
  }
  return zone.id
}

export function resolveStoreCurrencyCode(
  store:
    | { supported_currencies?: Array<{ currency_code: string; is_default?: boolean }> }
    | undefined
): string {
  if (!store) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] setup-location: no store configured`
    )
  }
  const currencies = store.supported_currencies || []
  const def = currencies.find((c) => c.is_default === true)
  if (def) {
    return def.currency_code
  }
  const first = currencies[0]
  if (!first) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `[ongoing] setup-location: store has no supported currencies; configure at least one before wiring Ongoing`
    )
  }
  return first.currency_code
}

export function extractFulfillmentSetId(location: QueriedLocation): string {
  const sets = location.fulfillment_sets || []
  if (sets.length === 0) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `[ongoing] expected a fulfillment set on location "${location.id}" after creation, found none`
    )
  }
  return sets[0].id
}

// pud slice (a): decide which artifact ids to record on the integration as
// "created by setup". The service zone and shipping options are always created
// by this workflow, so they are always recorded. The fulfillment set is only
// ours when it was NOT reused — a reused set is pre-existing/shared and must be
// preserved by any future cleanup, so we record null for it. Kept as a pure
// helper (not inline in the workflow transform) so the reuse rule is unit-tested.
export function buildCreatedArtifacts(args: {
  reused: boolean
  fulfillmentSetId: string
  serviceZoneId: string
  shippingOptionIds: string[]
}): {
  created_fulfillment_set_id: string | null
  created_service_zone_id: string
  created_shipping_option_ids: string[]
} {
  return {
    created_fulfillment_set_id: args.reused ? null : args.fulfillmentSetId,
    created_service_zone_id: args.serviceZoneId,
    created_shipping_option_ids: args.shippingOptionIds,
  }
}

export function buildServiceZoneInput(args: {
  fulfillmentSetId: string
  countryCode: string
}): {
  data: Array<{
    name: string
    fulfillment_set_id: string
    geo_zones: Array<{ type: "country"; country_code: string }>
  }>
} {
  return {
    data: [
      {
        name: "Ongoing",
        fulfillment_set_id: args.fulfillmentSetId,
        geo_zones: [{ type: "country", country_code: args.countryCode }],
      },
    ],
  }
}

export function buildShippingOptionInput(args: {
  serviceZoneId: string
  shippingProfileId: string
  providerId: string
  currencyCode: string
}): Array<{
  name: string
  service_zone_id: string
  shipping_profile_id: string
  provider_id: string
  price_type: "flat"
  prices: Array<{ currency_code: string; amount: number }>
  type: { label: string; description: string; code: string }
}> {
  return [
    {
      name: ONGOING_SHIPPING_OPTION_NAME,
      service_zone_id: args.serviceZoneId,
      shipping_profile_id: args.shippingProfileId,
      provider_id: args.providerId,
      price_type: "flat",
      prices: [{ currency_code: args.currencyCode, amount: ONGOING_SEED_PRICE_AMOUNT }],
      type: ONGOING_SEED_OPTION_TYPE,
    },
  ]
}

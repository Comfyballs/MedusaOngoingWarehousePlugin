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

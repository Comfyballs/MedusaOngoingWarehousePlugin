import type { FulfillmentOption } from "@medusajs/framework/types"

/**
 * Provider identifier. Medusa derives the runtime provider id as
 * `fp_${identifier}_${config-id}` and a shipping option's provider_id as
 * `${identifier}_${optionId}`. Do NOT rename without migrating shipping options.
 */
export const ONGOING_PROVIDER_ID = "ongoing"

/** Standard outbound shipping option id → provider_id "ongoing_ongoing-standard". */
export const ONGOING_STANDARD_OPTION_ID = "ongoing-standard"

/** Return shipping option id → provider_id "ongoing_ongoing-return". */
export const ONGOING_RETURN_OPTION_ID = "ongoing-return"

/**
 * The single, global option list this provider advertises. getFulfillmentOptions
 * takes no args, so this cannot vary per warehouse (known limitation, spec §5/§13.4);
 * the real Ongoing wayOfDelivery is resolved per-warehouse at order-payload time later.
 */
export const ONGOING_FULFILLMENT_OPTIONS: FulfillmentOption[] = [
  { id: ONGOING_STANDARD_OPTION_ID },
  { id: ONGOING_RETURN_OPTION_ID, is_return: true },
]

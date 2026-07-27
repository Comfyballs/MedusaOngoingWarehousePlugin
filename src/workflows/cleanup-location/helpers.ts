import { MedusaError } from "@medusajs/framework/utils"

// pud slice (b): guarded cleanup of the fulfillment-set / service-zone / shipping-option
// artifacts that setupOngoingLocationWorkflow created for an integration. The guard rules
// (which artifacts are SAFE to delete) live here as pure, unit-tested functions — the
// workflow only wires queries → plan → deletes. Getting these rules wrong risks deleting a
// pre-existing/shared fulfillment set or a shipping option still referenced by a live
// fulfillment, so the decision logic is deliberately isolated and exhaustively tested.

// What setup recorded on the integration as "created by us" (pud slice a). A null
// created_fulfillment_set_id means the set was REUSED (pre-existing/shared) and must never
// be deleted; the service zone and shipping options are always ours when present.
export type CleanupInputArtifacts = {
  created_fulfillment_set_id: string | null
  created_service_zone_id: string | null
  created_shipping_option_ids: string[] | null
}

// Current live state, snapshotted before any deletion. serviceZone / fulfillmentSet are
// null when the recorded artifact no longer exists (already deleted out-of-band) — in that
// case there is nothing to delete and nothing to preserve.
export type CleanupCurrentState = {
  // Shipping-option ids currently referenced by at least one fulfillment (must be kept).
  referencedShippingOptionIds: string[]
  // The created service zone and the shipping-option ids currently living in it.
  serviceZone: { id: string; shippingOptionIds: string[] } | null
  // The created fulfillment set and the service-zone ids currently living in it.
  fulfillmentSet: { id: string; serviceZoneIds: string[] } | null
}

export type PreservedArtifact = {
  kind: "shipping_option" | "service_zone" | "fulfillment_set"
  id: string
  reason: string
}

export type CleanupPlan = {
  shipping_option_ids_to_delete: string[]
  service_zone_ids_to_delete: string[]
  fulfillment_set_ids_to_delete: string[]
  preserved: PreservedArtifact[]
}

export type IntegrationForCleanup = {
  id: string
  stock_location_id: string | null
} & CleanupInputArtifacts

export function requireIntegrationForCleanup(
  row: IntegrationForCleanup | undefined,
  integrationId: string
): IntegrationForCleanup {
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `[ongoing] cleanup-location: integration "${integrationId}" not found`
    )
  }
  return row
}

// Decide which setup artifacts are safe to delete, cascading emptiness upward:
//   shipping options  -> delete created ones that (a) still live in our zone and
//                        (b) are NOT referenced by any existing fulfillment
//   service zone      -> delete the created zone only if it is now empty (nothing left
//                        after removing the options above)
//   fulfillment set   -> delete only if WE created it (id recorded, i.e. not reused) AND
//                        it is now empty after removing the zone above
// Anything that survives a guard is reported in `preserved` with a human reason so the
// caller (slice c admin action) can surface exactly what was left behind and why.
export function buildCleanupPlan(
  artifacts: CleanupInputArtifacts,
  state: CleanupCurrentState
): CleanupPlan {
  const createdOptionIds = artifacts.created_shipping_option_ids ?? []
  const referenced = new Set(state.referencedShippingOptionIds)
  const zoneOptionIds = new Set(state.serviceZone?.shippingOptionIds ?? [])
  const preserved: PreservedArtifact[] = []

  // (1) shipping options
  const optionsToDelete: string[] = []
  for (const id of createdOptionIds) {
    // Skip options that no longer live in our zone (already deleted / moved elsewhere).
    if (!zoneOptionIds.has(id)) {
      continue
    }
    if (referenced.has(id)) {
      preserved.push({
        kind: "shipping_option",
        id,
        reason: "referenced by an existing fulfillment",
      })
      continue
    }
    optionsToDelete.push(id)
  }

  // (2) service zone — only if the recorded zone still exists and ends up empty
  const zoneToDelete: string[] = []
  if (artifacts.created_service_zone_id && state.serviceZone) {
    const deleted = new Set(optionsToDelete)
    const remaining = state.serviceZone.shippingOptionIds.filter((id) => !deleted.has(id))
    if (remaining.length === 0) {
      zoneToDelete.push(state.serviceZone.id)
    } else {
      preserved.push({
        kind: "service_zone",
        id: state.serviceZone.id,
        reason: `still has ${remaining.length} shipping option(s) after cleanup`,
      })
    }
  }

  // (3) fulfillment set — only ours (created_fulfillment_set_id non-null) and now empty.
  // A reused set (created_fulfillment_set_id === null) is never a candidate: skipped
  // entirely, not even reported, because it was pre-existing/shared.
  const setToDelete: string[] = []
  if (artifacts.created_fulfillment_set_id && state.fulfillmentSet) {
    const deleted = new Set(zoneToDelete)
    const remaining = state.fulfillmentSet.serviceZoneIds.filter((id) => !deleted.has(id))
    if (remaining.length === 0) {
      setToDelete.push(state.fulfillmentSet.id)
    } else {
      preserved.push({
        kind: "fulfillment_set",
        id: state.fulfillmentSet.id,
        reason: `still has ${remaining.length} service zone(s) after cleanup`,
      })
    }
  }

  return {
    shipping_option_ids_to_delete: optionsToDelete,
    service_zone_ids_to_delete: zoneToDelete,
    fulfillment_set_ids_to_delete: setToDelete,
    preserved,
  }
}

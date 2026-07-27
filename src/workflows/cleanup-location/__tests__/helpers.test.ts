import {
  buildCleanupPlan,
  requireIntegrationForCleanup,
  type CleanupInputArtifacts,
  type CleanupCurrentState,
} from "../helpers"

const artifacts = (
  over: Partial<CleanupInputArtifacts> = {}
): CleanupInputArtifacts => ({
  created_fulfillment_set_id: "fset_1",
  created_service_zone_id: "sz_1",
  created_shipping_option_ids: ["so_1"],
  ...over,
})

const state = (over: Partial<CleanupCurrentState> = {}): CleanupCurrentState => ({
  referencedShippingOptionIds: [],
  serviceZone: { id: "sz_1", shippingOptionIds: ["so_1"] },
  fulfillmentSet: { id: "fset_1", serviceZoneIds: ["sz_1"] },
  ...over,
})

describe("buildCleanupPlan", () => {
  it("deletes the full cascade when everything is ours, empty, and unreferenced", () => {
    const plan = buildCleanupPlan(artifacts(), state())
    expect(plan.shipping_option_ids_to_delete).toEqual(["so_1"])
    expect(plan.service_zone_ids_to_delete).toEqual(["sz_1"])
    expect(plan.fulfillment_set_ids_to_delete).toEqual(["fset_1"])
    expect(plan.preserved).toEqual([])
  })

  it("preserves a shipping option referenced by an existing fulfillment", () => {
    const plan = buildCleanupPlan(
      artifacts({ created_shipping_option_ids: ["so_1", "so_2"] }),
      state({
        referencedShippingOptionIds: ["so_2"],
        serviceZone: { id: "sz_1", shippingOptionIds: ["so_1", "so_2"] },
      })
    )
    expect(plan.shipping_option_ids_to_delete).toEqual(["so_1"])
    expect(plan.preserved).toContainEqual({
      kind: "shipping_option",
      id: "so_2",
      reason: "referenced by an existing fulfillment",
    })
    // zone still holds the referenced option -> zone (and set) preserved
    expect(plan.service_zone_ids_to_delete).toEqual([])
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
    expect(plan.preserved.map((p) => p.kind)).toEqual([
      "shipping_option",
      "service_zone",
      "fulfillment_set",
    ])
  })

  it("never deletes a reused fulfillment set (created_fulfillment_set_id null), even when empty", () => {
    const plan = buildCleanupPlan(
      artifacts({ created_fulfillment_set_id: null }),
      state({ fulfillmentSet: { id: "fset_shared", serviceZoneIds: ["sz_1"] } })
    )
    expect(plan.shipping_option_ids_to_delete).toEqual(["so_1"])
    expect(plan.service_zone_ids_to_delete).toEqual(["sz_1"])
    // reused set: not deleted, not even reported as preserved
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
    expect(plan.preserved).toEqual([])
  })

  it("preserves the service zone when a non-ours shipping option still lives in it", () => {
    const plan = buildCleanupPlan(
      artifacts(),
      state({ serviceZone: { id: "sz_1", shippingOptionIds: ["so_1", "so_foreign"] } })
    )
    expect(plan.shipping_option_ids_to_delete).toEqual(["so_1"])
    expect(plan.service_zone_ids_to_delete).toEqual([])
    expect(plan.preserved).toContainEqual({
      kind: "service_zone",
      id: "sz_1",
      reason: "still has 1 shipping option(s) after cleanup",
    })
    // zone survives -> set survives too
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
  })

  it("preserves the fulfillment set when another service zone still lives in it", () => {
    const plan = buildCleanupPlan(
      artifacts(),
      state({ fulfillmentSet: { id: "fset_1", serviceZoneIds: ["sz_1", "sz_other"] } })
    )
    expect(plan.service_zone_ids_to_delete).toEqual(["sz_1"])
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
    expect(plan.preserved).toContainEqual({
      kind: "fulfillment_set",
      id: "fset_1",
      reason: "still has 1 service zone(s) after cleanup",
    })
  })

  it("skips a shipping option that no longer lives in our zone (already deleted out-of-band)", () => {
    const plan = buildCleanupPlan(
      artifacts({ created_shipping_option_ids: ["so_1", "so_gone"] }),
      state({ serviceZone: { id: "sz_1", shippingOptionIds: ["so_1"] } })
    )
    // so_gone is neither deleted nor preserved — it's simply not there anymore
    expect(plan.shipping_option_ids_to_delete).toEqual(["so_1"])
    expect(plan.preserved).toEqual([])
    expect(plan.service_zone_ids_to_delete).toEqual(["sz_1"])
  })

  it("treats a missing (null) service zone as nothing to delete or preserve", () => {
    const plan = buildCleanupPlan(
      artifacts({ created_shipping_option_ids: [] }),
      state({ serviceZone: null, fulfillmentSet: { id: "fset_1", serviceZoneIds: [] } })
    )
    expect(plan.shipping_option_ids_to_delete).toEqual([])
    expect(plan.service_zone_ids_to_delete).toEqual([])
    // set now reports no zones -> deletable
    expect(plan.fulfillment_set_ids_to_delete).toEqual(["fset_1"])
    expect(plan.preserved).toEqual([])
  })

  it("preserves the set when it still lists a zone even though our zone row is gone", () => {
    // Inconsistent live state: our recorded service zone was deleted out-of-band, but the
    // set still reports a zone. The guard must NOT delete the set in that case.
    const plan = buildCleanupPlan(
      artifacts({ created_shipping_option_ids: [] }),
      state({ serviceZone: null, fulfillmentSet: { id: "fset_1", serviceZoneIds: ["sz_stale"] } })
    )
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
    expect(plan.preserved).toContainEqual({
      kind: "fulfillment_set",
      id: "fset_1",
      reason: "still has 1 service zone(s) after cleanup",
    })
  })

  it("does not delete the fulfillment set when its recorded row no longer exists", () => {
    const plan = buildCleanupPlan(artifacts(), state({ fulfillmentSet: null }))
    expect(plan.fulfillment_set_ids_to_delete).toEqual([])
  })

  it("handles null created_shipping_option_ids without throwing", () => {
    const plan = buildCleanupPlan(
      artifacts({ created_shipping_option_ids: null }),
      state({ serviceZone: { id: "sz_1", shippingOptionIds: [] } })
    )
    expect(plan.shipping_option_ids_to_delete).toEqual([])
    expect(plan.service_zone_ids_to_delete).toEqual(["sz_1"])
  })
})

describe("requireIntegrationForCleanup", () => {
  it("returns the row when present", () => {
    const row = {
      id: "int_1",
      stock_location_id: "sloc_1",
      created_fulfillment_set_id: null,
      created_service_zone_id: null,
      created_shipping_option_ids: null,
    }
    expect(requireIntegrationForCleanup(row, "int_1")).toBe(row)
  })

  it("throws NOT_FOUND when the row is missing", () => {
    expect(() => requireIntegrationForCleanup(undefined, "int_missing")).toThrow(
      /int_missing.*not found/
    )
  })
})

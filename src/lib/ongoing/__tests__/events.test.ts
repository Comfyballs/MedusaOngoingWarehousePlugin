import { ONGOING_EVENTS } from "../events"

describe("ONGOING_EVENTS", () => {
  it("pins the exact 8 event name strings", () => {
    expect(ONGOING_EVENTS).toEqual({
      ORDER_PUSHED: "ongoing.sync.order_pushed",
      PUSH_FAILED: "ongoing.sync.push_failed",
      SHIPMENT_APPLIED: "ongoing.sync.shipment_applied",
      ORDER_CANCELLED: "ongoing.sync.order_cancelled",
      ORDER_RETRIED: "ongoing.sync.order_retried",
      ORDER_DEAD_LETTERED: "ongoing.sync.order_dead_lettered",
      INVENTORY_SYNCED: "ongoing.sync.inventory_synced",
      EDIT_BLOCKED: "ongoing.sync.edit_blocked",
    })
  })

  it("has unique, non-empty, ongoing.sync.-namespaced values", () => {
    const values = Object.values(ONGOING_EVENTS)
    expect(values.length).toBe(8)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(typeof v).toBe("string")
      expect(v.length).toBeGreaterThan(0)
      expect(v.startsWith("ongoing.sync.")).toBe(true)
    }
  })
})

import { ONGOING_EVENTS } from "../events"

describe("ONGOING_EVENTS", () => {
  it("pins the exact 12 event name strings", () => {
    expect(ONGOING_EVENTS).toEqual({
      ORDER_PUSHED: "ongoing.sync.order_pushed",
      PUSH_FAILED: "ongoing.sync.push_failed",
      SHIPMENT_APPLIED: "ongoing.sync.shipment_applied",
      ORDER_DELIVERED: "ongoing.sync.order_delivered",
      ORDER_CANCELLED: "ongoing.sync.order_cancelled",
      ORDER_RETRIED: "ongoing.sync.order_retried",
      ORDER_DEAD_LETTERED: "ongoing.sync.order_dead_lettered",
      INVENTORY_SYNCED: "ongoing.sync.inventory_synced",
      EDIT_BLOCKED: "ongoing.sync.edit_blocked",
      RETURN_ORDER_PUSHED: "ongoing.sync.return_order_pushed",
      RETURN_ORDER_PUSH_FAILED: "ongoing.sync.return_order_push_failed",
      RETURN_STATUS_RECEIVED: "ongoing.sync.return_status_received",
    })
  })

  it("has unique, non-empty, ongoing.sync.-namespaced values", () => {
    const values = Object.values(ONGOING_EVENTS)
    expect(values.length).toBe(12)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(typeof v).toBe("string")
      expect(v.length).toBeGreaterThan(0)
      expect(v.startsWith("ongoing.sync.")).toBe(true)
    }
  })
})

import type { MedusaContainer } from "@medusajs/framework/types"
import { loadSyncForDeliveryHandler } from "../load-sync-for-delivery"

const invoke = (rows: any[]) => {
  const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows) }
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
  return loadSyncForDeliveryHandler({ ongoing_order_number: "1001-abc" }, { container })
}

describe("loadSyncForDeliveryStep", () => {
  it("skips with no_sync_row when there is no matching row", async () => {
    const res = await invoke([])
    expect(res.output).toEqual({ skip: true, reason: "no_sync_row", needs_shipment: false })
  })

  it("skips with already_delivered (idempotent) when delivered_at is set", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date(), delivered_at: new Date() },
    ])
    expect(res.output).toEqual({
      skip: true,
      reason: "already_delivered",
      needs_shipment: false,
      order_sync_id: "os_1",
    })
  })

  it("proceeds without a shipment backfill for the normal 450 -> 500 path (already shipped)", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date(), delivered_at: null },
    ])
    expect(res.output).toEqual({
      skip: false,
      reason: "ok",
      needs_shipment: false,
      order_sync_id: "os_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
    })
  })

  it("flags needs_shipment when 500 arrives without a prior shipment (missed 450)", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null, delivered_at: null },
    ])
    expect(res.output).toEqual({
      skip: false,
      reason: "ok",
      needs_shipment: true,
      order_sync_id: "os_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
    })
  })

  it("records delivery but skips the shipment backfill when there is no fulfillment id", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null, delivered_at: null },
    ])
    expect(res.output).toEqual({
      skip: false,
      reason: "ok",
      needs_shipment: false,
      order_sync_id: "os_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: undefined,
    })
  })

  it("filters by ongoing_order_number", async () => {
    const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) }
    await loadSyncForDeliveryHandler(
      { ongoing_order_number: "1001-abc" },
      { container: { resolve: () => service } as unknown as MedusaContainer }
    )
    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ ongoing_order_number: "1001-abc" })
  })
})

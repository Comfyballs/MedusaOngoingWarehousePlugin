import { loadSyncForShipmentHandler } from "../load-sync-for-shipment"

const invoke = (rows: any[]) => {
  const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue(rows) }
  const container = { resolve: (_: string) => service }
  return loadSyncForShipmentHandler({ ongoing_order_number: "1001-abc" }, { container })
}

describe("loadSyncForShipmentStep", () => {
  it("skips with no_sync_row when there is no matching row", async () => {
    const res = await invoke([])
    expect(res.output).toEqual({ skip: true, reason: "no_sync_row" })
  })

  it("skips with already_shipped when shipped_at is set", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: new Date() },
    ])
    expect(res.output).toEqual({ skip: true, reason: "already_shipped", order_sync_id: "os_1" })
  })

  it("skips with no_fulfillment_id when medusa_fulfillment_id is null (terminal)", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: null, shipped_at: null },
    ])
    expect(res.output).toEqual({ skip: true, reason: "no_fulfillment_id", order_sync_id: "os_1" })
  })

  it("proceeds with ok and carries the medusa ids forward", async () => {
    const res = await invoke([
      { id: "os_1", medusa_order_id: "order_1", medusa_fulfillment_id: "ful_1", shipped_at: null },
    ])
    expect(res.output).toEqual({
      skip: false,
      reason: "ok",
      order_sync_id: "os_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
    })
  })

  it("filters by ongoing_order_number", async () => {
    const service = { listOngoingOrderSyncs: jest.fn().mockResolvedValue([]) }
    await loadSyncForShipmentHandler({ ongoing_order_number: "1001-abc" }, { container: { resolve: () => service } })
    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith({ ongoing_order_number: "1001-abc" })
  })
})

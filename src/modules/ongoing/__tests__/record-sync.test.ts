import OngoingModuleService from "../service"

const validOptions = {
  integrations: [
    { key: "wh-a", baseUrl: "https://x/api/v1", username: "u", password: "p", goodsOwnerId: 1 },
  ],
}

// Build a service instance with auto-CRUD methods stubbed (no MikroORM / DB).
function makeService() {
  const svc = new OngoingModuleService({} as any, validOptions as any)
  ;(svc as any).listOngoingOrderSyncs = jest.fn()
  ;(svc as any).createOngoingOrderSyncs = jest.fn()
  ;(svc as any).updateOngoingOrderSyncs = jest.fn()
  return svc
}

describe("OngoingModuleService.recordSync", () => {
  it("creates a new row when none exists for the order number", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([])
    ;(svc as any).createOngoingOrderSyncs.mockResolvedValue({ id: "oos_1" })

    const result = await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
      sync_state: "pending",
    })

    expect(result).toEqual({ id: "oos_1" })
    expect((svc as any).createOngoingOrderSyncs).toHaveBeenCalledTimes(1)
    const created = (svc as any).createOngoingOrderSyncs.mock.calls[0][0]
    expect(created).toMatchObject({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      medusa_fulfillment_id: "ful_1",
      sync_state: "pending",
    })
    expect(created.last_synced_at).toBeInstanceOf(Date)
    expect((svc as any).updateOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("updates the existing row (by id) when one already exists", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([{ id: "oos_9" }])
    ;(svc as any).updateOngoingOrderSyncs.mockResolvedValue({ id: "oos_9" })

    const result = await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      sync_state: "sent",
      ongoing_order_id: 999,
    })

    expect(result).toEqual({ id: "oos_9" })
    expect((svc as any).createOngoingOrderSyncs).not.toHaveBeenCalled()
    const update = (svc as any).updateOngoingOrderSyncs.mock.calls[0][0]
    expect(update).toMatchObject({ id: "oos_9", sync_state: "sent", ongoing_order_id: 999 })
    expect(update.last_synced_at).toBeInstanceOf(Date)
  })

  it("records a classified error on failure", async () => {
    const svc = makeService()
    ;(svc as any).listOngoingOrderSyncs.mockResolvedValue([{ id: "oos_3" }])
    ;(svc as any).updateOngoingOrderSyncs.mockResolvedValue({ id: "oos_3" })

    await svc.recordSync({
      ongoing_order_number: "1001-abc",
      integration_id: "int_1",
      medusa_order_id: "order_1",
      sync_state: "error",
      error_class: "retryable",
      last_error: "network down",
    })

    const update = (svc as any).updateOngoingOrderSyncs.mock.calls[0][0]
    expect(update).toMatchObject({
      id: "oos_3",
      sync_state: "error",
      error_class: "retryable",
      last_error: "network down",
    })
  })
})

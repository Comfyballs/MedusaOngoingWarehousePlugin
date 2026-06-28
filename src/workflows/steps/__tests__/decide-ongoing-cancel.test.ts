import { decideOngoingCancelHandler } from "../decide-ongoing-cancel"

// Invoke the step's inner handler directly with a mocked container.
// (@medusajs/framework 2.16.0 does not expose the handler on the step
// function, so the step exports its handler for unit testing.)
const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service }
  return decideOngoingCancelHandler(input, { container })
}

const baseSync = {
  id: "osync_1",
  integration_id: "oint_1",
  ongoing_order_id: 999,
  latest_status_code: 100,
  sync_state: "sent",
  ongoing_order_number: "1001-abc",
}

const integration = {
  id: "oint_1",
  credential_key: "wh-a",
  cancellable_status_codes: [100, 110],
}

const makeService = (overrides: any = {}) => ({
  listOngoingOrderSyncs: jest.fn().mockResolvedValue(overrides.syncs ?? [baseSync]),
  listOngoingIntegrations: jest
    .fn()
    .mockResolvedValue(overrides.integrations ?? [integration]),
})

describe("decideOngoingCancelStep", () => {
  it("decides cancel when status is in cancellable_status_codes", async () => {
    const res = await invoke({ ongoing_order_number: "1001-abc" }, makeService())
    expect(res.output).toEqual({
      shouldCancel: true,
      reason: "ok",
      orderSyncId: "osync_1",
      ongoingOrderId: 999,
      credentialKey: "wh-a",
    })
  })

  it("no-ops when status is not cancellable", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, latest_status_code: 500 }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("status_not_cancellable")
  })

  it("ATTEMPTS the cancel (M2) when latest_status_code is null/unknown", async () => {
    // M2 reality: latest_status_code is NULL until the status-poll milestone.
    // The gate must not skip on null status — it attempts, relying on the
    // DELETE + terminal-4xx swallow (Task 3) for idempotent safety.
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, latest_status_code: null }] })
    )
    expect(res.output.shouldCancel).toBe(true)
    expect(res.output.reason).toBe("status_unknown_attempt")
    expect(res.output).toMatchObject({
      orderSyncId: "osync_1",
      ongoingOrderId: 999,
      credentialKey: "wh-a",
    })
  })

  it("no-ops (idempotent) when sync_state is already cancelled", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, sync_state: "cancelled" }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("already_cancelled")
  })

  it("no-ops when ongoing_order_id is null (push never succeeded)", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ syncs: [{ ...baseSync, ongoing_order_id: null }] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("no_ongoing_order_id")
  })

  it("no-ops when no sync row exists", async () => {
    const res = await invoke(
      { medusa_order_id: "order_unknown" },
      makeService({ syncs: [] })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("no_sync_row")
  })

  it("treats empty/null cancellable_status_codes as nothing-cancellable", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ integrations: [{ ...integration, cancellable_status_codes: null }] })
    )
    expect(res.output.reason).toBe("status_not_cancellable")
  })
})

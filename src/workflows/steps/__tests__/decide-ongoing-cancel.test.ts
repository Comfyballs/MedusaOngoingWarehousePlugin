import type { MedusaContainer } from "@medusajs/framework/types"
import { decideOngoingCancelHandler } from "../decide-ongoing-cancel"

// Invoke the step's inner handler directly with a mocked container.
// (@medusajs/framework 2.16.0 does not expose the handler on the step
// function, so the step exports its handler for unit testing.)
const invoke = (input: any, service: any) => {
  const container = { resolve: (_: string) => service } as unknown as MedusaContainer
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

  it("no-ops when status is not cancellable, carrying an operator reason with the status", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({
        syncs: [{ ...baseSync, latest_status_code: 500, latest_status_text: "Hentet" }],
      })
    )
    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("status_not_cancellable")
    expect(res.output.orderSyncId).toBe("osync_1")
    // eer: the refusal must carry a human-readable reason naming the status so
    // the order widget can surface it to an operator.
    expect(res.output.refusedReason).toContain("500")
    expect(res.output.refusedReason).toContain("Hentet")
    expect(res.output.refusedReason).toContain("cancellable_status_codes")
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

  // lgs: an input carrying none of the three lookup keys must never reach an
  // unfiltered listOngoingOrderSyncs({}) — that would return every sync row (any
  // credential key, any sync_kind) and syncs?.[0] could pick a sync_kind="return"
  // row, the leak class 8p8 closed. The step throws before querying instead.
  it("throws INVALID_DATA (never lists unfiltered) when no lookup key is supplied", async () => {
    const service = makeService()
    await expect(invoke({}, service)).rejects.toThrow(
      /ongoing_order_number.*medusa_fulfillment_id.*medusa_order_id/
    )
    // The guard fires before any DB read — no unfiltered list is ever issued.
    expect(service.listOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("treats empty/null cancellable_status_codes as nothing-cancellable", async () => {
    const res = await invoke(
      { ongoing_order_number: "1001-abc" },
      makeService({ integrations: [{ ...integration, cancellable_status_codes: null }] })
    )
    expect(res.output.reason).toBe("status_not_cancellable")
  })

  // 8p8 return-row leak guard: return pushes now write OngoingOrderSync rows
  // (sync_kind="return") that share the ledger. A cancel must never resolve one —
  // it would DELETE the Ongoing RETURN order and corrupt the return row.
  it("scopes the lookup to sync_kind='order' and no-ops for an order whose only row is a return", async () => {
    const returnRow = {
      ...baseSync,
      id: "osync_return",
      sync_kind: "return",
      medusa_order_id: "order_1",
      ongoing_order_number: "RET-1001",
    }
    // Filter-aware mock (mirrors the DB) so the sync_kind filter actually excludes rows.
    const service = {
      listOngoingOrderSyncs: jest.fn(async (filter: any) => {
        let rows = [returnRow]
        if (filter.sync_kind !== undefined) {
          rows = rows.filter((r) => r.sync_kind === filter.sync_kind)
        }
        return rows
      }),
      listOngoingIntegrations: jest.fn().mockResolvedValue([integration]),
    }

    const res = await invoke({ medusa_order_id: "order_1" }, service)

    expect(res.output.shouldCancel).toBe(false)
    expect(res.output.reason).toBe("no_sync_row")
    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith(
      expect.objectContaining({ sync_kind: "order" })
    )
  })
})

import orderUpdatedHandler from "../order-updated"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../../workflows/mark-order-sync-edit-blocked"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))
jest.mock("../../workflows/mark-order-sync-edit-blocked", () => ({
  markOrderSyncEditBlockedWorkflow: jest.fn(),
}))

const runMock = jest
  .fn()
  .mockResolvedValue({ result: { synced: true, blocked: false, reason: "allowed" } })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

const markBlockedRunMock = jest.fn().mockResolvedValue({ order_sync_id: "oos_1" })
;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })

type GraphCall = { entity: string }

// Real Medusa semantics (#110): registerOrderChange_ inserts ONE order_change row
// per changed field (never one row with multiple actions). `changeRows` models that:
// one entry per row, listed newest-first (created_at DESC) to match the real
// `order: { created_at: "DESC" }` query.
type ChangeRow = { id: string; created_at: string; type: string }

// Builds a container whose query.graph returns:
//  - for entity "order_change": the update_order order_change rows for the burst
//    that fired this event (see ChangeRow above)
//  - for entity "ongoing_integration": the integration with the given edit_sync_rules
function makeContainer(opts: {
  changeRows: ChangeRow[]
  syncRows: Array<{
    id: string
    integration_id: string
    latest_status_code: number | null
    medusa_fulfillment_id: string | null
    edit_blocked_at?: string | Date | null
  }>
  editSyncRules: Record<string, Record<string, number[]>> // integration_id -> { address_contact: number[] }
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const service = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.syncRows),
  }
  const query = {
    graph: jest.fn(async ({ entity }: GraphCall) => {
      if (entity === "order_change") {
        return {
          data: opts.changeRows.map((row) => ({
            id: row.id,
            change_type: "update_order",
            created_at: row.created_at,
            actions: [{ id: `${row.id}_act`, details: { type: row.type } }],
          })),
        }
      }
      if (entity === "ongoing_integration") {
        const integrations = Object.entries(opts.editSyncRules).map(([id, rules]) => ({
          id,
          edit_sync_rules: rules,
        }))
        return { data: integrations }
      }
      return { data: [] }
    }),
  }
  const container = {
    resolve: jest.fn((name: string): any => {
      if (name === "logger") return logger
      if (name === "query") return query
      if (name === "event_bus") return { emit }
      // module id "ongoing"
      return service
    }),
  }
  return { container, logger, emit, service, query }
}

const event = (id: string) => ({ event: { eventName: "order.updated", data: { id } } } as any)

beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
  ;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
})

describe("order.updated subscriber — address/contact re-sync", () => {
  it("re-syncs each sync row with category address_contact when status is allowed", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        order_sync_id: "oos_1",
        category: "address_contact",
      },
    })
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
        order_sync_id: "oos_2",
        category: "address_contact",
      },
    })
  })

  it("re-syncs when an address change is bundled with a locale edit in the same burst (regression #110)", async () => {
    // Newest row (created_at DESC[0]) is "locale" — a pre-fix take:1 query would
    // read only this row, see no address/contact type, and silently skip the
    // real shipping_address change from the same updateOrderWorkflow call.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        order_sync_id: "oos_1",
        category: "address_contact",
      },
    })
  })

  it("re-syncs on an address-only edit with a single order_change row", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("re-syncs when address+metadata+locale are bundled in the same burst", async () => {
    // Newest row is "metadata" — a pre-fix take:1 query would read only this row.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_3", created_at: "2026-06-28T10:00:00.020Z", type: "metadata" },
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("handles a burst of 5 changes (all updateOrderWorkflow fields) and re-syncs once per sync row", async () => {
    // Newest row is "locale" (non-address) — a pre-fix take:1 query would read
    // only this row and never re-sync either sync row.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_5", created_at: "2026-06-28T10:00:00.020Z", type: "locale" },
        { id: "ordch_4", created_at: "2026-06-28T10:00:00.015Z", type: "metadata" },
        { id: "ordch_3", created_at: "2026-06-28T10:00:00.010Z", type: "email" },
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.005Z", type: "billing_address" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    // Exactly once per sync row, not once per changed field.
    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it("ignores an order_change row outside the burst window from a separate earlier edit", async () => {
    // The address change is >2s older than the newest row — a separate, already
    // -handled edit, not part of this event's burst.
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:02.500Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
  })

  it("emits edit_blocked and marks the row when the workflow's own re-gate blocks (post-workflow site)", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // subscriber's own pre-check gate allows
    })

    // Status passes the subscriber's own pre-check gate, but the workflow's
    // internal re-gate (gateOrderEditStep, inside syncOrderEditToOngoing) blocks
    // — e.g. status changed between the subscriber's query and the workflow's own.
    runMock.mockResolvedValueOnce({ result: { synced: false, blocked: true, reason: "status_blocked" } })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 100,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("clears edit-blocked state after a successful re-sync of a previously-blocked row", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    // runMock's default resolves { synced: true, blocked: false } (test file line 14)
    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).toHaveBeenCalledTimes(1)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
  })

  it("does not clear edit-blocked state when the row was not blocked", async () => {
    const { container } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        {
          id: "oos_1",
          integration_id: "int_1",
          latest_status_code: 100,
          medusa_fulfillment_id: "ful_1",
          edit_blocked_at: null,
        },
      ],
      editSyncRules: { int_1: { address_contact: [100, 110] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(markBlockedRunMock).not.toHaveBeenCalled()
  })

  it("no-ops when only metadata/locale changed (no relevant detail type)", async () => {
    const { container } = makeContainer({
      changeRows: [
        { id: "ordch_2", created_at: "2026-06-28T10:00:00.010Z", type: "locale" },
        { id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "metadata" },
      ],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    // Did not even need to load sync rows.
    expect(container.resolve("ongoing").listOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "billing_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 999, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100, 110] } }, // 999 not allowed
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 999,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("blocks and emits a warning when latest_status_code is unknown (null)", async () => {
    // M2 default: latest_status_code is NULL until the status-poll milestone, so
    // the address_contact gate is closed by default. Pin that branch explicitly.
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "email" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: null, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: null,
      },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_unknown" },
    })
  })

  it("blocks and emits a warning when the integration has no address_contact rules", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: {} }, // no address_contact allow-list
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "address_contact",
        latest_status_code: 100,
      },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "address_contact", reason: "status_blocked" },
    })
  })

  it("no-ops when there are no sync rows for the order", async () => {
    const { container, emit } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [],
      editSyncRules: {},
    })

    await orderUpdatedHandler({ ...event("order_1"), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it("isolates a per-row failure and still processes the remaining rows", async () => {
    const { container, logger } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [
        { id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" },
        { id: "oos_2", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_2" },
      ],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    // First row's workflow run blows up; the second must still run.
    runMock.mockRejectedValueOnce(new Error("row boom"))

    await expect(
      orderUpdatedHandler({ ...event("order_1"), container })
    ).resolves.toBeUndefined()

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to process sync oos_1: row boom")
    )
  })

  it("never throws when an internal call fails (logs error instead)", async () => {
    const { container, logger } = makeContainer({
      changeRows: [{ id: "ordch_1", created_at: "2026-06-28T10:00:00.000Z", type: "shipping_address" }],
      syncRows: [{ id: "oos_1", integration_id: "int_1", latest_status_code: 100, medusa_fulfillment_id: "ful_1" }],
      editSyncRules: { int_1: { address_contact: [100] } },
    })

    // Force the query.graph call to blow up.
    const query = container.resolve("query")
    ;(query.graph as jest.Mock).mockRejectedValueOnce(new Error("boom"))

    await expect(
      orderUpdatedHandler({ ...event("order_1"), container })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("order.updated handler failed for order_1: boom")
    )
    expect(runMock).not.toHaveBeenCalled()
  })
})

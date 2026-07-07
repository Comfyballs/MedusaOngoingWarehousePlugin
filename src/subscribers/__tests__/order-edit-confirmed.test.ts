import orderEditConfirmedHandler from "../order-edit-confirmed"
import { syncOrderEditToOngoing } from "../../workflows/sync-order-edit-to-ongoing"
import { markOrderSyncEditBlockedWorkflow } from "../../workflows/mark-order-sync-edit-blocked"

jest.mock("../../workflows/sync-order-edit-to-ongoing", () => ({
  syncOrderEditToOngoing: jest.fn(),
}))
jest.mock("../../workflows/mark-order-sync-edit-blocked", () => ({
  markOrderSyncEditBlockedWorkflow: jest.fn(),
}))

const runMock = jest.fn().mockResolvedValue({ result: {} })
;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })

const markBlockedRunMock = jest.fn().mockResolvedValue({ order_sync_id: "oos_1" })
;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })

// Builds a container whose resolve() returns logger / event_bus / the ongoing
// module service. The service's retrieveOngoingIntegration returns the
// edit_sync_rules keyed by integration id.
function makeContainer(opts: {
  syncRows: Array<{
    id: string
    medusa_fulfillment_id: string | null
    integration_id: string
    latest_status_code: number | null
    edit_blocked_at?: string | Date | null
  }>
  editSyncRules: Record<string, { edit_sync_rules: Record<string, number[]> | null }>
}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const emit = jest.fn().mockResolvedValue(undefined)
  const service = {
    listOngoingOrderSyncs: jest.fn().mockResolvedValue(opts.syncRows),
    retrieveOngoingIntegration: jest.fn(async (id: string) => {
      const found = opts.editSyncRules[id]
      if (!found) {
        throw new Error(`no integration ${id}`)
      }
      return { id, ...found }
    }),
  }
  const container = {
    resolve: jest.fn((name: string) => {
      if (name === "logger") return logger
      if (name === "event_bus") return { emit }
      return service // module id "ongoing"
    }),
  }
  return { container, logger, emit, service }
}

const event = (order_id: string, actionTypes: string[]) =>
  ({
    event: {
      eventName: "order-edit.confirmed",
      data: {
        order_id,
        actions: actionTypes.map((action, i) => ({ id: `act_${i}`, action })),
      },
    },
  } as any)

beforeEach(() => {
  jest.clearAllMocks()
  ;(syncOrderEditToOngoing as unknown as jest.Mock).mockReturnValue({ run: runMock })
  ;(markOrderSyncEditBlockedWorkflow as unknown as jest.Mock).mockReturnValue({ run: markBlockedRunMock })
})

describe("order-edit.confirmed subscriber — line_items re-sync", () => {
  it("re-syncs each sync row with category line_items when status is allowed", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
        { id: "oos_2", medusa_fulfillment_id: "ful_2", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_1",
        order_sync_id: "oos_1",
        category: "line_items",
      },
    })
    expect(runMock).toHaveBeenCalledWith({
      input: {
        medusa_order_id: "order_1",
        medusa_fulfillment_id: "ful_2",
        order_sync_id: "oos_2",
        category: "line_items",
      },
    })
  })

  it("clears edit-blocked state after a successful re-sync of a previously-blocked row", async () => {
    const { container } = makeContainer({
      syncRows: [
        {
          id: "oos_1",
          medusa_fulfillment_id: "ful_1",
          integration_id: "int_1",
          latest_status_code: 100,
          edit_blocked_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    // runMock's default resolves { result: {} } (test file line 12): blocked is
    // falsy, so the handler takes the success path.
    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(markBlockedRunMock).toHaveBeenCalledTimes(1)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: false },
    })
  })

  it("does not clear edit-blocked state when the row was not blocked", async () => {
    const { container } = makeContainer({
      syncRows: [
        {
          id: "oos_1",
          medusa_fulfillment_id: "ful_1",
          integration_id: "int_1",
          latest_status_code: 100,
          edit_blocked_at: null,
        },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(markBlockedRunMock).not.toHaveBeenCalled()
  })

  it("no-ops when actions contain no line-item/shipping change", async () => {
    const { container, service } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    // An action type we do not classify as line_items (defensive filter).
    await orderEditConfirmedHandler({ ...event("order_1", ["SOMETHING_ELSE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    // Short-circuits before loading sync rows.
    expect(service.listOngoingOrderSyncs).not.toHaveBeenCalled()
  })

  it("emits a warning event and does not re-sync when status is blocked", async () => {
    const { container, emit } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 999 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100, 110] } } }, // 999 not allowed
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_ADD"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "line_items",
        latest_status_code: 999,
      },
    })
    expect(markOrderSyncEditBlockedWorkflow).toHaveBeenCalledWith(container)
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_blocked" },
    })
  })

  it("#116: persists edit-blocked state even when the event emit fails, logging an emit failure not a workflow failure", async () => {
    const { container, logger, emit } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 999 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } }, // 999 blocked
    })

    // Event bus is down. The persist is reordered BEFORE the emit and the emit
    // is isolated, so the edit_blocked_* fields must still be written and the
    // failure must be swallowed + logged as an emit failure, never rethrown.
    emit.mockRejectedValueOnce(new Error("bus down"))

    await expect(
      orderEditConfirmedHandler({ ...event("order_1", ["ITEM_ADD"]), container })
    ).resolves.toBeUndefined()

    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_blocked" },
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to emit ongoing.sync.edit_blocked")
    )
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("handler failed")
    )
  })

  it("no-ops when there are no sync rows for the order", async () => {
    const { container, emit } = makeContainer({
      syncRows: [],
      editSyncRules: {},
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_REMOVE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it("never throws when the workflow run fails (logs error instead)", async () => {
    const { container, logger } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    // Force the re-sync workflow to blow up.
    runMock.mockRejectedValueOnce(new Error("boom"))

    await expect(
      orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("order-edit.confirmed handler failed for order_1 (sync oos_1): boom")
    )
  })

  it("isolates a failing row so other rows still re-sync", async () => {
    const { container, logger } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
        { id: "oos_2", medusa_fulfillment_id: "ful_2", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    // First row's re-sync blows up; the second must still run.
    runMock.mockRejectedValueOnce(new Error("boom"))

    await expect(
      orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })
    ).resolves.toBeUndefined()

    expect(runMock).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("order-edit.confirmed handler failed for order_1 (sync oos_1): boom")
    )
  })

  it("emits edit_blocked when the workflow itself returns blocked (no false success)", async () => {
    const { container, emit } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } }, // subscriber-allowed
    })

    // Status passes the subscriber's gate, but the workflow re-gates and blocks.
    runMock.mockResolvedValueOnce({ result: { synced: false, blocked: true, reason: "status_blocked" } })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(emit).toHaveBeenCalledWith({
      name: "ongoing.sync.edit_blocked",
      data: {
        medusa_order_id: "order_1",
        ongoing_order_sync_id: "oos_1",
        category: "line_items",
        latest_status_code: 100,
      },
    })
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_blocked" },
    })
  })

  it("marks edit_blocked with reason 'no_edit_rules' when the integration has no edit_sync_rules at all", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: 100 },
      ],
      editSyncRules: { int_1: { edit_sync_rules: null } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "no_edit_rules" },
    })
  })

  it("marks edit_blocked with reason 'status_unknown' when latest_status_code is null", async () => {
    const { container } = makeContainer({
      syncRows: [
        { id: "oos_1", medusa_fulfillment_id: "ful_1", integration_id: "int_1", latest_status_code: null },
      ],
      editSyncRules: { int_1: { edit_sync_rules: { line_items: [100] } } },
    })

    await orderEditConfirmedHandler({ ...event("order_1", ["ITEM_UPDATE"]), container })

    expect(runMock).not.toHaveBeenCalled()
    expect(markBlockedRunMock).toHaveBeenCalledWith({
      input: { order_sync_id: "oos_1", blocked: true, category: "line_items", reason: "status_unknown" },
    })
  })
})

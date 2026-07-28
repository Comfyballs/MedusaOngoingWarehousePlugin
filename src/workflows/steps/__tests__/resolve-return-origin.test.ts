import type { MedusaContainer } from "@medusajs/framework/types"
import { resolveReturnOriginHandler } from "../resolve-return-origin"

// Invoke the exported handler directly with a mocked container (the createStep
// wrapper does not expose its invoke fn).
const invoke = (input: any, query: any, service: any) => {
  const container = {
    resolve: (key: string) => (key === "query" ? query : service),
  } as unknown as MedusaContainer
  return resolveReturnOriginHandler(input, { container })
}

const orderGraph = (rows: any[] = [{ id: "order_1", display_id: 1001 }]) => ({
  graph: jest.fn().mockResolvedValue({ data: rows }),
})

// A filter-aware listOngoingOrderSyncs mock — mirrors a real DB so a sync_kind
// filter actually excludes non-matching rows (a filter-blind mock could not catch
// the 8p8 return-row leak this suite guards).
const makeService = (allRows: any[]) => ({
  listOngoingOrderSyncs: jest.fn(async (filter: any) => {
    let rows = allRows.filter((r) => r.medusa_order_id === filter.medusa_order_id)
    if (filter.sync_kind !== undefined) {
      rows = rows.filter((r) => r.sync_kind === filter.sync_kind)
    }
    // Emulate the ORDER BY last_synced_at DESC the handler requests.
    return rows
      .slice()
      .sort(
        (a, b) =>
          new Date(b.last_synced_at).getTime() - new Date(a.last_synced_at).getTime()
      )
  }),
})

describe("resolveReturnOriginStep — 8p8 return-row leak guard", () => {
  it("resolves the OUTBOUND order row, not a fresher return row, for a 2nd+ return on the order", async () => {
    // The return row is more recently synced AND sent with a numeric ongoing_order_id
    // — exactly the shape that outranked the real order row before the sync_kind fix.
    const allRows = [
      {
        id: "oos_order",
        medusa_order_id: "order_1",
        sync_kind: "order",
        sync_state: "shipped",
        ongoing_order_id: 999,
        last_synced_at: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "oos_return_prev",
        medusa_order_id: "order_1",
        sync_kind: "return",
        sync_state: "sent",
        ongoing_order_id: 12345, // the PREVIOUS return's Ongoing return-order id
        last_synced_at: "2026-07-25T00:00:00.000Z", // fresher
      },
    ]
    const service = makeService(allRows)

    const out = await invoke({ line_item_id: "li_1" }, orderGraph(), service)

    // Must resolve the original order (999), never the return's id (12345).
    expect(out.ongoing_order_id).toBe(999)
    expect(out.ongoing_order_sync_id).toBe("oos_order")

    // The fix: the ledger lookup is scoped to outbound order rows.
    expect(service.listOngoingOrderSyncs).toHaveBeenCalledWith(
      { medusa_order_id: "order_1", sync_kind: "order" },
      { order: { last_synced_at: "DESC" } }
    )
  })

  it("throws NOT_FOUND when the order has only return rows (no outbound order origin)", async () => {
    const allRows = [
      {
        id: "oos_return_only",
        medusa_order_id: "order_1",
        sync_kind: "return",
        sync_state: "sent",
        ongoing_order_id: 12345,
        last_synced_at: "2026-07-25T00:00:00.000Z",
      },
    ]
    await expect(
      invoke({ line_item_id: "li_1" }, orderGraph(), makeService(allRows))
    ).rejects.toThrow(/no sent\/shipped\/delivered Ongoing order/)
  })

  it("resolves a delivered (picked-up) order as a return origin (bead 18m)", async () => {
    // A pickup order collected at the pickup point advances shipped -> delivered.
    // Returns most often follow delivery, so a `delivered` row must still be an
    // eligible origin (regression guard: it was excluded when only shipped/sent matched).
    const allRows = [
      {
        id: "oos_order",
        medusa_order_id: "order_1",
        sync_kind: "order",
        sync_state: "delivered",
        ongoing_order_id: 777,
        last_synced_at: "2026-07-20T00:00:00.000Z",
      },
    ]
    const out = await invoke({ line_item_id: "li_1" }, orderGraph(), makeService(allRows))
    expect(out.ongoing_order_id).toBe(777)
    expect(out.ongoing_order_sync_id).toBe("oos_order")
  })
})

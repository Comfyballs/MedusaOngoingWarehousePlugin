import type { MedusaContainer } from "@medusajs/framework/types"
import { fetchOngoingInventoryHandler } from "../fetch-ongoing-inventory"
import type { OngoingInventoryRow } from "../../../lib/ongoing/types"

const makeRow = (sku: string): OngoingInventoryRow => ({
  articleNumber: sku,
  numberOfItems: 10,
  allocatedNumberOfItems: 2,
  sellableNumberOfItems: 8,
  toReceiveNumberOfItems: 5,
})

const setup = (rows: OngoingInventoryRow[]) => {
  const getInventory = jest.fn().mockResolvedValue(rows)
  const getClient = jest.fn().mockReturnValue({ getInventory })
  const service = { getClient }
  const container = { resolve: () => service } as unknown as MedusaContainer
  return { getInventory, getClient, container }
}

describe("fetchOngoingInventoryStep", () => {
  it("calls getClient with the credential_key AND goods owner, and returns the rows", async () => {
    const rows = [makeRow("SKU-A"), makeRow("SKU-B")]
    const { container, getClient } = setup(rows)
    const res = await fetchOngoingInventoryHandler({ credential_key: "wh1", goods_owner_id: 7 }, { container })
    expect(getClient).toHaveBeenCalledWith("wh1", 7)
    expect(res.output).toEqual(rows)
  })

  it("returns an empty array when Ongoing has no inventory", async () => {
    const { container } = setup([])
    const res = await fetchOngoingInventoryHandler({ credential_key: "wh1", goods_owner_id: 7 }, { container })
    expect(res.output).toEqual([])
  })

  it("forwards changed_since to getInventory as the stockInfoChangedFrom cursor (bead sw8)", async () => {
    const { container, getInventory } = setup([])
    await fetchOngoingInventoryHandler(
      { credential_key: "wh1", goods_owner_id: 7, changed_since: "2026-07-15T00:00:00.000Z" },
      { container }
    )
    expect(getInventory).toHaveBeenCalledWith(undefined, "2026-07-15T00:00:00.000Z")
  })

  it("passes undefined (full sweep) to getInventory when changed_since is null", async () => {
    const { container, getInventory } = setup([])
    await fetchOngoingInventoryHandler({ credential_key: "wh1", goods_owner_id: 7, changed_since: null }, { container })
    expect(getInventory).toHaveBeenCalledWith(undefined, undefined)
  })
})

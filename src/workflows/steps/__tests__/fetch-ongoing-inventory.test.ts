import { fetchOngoingInventoryHandler } from "../fetch-ongoing-inventory"
import type { OngoingInventoryRow } from "../../../lib/ongoing/types"

const makeRow = (sku: string): OngoingInventoryRow => ({
  articleNumber: sku,
  numberOfItems: 10,
  allocatedNumberOfItems: 2,
  sellableNumberOfItems: 8,
  toReceiveNumberOfItems: 5,
})

const invoke = (rows: OngoingInventoryRow[]) => {
  const getInventory = jest.fn().mockResolvedValue(rows)
  const getClient = jest.fn().mockReturnValue({ getInventory })
  const service = { getClient }
  const container = { resolve: () => service }
  return fetchOngoingInventoryHandler({ credential_key: "wh1" }, { container })
}

describe("fetchOngoingInventoryStep", () => {
  it("calls getClient with the credential_key and returns the rows", async () => {
    const rows = [makeRow("SKU-A"), makeRow("SKU-B")]
    const res = await invoke(rows)
    expect(res.output).toEqual(rows)
  })

  it("returns an empty array when Ongoing has no inventory", async () => {
    const res = await invoke([])
    expect(res.output).toEqual([])
  })
})

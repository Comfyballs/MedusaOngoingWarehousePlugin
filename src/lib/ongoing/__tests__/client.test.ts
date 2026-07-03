import { OngoingClient } from "../client"

describe("OngoingClient.getInventory — pageSize", () => {
  it("passes pageSize=50 on every inventory page request", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      article: { articleNumber: `SKU-${i}`, articleSystemId: i },
      totalItems: {
        NumberOfItemsDecimal: 10,
        AllocatedNumberOfItems: 0,
        SellableNumberOfItems: 10,
        ToReceiveNumberOfItems: 0,
      },
    }))
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(fullPage),
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([]),
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      })
    const client = new OngoingClient(
      { key: "k", baseUrl: "https://api.example.com/api/v1", username: "u", password: "p", goodsOwnerId: 42 },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    await client.getInventory()
    const allUrls: string[] = (fetchImpl as jest.Mock).mock.calls.map(([url]: [string]) => url)
    for (const url of allUrls) {
      expect(url).toContain("pageSize=50")
    }
  })
})

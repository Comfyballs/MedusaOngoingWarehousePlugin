import { ensureArticlesExist } from "../ensure-articles"

const makeClient = () => ({
  putArticle: jest.fn().mockResolvedValue({ articleSystemId: 1 }),
})

describe("ensureArticlesExist", () => {
  it("upserts each SKU sequentially with goodsOwnerId + name", async () => {
    const client = makeClient()
    const ensured = await ensureArticlesExist(client, 7, [
      { articleNumber: "SKU-A", articleName: "Alpha" },
      { articleNumber: "SKU-B", articleName: "Beta" },
    ])
    expect(ensured).toBe(2)
    expect(client.putArticle).toHaveBeenCalledTimes(2)
    expect(client.putArticle).toHaveBeenNthCalledWith(1, {
      goodsOwnerId: 7,
      articleNumber: "SKU-A",
      articleName: "Alpha",
    })
    expect(client.putArticle).toHaveBeenNthCalledWith(2, {
      goodsOwnerId: 7,
      articleNumber: "SKU-B",
      articleName: "Beta",
    })
  })

  it("dedupes repeated SKUs across lines (upserts once)", async () => {
    const client = makeClient()
    const ensured = await ensureArticlesExist(client, 7, [
      { articleNumber: "SKU-A", articleName: "Alpha" },
      { articleNumber: "SKU-A", articleName: "Alpha again" },
    ])
    expect(ensured).toBe(1)
    expect(client.putArticle).toHaveBeenCalledTimes(1)
  })

  it("falls back to the article number when the name is blank", async () => {
    const client = makeClient()
    await ensureArticlesExist(client, 7, [{ articleNumber: "SKU-A", articleName: "  " }])
    expect(client.putArticle).toHaveBeenCalledWith({
      goodsOwnerId: 7,
      articleNumber: "SKU-A",
      articleName: "SKU-A",
    })
  })

  it("skips entries with a blank article number", async () => {
    const client = makeClient()
    const ensured = await ensureArticlesExist(client, 7, [
      { articleNumber: "  ", articleName: "Nameless" },
      { articleNumber: "SKU-A", articleName: "Alpha" },
    ])
    expect(ensured).toBe(1)
    expect(client.putArticle).toHaveBeenCalledTimes(1)
  })

  it("is a no-op for an empty article list", async () => {
    const client = makeClient()
    const ensured = await ensureArticlesExist(client, 7, [])
    expect(ensured).toBe(0)
    expect(client.putArticle).not.toHaveBeenCalled()
  })

  it("propagates a putArticle failure (halts before later SKUs)", async () => {
    const client = {
      putArticle: jest
        .fn()
        .mockResolvedValueOnce({ articleSystemId: 1 })
        .mockRejectedValueOnce(new Error("boom")),
    }
    await expect(
      ensureArticlesExist(client, 7, [
        { articleNumber: "SKU-A", articleName: "Alpha" },
        { articleNumber: "SKU-B", articleName: "Beta" },
        { articleNumber: "SKU-C", articleName: "Gamma" },
      ])
    ).rejects.toThrow("boom")
    expect(client.putArticle).toHaveBeenCalledTimes(2)
  })
})

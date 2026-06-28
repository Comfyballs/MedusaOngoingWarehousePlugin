import { resolveArticleNumber, type ArticleNumberQuery } from "../resolve-article-number"
import { OngoingApiError } from "../errors"

// Build a fake `query` whose graph() returns the given variant rows.
const queryReturning = (rows: Array<{ id: string; sku: string }>): ArticleNumberQuery => ({
  graph: jest.fn().mockResolvedValue({ data: rows }),
})

describe("resolveArticleNumber", () => {
  it("returns the SKU as articleNumber when exactly one variant matches", async () => {
    const query = queryReturning([{ id: "variant_1", sku: "ABC-123" }])

    await expect(resolveArticleNumber(query, "ABC-123")).resolves.toBe("ABC-123")

    expect(query.graph).toHaveBeenCalledWith({
      entity: "product_variant",
      fields: ["id", "sku"],
      filters: { sku: "ABC-123" },
    })
  })

  it("throws a terminal OngoingApiError naming the SKU and count when >1 variant matches", async () => {
    const query = queryReturning([
      { id: "variant_1", sku: "DUP-9" },
      { id: "variant_2", sku: "DUP-9" },
    ])

    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toMatchObject({
      kind: "terminal",
    })
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toBeInstanceOf(OngoingApiError)
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toThrow(/DUP-9/)
    await expect(resolveArticleNumber(query, "DUP-9")).rejects.toThrow(/2/)
  })

  it("throws a terminal OngoingApiError naming the SKU when 0 variants match", async () => {
    const query = queryReturning([])

    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toMatchObject({
      kind: "terminal",
    })
    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toThrow(/MISSING-1/)
    await expect(resolveArticleNumber(query, "MISSING-1")).rejects.toThrow(/0/)
  })

  it("throws a terminal OngoingApiError without querying when the SKU is blank", async () => {
    const query = queryReturning([{ id: "variant_1", sku: "" }])

    await expect(resolveArticleNumber(query, "")).rejects.toMatchObject({ kind: "terminal" })
    expect(query.graph).not.toHaveBeenCalled()
  })

  it("classifies the thrown error so it maps to OngoingOrderSync.error_class 'terminal'", async () => {
    const query = queryReturning([])

    try {
      await resolveArticleNumber(query, "X")
      throw new Error("expected resolveArticleNumber to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(OngoingApiError)
      // recordSync writes error_class = err.kind for an OngoingApiError; assert the value the
      // OngoingOrderSync.error_class enum (["retryable","terminal"]) will receive.
      expect((err as OngoingApiError).kind).toBe("terminal")
    }
  })
})

import type { PostArticleModel } from "./types"

export type EnsureArticleInput = {
  articleNumber: string
  articleName: string
}

// Minimal client surface the ensure step needs (keeps this helper unit-testable
// with a stub and decoupled from the full OngoingClient).
export type ArticleUpsertClient = {
  putArticle: (article: PostArticleModel) => Promise<{ articleSystemId?: number }>
}

/**
 * Step 1 of Ongoing's webshop flow (ProcessArticle): upsert each order SKU as an
 * Ongoing article (PUT /articles) BEFORE the order PUT, so an order never
 * references an unknown articleNumber (which would fail or depend on goods-owner
 * auto-create config).
 *
 * SEQUENTIAL by design: Ongoing processes writes sequentially per goods owner and
 * recommends serial calls (https://developer.ongoingwarehouse.com/parallel-requests)
 * — excess parallelism just causes timeouts. Duplicate SKUs across order lines are
 * upserted once. Any failure propagates as the client's classified OngoingApiError
 * so the caller's record-then-retry ledger handles it exactly like a failed putOrder.
 */
export async function ensureArticlesExist(
  client: ArticleUpsertClient,
  goodsOwnerId: number,
  articles: EnsureArticleInput[],
  logger?: { debug?: (message: string) => void }
): Promise<number> {
  const seen = new Set<string>()
  let ensured = 0
  for (const article of articles) {
    const articleNumber = article.articleNumber?.trim()
    if (!articleNumber || seen.has(articleNumber)) {
      continue
    }
    seen.add(articleNumber)
    const articleName =
      typeof article.articleName === "string" && article.articleName.trim().length > 0
        ? article.articleName.trim()
        : articleNumber
    await client.putArticle({ goodsOwnerId, articleNumber, articleName })
    ensured++
  }
  logger?.debug?.(`[ongoing] ensured ${ensured} article(s) exist before order push`)
  return ensured
}

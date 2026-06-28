import { OngoingApiError } from "./errors"

/**
 * Narrow structural shape of Medusa's `query` object — only the `graph` call this
 * resolver makes. Medusa's RemoteQueryFunction is structurally assignable to this,
 * so consumers pass `container.resolve("query")` / `req.scope.resolve("query")` directly.
 */
export type ArticleNumberQuery = {
  graph<T = unknown>(config: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }): Promise<{ data: T[] }>
}

type VariantRow = { id: string; sku: string | null }

/**
 * Resolve a Medusa variant SKU to an Ongoing articleNumber.
 *
 * Ongoing's articleNumber is the Medusa SKU (article push is deferred — spec §1/§13),
 * so a unique resolution simply returns the SKU. SKU is NOT unique across Medusa
 * variants, so this looks the SKU up across ALL variants and requires exactly one
 * match. Any non-unique (count > 1) or unresolvable (count 0, or blank SKU) result is
 * a TERMINAL error (spec §11): we surface it to the operator rather than guess.
 *
 * The thrown OngoingApiError carries `kind: "terminal"`, which the sync recorder maps
 * onto OngoingOrderSync.error_class = "terminal" for the order widget / dashboard.
 *
 * NOTE (future toggle): the "require unique SKU" assumption is hard-coded for now. A
 * per-integration opt-out (e.g. pick the first match) could later be added as a column
 * on OngoingIntegration; intentionally NOT built in this milestone.
 *
 * @param query Medusa `query` (or any object structurally matching {@link ArticleNumberQuery}).
 * @param sku   The Medusa variant SKU to resolve.
 * @returns The SKU verbatim as the Ongoing articleNumber when exactly one variant matches.
 * @throws {OngoingApiError} with `kind: "terminal"` when the SKU is blank, matches 0,
 *   or matches more than 1 Medusa variant.
 */
export async function resolveArticleNumber(
  query: ArticleNumberQuery,
  sku: string
): Promise<string> {
  if (!sku) {
    throw new OngoingApiError(
      "[ongoing] cannot resolve an Ongoing articleNumber: the line item has no SKU. " +
        "Set a SKU on the Medusa variant before fulfilling through Ongoing.",
      { kind: "terminal" }
    )
  }

  const { data } = await query.graph<VariantRow>({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { sku },
  })

  const count = data.length

  if (count === 1) {
    return sku
  }

  if (count === 0) {
    throw new OngoingApiError(
      `[ongoing] SKU "${sku}" matched 0 Medusa variants — cannot resolve an Ongoing ` +
        `articleNumber. Ensure a product variant with this SKU exists.`,
      { kind: "terminal" }
    )
  }

  throw new OngoingApiError(
    `[ongoing] SKU "${sku}" matched ${count} Medusa variants — it must be unique to ` +
      `resolve an Ongoing articleNumber. Make the SKU unique across variants, then retry.`,
    { kind: "terminal" }
  )
}

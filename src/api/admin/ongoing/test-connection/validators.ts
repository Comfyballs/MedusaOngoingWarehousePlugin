import { MedusaError } from "@medusajs/framework/utils"

export type TestConnectionInput = {
  credential_key: string
  goods_owner_id: number
}

export function validateTestConnectionInput(body: unknown): TestConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.credential_key !== "string" || b.credential_key.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] credential_key is required")
  }
  // The credentials alone no longer identify a warehouse — one Ongoing account can
  // serve several goods owners (bead 9y2.9) — so a connection test has to say which
  // one it is testing, and every Ongoing read call is scoped by it.
  const goodsOwnerId = Number(b.goods_owner_id)
  if (!Number.isInteger(goodsOwnerId) || goodsOwnerId <= 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "[ongoing] goods_owner_id is required and must be a positive integer"
    )
  }
  return { credential_key: b.credential_key, goods_owner_id: goodsOwnerId }
}

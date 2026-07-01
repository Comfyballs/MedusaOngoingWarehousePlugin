import { MedusaError } from "@medusajs/framework/utils"

export type TestConnectionInput = {
  credential_key: string
}

export function validateTestConnectionInput(body: unknown): TestConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.credential_key !== "string" || b.credential_key.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "[ongoing] credential_key is required")
  }
  return { credential_key: b.credential_key }
}

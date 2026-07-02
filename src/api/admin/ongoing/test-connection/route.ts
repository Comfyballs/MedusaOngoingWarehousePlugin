import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"
import { validateTestConnectionInput } from "./validators"

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { credential_key } = validateTestConnectionInput(req.body)
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService

  // Throws MedusaError(INVALID_DATA) for an unknown credential_key — intentionally
  // NOT caught here; that is a bad request, distinct from a reachable-but-failing
  // Ongoing API call below.
  const client = ongoing.getClient(credential_key)

  try {
    const statuses = await client.getOrderStatuses()
    res.json({ success: true, statuses })
  } catch (err) {
    res.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
  }
}

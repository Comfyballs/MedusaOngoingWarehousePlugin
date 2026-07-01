import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ONGOING_MODULE } from "../../../../modules/ongoing"
import OngoingModuleService from "../../../../modules/ongoing/service"

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const ongoing = req.scope.resolve(ONGOING_MODULE) as OngoingModuleService
  const credential_keys = ongoing.listCredentialKeys()
  res.json({ credential_keys })
}

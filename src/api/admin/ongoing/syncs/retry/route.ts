import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { retryOngoingSyncsWorkflow } from "../../../../../workflows"

type RetryOngoingSyncsBody = { sync_ids?: unknown }

function assertValidSyncIds(body: RetryOngoingSyncsBody): asserts body is { sync_ids: string[] } {
  const { sync_ids } = body
  if (
    !Array.isArray(sync_ids) ||
    sync_ids.length === 0 ||
    sync_ids.some((id) => typeof id !== "string")
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "sync_ids must be a non-empty array of strings"
    )
  }
}

export async function POST(
  req: MedusaRequest<RetryOngoingSyncsBody>,
  res: MedusaResponse
): Promise<void> {
  const body = req.body as RetryOngoingSyncsBody
  assertValidSyncIds(body)

  const { result } = await retryOngoingSyncsWorkflow(req.scope).run({
    input: { sync_ids: body.sync_ids },
  })

  res.status(200).json(result)
}

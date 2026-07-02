import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Drawer, Button, toast } from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import { parseCodesCsv, parseEditSyncRulesJson } from "./utils/parse-codes"
import {
  EMPTY_FORM,
  IntegrationFormFields,
  toFormState,
  type FormState,
  type OngoingIntegration,
} from "./integration-form-fields"

export type { OngoingIntegration }

type Props = {
  integration: OngoingIntegration | null
  onClose: () => void
}

// Side-panel Drawer for editing an existing integration — per the
// admin-dashboard skill's "FocusModal for creating, Drawer for editing" rule.
// See CreateIntegrationModal for the create counterpart; both share
// IntegrationFormFields for the field list itself. credential_key and
// stock_location_id are immutable after creation, so this component never
// fetches the credential-keys/stock-locations lists CreateIntegrationModal
// needs for its Selects — IntegrationFormFields renders both as disabled
// Inputs whenever isEdit is true.
export function EditIntegrationDrawer({ integration, onClose }: Props) {
  const open = integration !== null
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    if (integration) {
      setForm(toFormState(integration))
    }
    setError(null)
    setTestResult(null)
  }, [integration])

  const testConnection = useMutation({
    mutationFn: (credential_key: string) =>
      sdk.client.fetch<{
        success: boolean
        statuses?: { number: number; text: string }[]
        error?: string
      }>("/admin/ongoing/test-connection", { method: "POST", body: { credential_key } }),
    onSuccess: (result) => {
      if (result.success) {
        setTestResult(`Connected — ${result.statuses?.length ?? 0} order statuses available`)
        toast.success("Connection successful")
      } else {
        setTestResult(`Failed: ${result.error}`)
        toast.error(result.error ?? "Connection failed")
      }
    },
    onError: (err: Error) => {
      setTestResult(`Failed: ${err.message}`)
      toast.error(err.message)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch(`/admin/ongoing/integrations/${integration?.id}`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
      toast.success("Integration updated")
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const handleSubmit = () => {
    setError(null)
    let shipped_status_codes: number[] | null
    let cancellable_status_codes: number[] | null
    let edit_sync_rules: Record<string, unknown> | null
    try {
      shipped_status_codes = parseCodesCsv(form.shipped_status_codes_csv)
      cancellable_status_codes = parseCodesCsv(form.cancellable_status_codes_csv)
      edit_sync_rules = parseEditSyncRulesJson(form.edit_sync_rules_json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid input")
      return
    }

    updateMutation.mutate({
      enabled: form.enabled,
      stock_sync_enabled: form.stock_sync_enabled,
      stock_sync_interval: form.stock_sync_interval || null,
      status_poll_interval: form.status_poll_interval || null,
      stock_reconcile_mode: form.stock_reconcile_mode,
      edit_sync_rules,
      shipped_status_codes,
      cancellable_status_codes,
    })
  }

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Edit integration</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex-1 overflow-auto p-4">
          <IntegrationFormFields
            form={form}
            setForm={setForm}
            isEdit
            testConnection={testConnection}
            testResult={testResult}
            error={error}
          />
        </Drawer.Body>
        <Drawer.Footer>
          <div className="flex items-center justify-end gap-x-2">
            <Drawer.Close asChild>
              <Button size="small" variant="secondary" disabled={updateMutation.isPending}>
                Cancel
              </Button>
            </Drawer.Close>
            <Button size="small" onClick={handleSubmit} isLoading={updateMutation.isPending}>
              Save
            </Button>
          </div>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

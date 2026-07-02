import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FocusModal, Button, toast } from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import { parseEditSyncRulesJson } from "./utils/parse-codes"
import { EMPTY_FORM, IntegrationFormFields, type FormState } from "./integration-form-fields"

type Props = {
  open: boolean
  onClose: () => void
}

// Full-screen FocusModal for creating a new integration — per the admin-dashboard
// skill's "FocusModal for creating, Drawer for editing" rule. See
// EditIntegrationDrawer for the edit counterpart; both share
// IntegrationFormFields for the field list itself.
export function CreateIntegrationModal({ open, onClose }: Props) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM)
      setError(null)
      setTestResult(null)
      // Reset the previous open session's fetched statuses/credential key so a
      // stale status list from a prior credential key never lingers into a new
      // create session — this modal instance persists across opens with no `key`.
      testConnection.reset()
    }
  }, [open])

  // Modal-only data (credential keys, stock locations) — gated on the modal
  // being open, per the separate display/modal query pattern. Neither has a
  // display-query counterpart on this page.
  const { data: credentialKeysData } = useQuery({
    queryFn: () => sdk.client.fetch<{ credential_keys: string[] }>("/admin/ongoing/credential-keys"),
    queryKey: ["ongoing-credential-keys"],
    enabled: open,
  })

  const { data: stockLocationsData } = useQuery({
    queryFn: () => sdk.admin.stockLocation.list({ limit: 100 }),
    queryKey: ["ongoing-stock-locations-for-create"],
    enabled: open,
  })

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

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch("/admin/ongoing/integrations", { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ongoing-integrations"] })
      toast.success("Integration created")
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const handleSubmit = () => {
    setError(null)
    let edit_sync_rules: Record<string, unknown> | null
    try {
      edit_sync_rules = parseEditSyncRulesJson(form.edit_sync_rules_json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid input")
      return
    }

    createMutation.mutate({
      credential_key: form.credential_key,
      stock_location_id: form.stock_location_id,
      enabled: form.enabled,
      stock_sync_enabled: form.stock_sync_enabled,
      stock_sync_interval: form.stock_sync_interval || null,
      status_poll_interval: form.status_poll_interval || null,
      stock_reconcile_mode: form.stock_reconcile_mode,
      edit_sync_rules,
      shipped_status_codes: form.shipped_status_codes,
      cancellable_status_codes: form.cancellable_status_codes,
    })
  }

  return (
    <FocusModal open={open} onOpenChange={(next) => !next && onClose()}>
      <FocusModal.Content>
        <div className="flex h-full flex-col overflow-hidden">
          <FocusModal.Header>
            <FocusModal.Title>Create integration</FocusModal.Title>
          </FocusModal.Header>
          <FocusModal.Body className="flex-1 overflow-auto p-4">
            <IntegrationFormFields
              form={form}
              setForm={setForm}
              isEdit={false}
              credentialKeysData={credentialKeysData}
              stockLocationsData={stockLocationsData}
              testConnection={testConnection}
              testResult={testResult}
              error={error}
            />
          </FocusModal.Body>
          <FocusModal.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <FocusModal.Close asChild>
                <Button size="small" variant="secondary" disabled={createMutation.isPending}>
                  Cancel
                </Button>
              </FocusModal.Close>
              <Button size="small" onClick={handleSubmit} isLoading={createMutation.isPending}>
                Save
              </Button>
            </div>
          </FocusModal.Footer>
        </div>
      </FocusModal.Content>
    </FocusModal>
  )
}

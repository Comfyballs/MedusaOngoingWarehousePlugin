import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Drawer, Button, Input, Label, Select, Switch, Textarea, Text, toast } from "@medusajs/ui"
import { sdk } from "../../../lib/sdk"
import { parseCodesCsv, parseEditSyncRulesJson } from "./utils/parse-codes"

export type StockReconcileMode = "sellable_plus_reserved" | "precise" | "onhand"

export type OngoingIntegration = {
  id: string
  credential_key: string
  enabled: boolean
  stock_location_id: string
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

type FormState = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string
  status_poll_interval: string
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules_json: string
  shipped_status_codes_csv: string
  cancellable_status_codes_csv: string
}

const EMPTY_FORM: FormState = {
  credential_key: "",
  stock_location_id: "",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "",
  status_poll_interval: "",
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules_json: "",
  shipped_status_codes_csv: "",
  cancellable_status_codes_csv: "",
}

function toFormState(integration: OngoingIntegration): FormState {
  return {
    credential_key: integration.credential_key,
    stock_location_id: integration.stock_location_id,
    enabled: integration.enabled,
    stock_sync_enabled: integration.stock_sync_enabled,
    stock_sync_interval: integration.stock_sync_interval ?? "",
    status_poll_interval: integration.status_poll_interval ?? "",
    stock_reconcile_mode: integration.stock_reconcile_mode,
    edit_sync_rules_json: integration.edit_sync_rules
      ? JSON.stringify(integration.edit_sync_rules, null, 2)
      : "",
    shipped_status_codes_csv: (integration.shipped_status_codes ?? []).join(", "),
    cancellable_status_codes_csv: (integration.cancellable_status_codes ?? []).join(", "),
  }
}

type Props = {
  mode: "create" | "edit" | null
  integration: OngoingIntegration | null
  onClose: () => void
}

export function IntegrationDrawer({ mode, integration, onClose }: Props) {
  const open = mode !== null
  const isEdit = mode === "edit"
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    if (mode === "edit" && integration) {
      setForm(toFormState(integration))
    } else if (mode === "create") {
      setForm(EMPTY_FORM)
    }
    setError(null)
    setTestResult(null)
  }, [mode, integration])

  // Modal-only data (credential keys, stock locations) — gated on the Drawer
  // being open, per the separate display/modal query pattern. Neither has a
  // display-query counterpart on this page.
  const { data: credentialKeysData } = useQuery({
    queryFn: () => sdk.client.fetch<{ credential_keys: string[] }>("/admin/ongoing/credential-keys"),
    queryKey: ["ongoing-credential-keys"],
    enabled: open,
  })

  const { data: stockLocationsData } = useQuery({
    queryFn: () => sdk.admin.stockLocation.list({ limit: 100 }),
    queryKey: ["ongoing-stock-locations-for-drawer"],
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

    const shared = {
      enabled: form.enabled,
      stock_sync_enabled: form.stock_sync_enabled,
      stock_sync_interval: form.stock_sync_interval || null,
      status_poll_interval: form.status_poll_interval || null,
      stock_reconcile_mode: form.stock_reconcile_mode,
      edit_sync_rules,
      shipped_status_codes,
      cancellable_status_codes,
    }

    if (isEdit) {
      updateMutation.mutate(shared)
    } else {
      createMutation.mutate({
        ...shared,
        credential_key: form.credential_key,
        stock_location_id: form.stock_location_id,
      })
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{isEdit ? "Edit integration" : "Create integration"}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex-1 overflow-auto flex flex-col gap-y-4 p-4">
          <div className="flex flex-col gap-y-2">
            <Label>Credential key</Label>
            {isEdit ? (
              <Input value={form.credential_key} disabled />
            ) : (
              <Select
                value={form.credential_key}
                onValueChange={(value) => setForm({ ...form, credential_key: value })}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select a credential key" />
                </Select.Trigger>
                <Select.Content>
                  {(credentialKeysData?.credential_keys ?? []).map((key) => (
                    <Select.Item key={key} value={key}>
                      {key}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock location</Label>
            {isEdit ? (
              <Input value={form.stock_location_id} disabled />
            ) : (
              <Select
                value={form.stock_location_id}
                onValueChange={(value) => setForm({ ...form, stock_location_id: value })}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select a stock location" />
                </Select.Trigger>
                <Select.Content>
                  {(stockLocationsData?.stock_locations ?? []).map((loc) => (
                    <Select.Item key={loc.id} value={loc.id}>
                      {loc.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
            {!isEdit && (
              <Text size="small" className="text-ui-fg-subtle">
                Assigning a stock location runs setup automatically (fulfillment set, service
                zone, shipping option) and cannot be changed after the integration is created.
              </Text>
            )}
          </div>

          <div className="flex items-center justify-between">
            <Label>Enabled</Label>
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <Label>Stock sync enabled</Label>
            <Switch
              checked={form.stock_sync_enabled}
              onCheckedChange={(checked) => setForm({ ...form, stock_sync_enabled: checked })}
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock sync interval (ms)</Label>
            <Input
              value={form.stock_sync_interval}
              onChange={(e) => setForm({ ...form, stock_sync_interval: e.target.value })}
              placeholder="e.g. 300000"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Status poll interval (ms)</Label>
            <Input
              value={form.status_poll_interval}
              onChange={(e) => setForm({ ...form, status_poll_interval: e.target.value })}
              placeholder="e.g. 60000"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Stock reconcile mode</Label>
            <Select
              value={form.stock_reconcile_mode}
              onValueChange={(value) =>
                setForm({ ...form, stock_reconcile_mode: value as StockReconcileMode })
              }
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="sellable_plus_reserved">sellable_plus_reserved</Select.Item>
                <Select.Item value="precise">precise</Select.Item>
                <Select.Item value="onhand">onhand</Select.Item>
              </Select.Content>
            </Select>
          </div>

          {/* MVP editor: raw JSON. Out of scope for #40/#41 to build a structured
              rule builder. */}
          <div className="flex flex-col gap-y-2">
            <Label>Edit sync rules (JSON)</Label>
            <Textarea
              rows={6}
              value={form.edit_sync_rules_json}
              onChange={(e) => setForm({ ...form, edit_sync_rules_json: e.target.value })}
              placeholder='{"address": "resync", "line_items": "cancel_and_recreate"}'
            />
          </div>

          {/* Basic comma/space-separated input for MVP. #41 (blocked by #40) upgrades
              these two fields to a StatusCodePicker fed by this Drawer's own
              POST /admin/ongoing/test-connection statuses. */}
          <div className="flex flex-col gap-y-2">
            <Label>Shipped status codes</Label>
            <Input
              value={form.shipped_status_codes_csv}
              onChange={(e) => setForm({ ...form, shipped_status_codes_csv: e.target.value })}
              placeholder="e.g. 300, 320"
            />
          </div>

          <div className="flex flex-col gap-y-2">
            <Label>Cancellable status codes</Label>
            <Input
              value={form.cancellable_status_codes_csv}
              onChange={(e) => setForm({ ...form, cancellable_status_codes_csv: e.target.value })}
              placeholder="e.g. 100, 110"
            />
          </div>

          <div className="flex flex-col gap-y-2 border-t pt-4">
            <Button
              size="small"
              variant="secondary"
              disabled={!form.credential_key || testConnection.isPending}
              isLoading={testConnection.isPending}
              onClick={() => testConnection.mutate(form.credential_key)}
            >
              Test connection
            </Button>
            {testResult && (
              <Text size="small" className="text-ui-fg-subtle">
                {testResult}
              </Text>
            )}
          </div>

          {error && (
            <Text size="small" className="text-ui-fg-error">
              {error}
            </Text>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <div className="flex items-center justify-end gap-x-2">
            <Drawer.Close asChild>
              <Button size="small" variant="secondary" disabled={isPending}>
                Cancel
              </Button>
            </Drawer.Close>
            <Button size="small" onClick={handleSubmit} isLoading={isPending}>
              Save
            </Button>
          </div>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

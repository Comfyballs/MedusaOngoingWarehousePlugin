import type { UseMutationResult } from "@tanstack/react-query"
import { Input, Label, Select, Switch, Textarea, Text, Button } from "@medusajs/ui"
import { StatusCodePicker } from "./components/StatusCodePicker"

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

export type FormState = {
  credential_key: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string
  status_poll_interval: string
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules_json: string
  shipped_status_codes: number[]
  cancellable_status_codes: number[]
}

export const EMPTY_FORM: FormState = {
  credential_key: "",
  stock_location_id: "",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "",
  status_poll_interval: "",
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules_json: "",
  shipped_status_codes: [],
  cancellable_status_codes: [],
}

export function toFormState(integration: OngoingIntegration): FormState {
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
    shipped_status_codes: Array.isArray(integration.shipped_status_codes)
      ? integration.shipped_status_codes
      : [],
    cancellable_status_codes: Array.isArray(integration.cancellable_status_codes)
      ? integration.cancellable_status_codes
      : [],
  }
}

type TestConnectionResult = {
  success: boolean
  statuses?: { number: number; text: string }[]
  error?: string
}

type Props = {
  form: FormState
  setForm: (form: FormState) => void
  // Create-only: the create modal renders live Selects fed by these; the edit
  // Drawer never passes them (credential_key/stock_location_id are immutable
  // after creation and always render as disabled Inputs there instead).
  isEdit: boolean
  credentialKeysData?: { credential_keys: string[] }
  stockLocationsData?: { stock_locations: { id: string; name: string }[] }
  testConnection: UseMutationResult<TestConnectionResult, Error, string>
  testResult: string | null
  error: string | null
}

// Shared field set rendered inside both CreateIntegrationModal's FocusModal.Body
// and EditIntegrationDrawer's Drawer.Body — kept as one component so the two
// entry points (create vs edit chrome) never drift out of sync on field list,
// labels, or validation wiring.
export function IntegrationFormFields({
  form,
  setForm,
  isEdit,
  credentialKeysData,
  stockLocationsData,
  testConnection,
  testResult,
  error,
}: Props) {
  return (
    <div className="flex flex-col gap-y-4">
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

      <StatusCodePicker
        label="Shipped status codes"
        statuses={testConnection.data?.statuses ?? []}
        selected={form.shipped_status_codes}
        onChange={(next) => setForm({ ...form, shipped_status_codes: next })}
      />

      <StatusCodePicker
        label="Cancellable status codes"
        statuses={testConnection.data?.statuses ?? []}
        selected={form.cancellable_status_codes}
        onChange={(next) => setForm({ ...form, cancellable_status_codes: next })}
      />

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
    </div>
  )
}

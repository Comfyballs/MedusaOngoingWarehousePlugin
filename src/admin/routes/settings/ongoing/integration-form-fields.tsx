import type { ReactNode } from "react"
import type { UseMutationResult } from "@tanstack/react-query"
import { Input, Label, Select, Switch, Textarea, Text, Button } from "@medusajs/ui"
import { StatusCodePicker } from "./components/StatusCodePicker"

export type StockReconcileMode = "sellable_plus_reserved" | "precise" | "onhand"

export type OngoingIntegration = {
  id: string
  credential_key: string
  goods_owner_id: number
  enabled: boolean
  stock_location_id: string
  stock_sync_enabled: boolean
  stock_sync_interval: string | null
  status_poll_interval: string | null
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules: Record<string, unknown> | null
  shipped_status_codes: number[] | null
  delivered_status_codes: number[] | null
  cancellable_status_codes: number[] | null
}

export type FormState = {
  credential_key: string
  // Kept as a string so the input can be empty while typing; parsed on submit.
  goods_owner_id: string
  stock_location_id: string
  enabled: boolean
  stock_sync_enabled: boolean
  stock_sync_interval: string
  status_poll_interval: string
  stock_reconcile_mode: StockReconcileMode
  edit_sync_rules_json: string
  shipped_status_codes: number[]
  delivered_status_codes: number[]
  cancellable_status_codes: number[]
}

export const EMPTY_FORM: FormState = {
  credential_key: "",
  goods_owner_id: "",
  stock_location_id: "",
  enabled: true,
  stock_sync_enabled: true,
  stock_sync_interval: "",
  status_poll_interval: "",
  stock_reconcile_mode: "sellable_plus_reserved",
  edit_sync_rules_json: "",
  shipped_status_codes: [],
  delivered_status_codes: [],
  cancellable_status_codes: [],
}

export function toFormState(integration: OngoingIntegration): FormState {
  return {
    credential_key: integration.credential_key,
    goods_owner_id: String(integration.goods_owner_id ?? ""),
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
    delivered_status_codes: Array.isArray(integration.delivered_status_codes)
      ? integration.delivered_status_codes
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
  credentialKeysLoading?: boolean
  credentialKeysError?: boolean
  stockLocationsData?: { stock_locations: { id: string; name: string }[] }
  stockLocationsLoading?: boolean
  stockLocationsError?: boolean
  testConnection: UseMutationResult<
    TestConnectionResult,
    Error,
    { credential_key: string; goods_owner_id: number }
  >
  testResult: string | null
  error: string | null
  // Disables every editable field while a create/update mutation is in flight, so
  // the operator can't mutate form state mid-submit (bead i85). The immutable edit-mode
  // credential-key / stock-location Inputs stay disabled regardless.
  disabled?: boolean
}

// Field help text. Every input in this form carries one — an operator must be able
// to fill the form in without opening the wiki alongside it. Wording is kept in sync
// with docs/wiki/User-Configuration-Reference.md (bead 4ng).
function FieldHint({ children }: { children: ReactNode }) {
  return (
    <Text size="small" className="text-ui-fg-subtle">
      {children}
    </Text>
  )
}

// Human labels + the exact formula each mode applies, so the operator does not have
// to look up what an enum value does. The raw value is kept in the description (not
// hidden entirely) because it is what the API, the docs and the logs use.
const STOCK_RECONCILE_MODE_OPTIONS: {
  value: StockReconcileMode
  label: string
  description: string
}[] = [
  {
    value: "sellable_plus_reserved",
    label: "Sellable + reserved (recommended)",
    description:
      "sellable_plus_reserved — max(0, sellable + min(Medusa reserved, Ongoing allocated)). " +
      "Rebuilds Medusa's stocked = sellable + reserved invariant so Medusa's own reservations are not deducted twice.",
  },
  {
    value: "precise",
    label: "Precise",
    description:
      "precise — max(0, sellable + reservations for orders already sent to Ongoing). " +
      "Like the default, but ignores reservations for orders Ongoing has never seen.",
  },
  {
    value: "onhand",
    label: "On hand",
    description:
      "onhand — max(0, Ongoing's on-hand count), written straight through. " +
      "Simplest, but Medusa reservations are counted on top of it, so open orders can oversell.",
  },
]

// Real edit_sync_rules shape: one array of Ongoing status codes per edit category.
const EDIT_SYNC_RULES_PLACEHOLDER = `{
  "address_contact": [200, 300],
  "line_items": [200]
}`

// Placeholder that distinguishes "loading" and "fetch failed" from a genuinely
// empty option list, so an empty Select is never mistaken for "server has none".
function selectPlaceholder(
  loading: boolean | undefined,
  errored: boolean | undefined,
  defaultLabel: string,
  loadingLabel: string,
  errorLabel: string
): string {
  if (loading) {
    return loadingLabel
  }
  if (errored) {
    return errorLabel
  }
  return defaultLabel
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
  credentialKeysLoading,
  credentialKeysError,
  stockLocationsData,
  stockLocationsLoading,
  stockLocationsError,
  testConnection,
  testResult,
  error,
  disabled,
}: Props) {
  const credentialKeys = credentialKeysData?.credential_keys ?? []
  const reconcileMode = STOCK_RECONCILE_MODE_OPTIONS.find(
    (option) => option.value === form.stock_reconcile_mode
  )

  return (
    <div className="flex flex-col gap-y-4">
      {isEdit && (
        <FieldHint>
          Credential key, goods owner and stock location identify this warehouse and are
          fixed after creation — every sync row already written points at them. To target a
          different warehouse, create a new integration.
        </FieldHint>
      )}

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-credential-key">Credential key</Label>
        {isEdit ? (
          <Input id="ongoing-credential-key" value={form.credential_key} disabled />
        ) : (
          <Select
            value={form.credential_key}
            disabled={disabled || credentialKeysLoading || credentialKeysError}
            onValueChange={(value) => setForm({ ...form, credential_key: value })}
          >
            <Select.Trigger id="ongoing-credential-key">
              <Select.Value
                placeholder={selectPlaceholder(
                  credentialKeysLoading,
                  credentialKeysError,
                  "Select a credential key",
                  "Loading credential keys…",
                  "Failed to load credential keys"
                )}
              />
            </Select.Trigger>
            <Select.Content>
              {credentialKeys.map((key) => (
                <Select.Item key={key} value={key}>
                  {key}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
        <FieldHint>
          Which configured Ongoing account (base URL, username, password) this warehouse
          talks to. Keys come from the <code>integrations</code> array in the plugin options
          in your <code>medusa-config</code> — they cannot be added here.
        </FieldHint>
        {!isEdit &&
          !credentialKeysLoading &&
          !credentialKeysError &&
          credentialKeys.length === 0 && (
            <Text size="small" className="text-ui-fg-error">
              No credential keys are configured. Add one to the ongoing plugin&apos;s{" "}
              <code>integrations</code> option and restart the app.
            </Text>
          )}
      </div>

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-goods-owner-id">Goods owner id</Label>
        <Input
          id="ongoing-goods-owner-id"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="e.g. 362"
          value={form.goods_owner_id}
          // Immutable after creation, like the credential key and stock location:
          // re-pointing a live integration at another warehouse would orphan every
          // sync row already written against the old goods owner.
          disabled={isEdit || disabled}
          onChange={(e) => setForm({ ...form, goods_owner_id: e.target.value })}
        />
        <FieldHint>
          The numeric Ongoing goods owner (<code>goodsOwnerId</code>) this warehouse maps
          to — a positive whole number from your Ongoing account. One Ongoing account can
          serve several goods owners; each needs its own integration and its own stock
          location. Use <strong>Test connection</strong> below to confirm the key and id
          are a valid pair before saving. Cannot be changed after creation.
        </FieldHint>
        {!isEdit && credentialKeysError && (
          <Text size="small" className="text-ui-fg-error">
            Failed to load credential keys. Check the plugin configuration and retry.
          </Text>
        )}
      </div>

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-stock-location">Stock location</Label>
        {isEdit ? (
          <Input id="ongoing-stock-location" value={form.stock_location_id} disabled />
        ) : (
          <Select
            value={form.stock_location_id}
            disabled={disabled || stockLocationsLoading || stockLocationsError}
            onValueChange={(value) => setForm({ ...form, stock_location_id: value })}
          >
            <Select.Trigger id="ongoing-stock-location">
              <Select.Value
                placeholder={selectPlaceholder(
                  stockLocationsLoading,
                  stockLocationsError,
                  "Select a stock location",
                  "Loading stock locations…",
                  "Failed to load stock locations"
                )}
              />
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
        {!isEdit && stockLocationsError && (
          <Text size="small" className="text-ui-fg-error">
            Failed to load stock locations. Check your connection and retry.
          </Text>
        )}
        <FieldHint>
          The Medusa stock location this warehouse fulfils from, and whose inventory levels
          the stock sync writes back to. One location belongs to exactly one integration.
          {!isEdit &&
            " Assigning it runs setup automatically (fulfillment set, service zone, shipping option) and cannot be changed after the integration is created."}
        </FieldHint>
      </div>

      <div className="flex flex-col gap-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="ongoing-enabled">Enabled</Label>
          <Switch
            id="ongoing-enabled"
            checked={form.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
          />
        </div>
        <FieldHint>
          Master switch for this warehouse. While it is off, the status poll and the stock
          sync skip this integration and creating a fulfillment on its stock location fails
          (no enabled integration for the location) rather than silently doing nothing.
          Sync rows already written are left untouched — this is how you pause a warehouse
          without deleting it.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="ongoing-stock-sync-enabled">Stock sync enabled</Label>
          <Switch
            id="ongoing-stock-sync-enabled"
            checked={form.stock_sync_enabled}
            disabled={disabled}
            onCheckedChange={(checked) => setForm({ ...form, stock_sync_enabled: checked })}
          />
        </div>
        <FieldHint>
          Controls only the inbound stock reconcile. While it is on, Ongoing is the source
          of truth for this location&apos;s stock. Turning it off freezes Medusa&apos;s
          stocked quantities at their last synced values (nothing is reverted) and leaves
          order pushes, status polling and shipments unaffected.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-stock-sync-interval">Stock sync interval (ms)</Label>
        <Input
          id="ongoing-stock-sync-interval"
          value={form.stock_sync_interval}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, stock_sync_interval: e.target.value })}
          placeholder="e.g. 3600000 (1 hour)"
        />
        <FieldHint>
          Shortest time between stock syncs for this warehouse, in milliseconds (900000 =
          15 min, 3600000 = 1 hour). Leave blank to inherit{" "}
          <code>defaultStockSyncInterval</code> from the plugin options, which itself
          defaults to 600000 (10 min). The job only ticks every 15 minutes, so any value
          below 900000 simply means &quot;every tick&quot;. A value that is not a positive
          whole number is ignored and the default is used.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-status-poll-interval">Status poll interval (ms)</Label>
        <Input
          id="ongoing-status-poll-interval"
          value={form.status_poll_interval}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, status_poll_interval: e.target.value })}
          placeholder="e.g. 900000 (15 min)"
        />
        <FieldHint>
          Shortest time between Ongoing order-status polls, in milliseconds. Leave blank to
          inherit <code>defaultStatusPollInterval</code>, which itself defaults to 60000
          (1 min). This job also ticks every 15 minutes, so anything below 900000 means
          &quot;every tick&quot;; raise it to poll a quiet warehouse less often. A value
          that is not a positive whole number is ignored and the default is used.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-stock-reconcile-mode">Stock reconcile mode</Label>
        <Select
          value={form.stock_reconcile_mode}
          disabled={disabled}
          onValueChange={(value) =>
            setForm({ ...form, stock_reconcile_mode: value as StockReconcileMode })
          }
        >
          <Select.Trigger id="ongoing-stock-reconcile-mode">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {STOCK_RECONCILE_MODE_OPTIONS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        <FieldHint>
          How an Ongoing quantity becomes a Medusa stocked quantity. Keep the recommended
          mode unless you know you need another; a change takes effect on the next stock
          sync. All three also write the incoming quantity from Ongoing&apos;s inbound
          count.
        </FieldHint>
        {reconcileMode && <FieldHint>{reconcileMode.description}</FieldHint>}
      </div>

      {/* MVP editor: raw JSON. Out of scope for #40/#41 to build a structured
          rule builder. */}
      <div className="flex flex-col gap-y-2">
        <Label htmlFor="ongoing-edit-sync-rules">Edit sync rules (JSON)</Label>
        <Textarea
          id="ongoing-edit-sync-rules"
          rows={6}
          value={form.edit_sync_rules_json}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, edit_sync_rules_json: e.target.value })}
          placeholder={EDIT_SYNC_RULES_PLACEHOLDER}
        />
        <FieldHint>
          Which order edits may be re-pushed to Ongoing, per category, based on the
          order&apos;s current Ongoing status code. One array of status codes per category:{" "}
          <code>address_contact</code> covers address, contact and email edits;{" "}
          <code>line_items</code> covers line-item and shipping-line edits. An edit
          re-pushes only when the order&apos;s current status is listed under its own
          category.
        </FieldHint>
        <FieldHint>
          <strong>
            Leave this empty and every order edit is blocked (reason no_edit_rules)
          </strong>{" "}
          — that is the state right after an integration is created. A category that is
          missing or empty blocks that category, and an order whose Ongoing status is not
          known yet is blocked too. Blocked edits are flagged on the order&apos;s Ongoing
          widget.
        </FieldHint>
      </div>

      <StatusCodePicker
        label="Shipped status codes"
        description="Ongoing statuses that mean the order has left the warehouse. When the poll or a webhook sees one of these, the Medusa fulfillment is marked shipped and tracking numbers are pulled in. Leave empty to use Ongoing's canonical codes (425, 450, 451)."
        statuses={testConnection.data?.statuses ?? []}
        selected={form.shipped_status_codes}
        disabled={disabled}
        onChange={(next) => setForm({ ...form, shipped_status_codes: next })}
      />

      <StatusCodePicker
        label="Delivered status codes"
        description="Ongoing statuses that mean the goods reached the customer — typically collection at a pickup point. Checked before the shipped list, so a code in both counts as delivered. Leave empty to use the canonical code (500)."
        statuses={testConnection.data?.statuses ?? []}
        selected={form.delivered_status_codes}
        disabled={disabled}
        onChange={(next) => setForm({ ...form, delivered_status_codes: next })}
      />

      <StatusCodePicker
        label="Cancellable status codes"
        description="Ongoing statuses at which a Medusa cancellation may still be sent. Unlike the two lists above there is no fallback: while this is empty, every cancel on an order with a known status is refused and flagged on the order widget. A cancel is attempted anyway when the order's Ongoing status is not known yet."
        statuses={testConnection.data?.statuses ?? []}
        selected={form.cancellable_status_codes}
        disabled={disabled}
        onChange={(next) => setForm({ ...form, cancellable_status_codes: next })}
      />

      <div className="flex flex-col gap-y-2 border-t pt-4">
        <Button
          size="small"
          variant="secondary"
          disabled={
            disabled ||
            !form.credential_key ||
            !form.goods_owner_id ||
            testConnection.isPending
          }
          isLoading={testConnection.isPending}
          onClick={() =>
            testConnection.mutate({
              credential_key: form.credential_key,
              goods_owner_id: Number(form.goods_owner_id),
            })
          }
        >
          Test connection
        </Button>
        <FieldHint>
          Checks the credential key and goods owner id against the live Ongoing API and
          loads its order-status list — the three status pickers above stay unlabelled
          until you run it. Nothing is saved. Fill in a credential key and a goods owner id
          to enable this button.
        </FieldHint>
        {testResult && (
          <Text size="small" className="text-ui-fg-subtle">
            {testResult}
          </Text>
        )}
        {testResult?.startsWith("Failed") && (
          <FieldHint>
            Check the credential&apos;s base URL, username and password in your{" "}
            <code>medusa-config</code> and the goods owner id, then try again.
          </FieldHint>
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

import { useState, type ReactNode } from "react"
import type { UseMutationResult } from "@tanstack/react-query"
import { Input, Label, Select, Switch, Textarea, Text, Button } from "@medusajs/ui"
import { StatusCodePicker } from "./components/StatusCodePicker"
import { parseEditSyncRulesJson } from "./utils/parse-codes"
import { validateIntervalField } from "./utils/validate-interval"

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
  // bead dox: the FocusModal is full-screen and has room for input-left/description-right;
  // the edit Drawer is a narrow side panel and must stay stacked. There is no
  // Tailwind container-queries plugin registered in this project's admin build (it is
  // owned by Medusa's own admin-bundler/vite pipeline, not this plugin), so a
  // `@container` breakpoint can't be relied on to collapse correctly inside the
  // Drawer — an explicit prop, set per entry point, is the robust choice instead.
  // Defaults to the stacked single column (the Drawer's shape); CreateIntegrationModal
  // opts in explicitly.
  twoColumn?: boolean
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

function FieldError({ children }: { children: ReactNode }) {
  return (
    <Text size="small" className="text-ui-fg-error">
      {children}
    </Text>
  )
}

// Pairs one field's control (label + input, plus any inline errors) with its
// description. twoColumn puts the control on the left and the description on the
// right, aligned to the same row, matching the admin's own two-column settings-form
// rhythm (e.g. SectionRow's `grid grid-cols-2`); the stacked fallback keeps the
// original label -> control -> description order for the narrow Drawer.
function FormField({
  twoColumn,
  control,
  description,
}: {
  twoColumn: boolean
  control: ReactNode
  description?: ReactNode
}) {
  if (!twoColumn) {
    return (
      <div className="flex flex-col gap-y-2">
        {control}
        {description}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 items-start gap-x-8 gap-y-2 border-b border-ui-border-base pb-6 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-y-2">{control}</div>
      {description && <div className="flex flex-col gap-y-2">{description}</div>}
    </div>
  )
}

// Human labels + a plain-language explanation of how each mode derives Medusa's
// stocked quantity from Ongoing's numbers, what it assumes about who owns
// reservations, and what setup should pick it — so the operator can choose without
// opening the wiki (bead dox). Verified against reconcileInventoryLevelsHandler
// (src/workflows/steps/reconcile-inventory-levels.ts); mirrored into
// docs/wiki/User-Configuration-Reference.md.
const STOCK_RECONCILE_MODE_OPTIONS: {
  value: StockReconcileMode
  label: string
  description: string
}[] = [
  {
    value: "sellable_plus_reserved",
    label: "Sellable + reserved (recommended)",
    description:
      "Default. Ongoing's sellable count already excludes stock Ongoing has allocated to " +
      "orders it knows about, so this mode adds Medusa's own reservations back on top " +
      "(capped at what Ongoing shows as allocated) to rebuild Medusa's " +
      "stocked = sellable + reserved balance — otherwise that stock would be deducted " +
      "twice. Assumes every Medusa reservation corresponds to an order Ongoing also " +
      "holds stock for. Use this for the common setup, where orders are pushed to " +
      "Ongoing promptly.",
  },
  {
    value: "precise",
    label: "Precise",
    description:
      "Same idea as the default, but instead of capping Medusa's total reservations at " +
      "Ongoing's aggregate allocated count, it looks up exactly which reservations " +
      "belong to orders whose sync row is already marked sent to Ongoing, and adds " +
      "back only those (one extra query per stock sync). Use this instead of the " +
      "default when orders can sit unpushed in Medusa for a while, so a reservation " +
      "for an order Ongoing hasn't seen yet is never added back too early.",
  },
  {
    value: "onhand",
    label: "On hand",
    description:
      "Writes Ongoing's raw on-hand count straight through and ignores Medusa's own " +
      "reservations entirely — no addition, no subtraction. Only safe when Medusa " +
      "holds no reservations of its own: if it does, those reserved units still show " +
      "as sellable in Medusa (this mode never accounts for them), and open orders can " +
      "oversell. Use this only where Ongoing is the sole source of truth for what's " +
      "reservable.",
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
  twoColumn = false,
}: Props) {
  const credentialKeys = credentialKeysData?.credential_keys ?? []

  // bead atq: validate on blur instead of only on Save, so a typo is reported next
  // to the field immediately rather than after filling in the rest of the form.
  // Cleared on change so the message disappears as soon as the operator edits the
  // field again (see forms.md's "clear field errors on input change" pattern).
  const [editSyncRulesError, setEditSyncRulesError] = useState<string | null>(null)
  const [stockSyncIntervalError, setStockSyncIntervalError] = useState<string | null>(null)
  const [statusPollIntervalError, setStatusPollIntervalError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-y-4">
      {isEdit && (
        <FieldHint>
          Credential key, goods owner and stock location identify this warehouse and are
          fixed after creation — every sync row already written points at them. To target a
          different warehouse, create a new integration.
        </FieldHint>
      )}

      <FormField
        twoColumn={twoColumn}
        control={
          <>
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
            {!isEdit &&
              !credentialKeysLoading &&
              !credentialKeysError &&
              credentialKeys.length === 0 && (
                <FieldError>
                  No credential keys are configured. Add one to the ongoing plugin&apos;s{" "}
                  <code>integrations</code> option and restart the app.
                </FieldError>
              )}
          </>
        }
        description={
          <>
            <FieldHint>
              Which configured Ongoing account (base URL, username, password) this warehouse
              talks to. Keys come from the <code>integrations</code> array in the plugin
              options in your <code>medusa-config</code> — they cannot be added here.
            </FieldHint>
            {!isEdit && credentialKeysError && (
              <FieldError>
                Failed to load credential keys. Check the plugin configuration and retry.
              </FieldError>
            )}
          </>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <>
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
          </>
        }
        description={
          <FieldHint>
            The numeric Ongoing goods owner (<code>goodsOwnerId</code>) this warehouse maps
            to — a positive whole number from your Ongoing account. One Ongoing account can
            serve several goods owners; each needs its own integration and its own stock
            location. Use <strong>Test connection</strong> below to confirm the key and id
            are a valid pair before saving. Cannot be changed after creation.
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <>
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
              <FieldError>
                Failed to load stock locations. Check your connection and retry.
              </FieldError>
            )}
          </>
        }
        description={
          <FieldHint>
            The Medusa stock location this warehouse fulfils from, and whose inventory levels
            the stock sync writes back to. One location belongs to exactly one integration.
            {!isEdit &&
              " Assigning it runs setup automatically (fulfillment set, service zone, shipping option) and cannot be changed after the integration is created."}
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <div className="flex items-center justify-between">
            <Label htmlFor="ongoing-enabled">Enabled</Label>
            <Switch
              id="ongoing-enabled"
              checked={form.enabled}
              disabled={disabled}
              onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
            />
          </div>
        }
        description={
          <FieldHint>
            Master switch for this warehouse. While it is off, the status poll and the stock
            sync skip this integration and creating a fulfillment on its stock location fails
            (no enabled integration for the location) rather than silently doing nothing.
            Sync rows already written are left untouched — this is how you pause a warehouse
            without deleting it.
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <div className="flex items-center justify-between">
            <Label htmlFor="ongoing-stock-sync-enabled">Stock sync enabled</Label>
            <Switch
              id="ongoing-stock-sync-enabled"
              checked={form.stock_sync_enabled}
              disabled={disabled}
              onCheckedChange={(checked) => setForm({ ...form, stock_sync_enabled: checked })}
            />
          </div>
        }
        description={
          <FieldHint>
            Controls only the inbound stock reconcile. While it is on, Ongoing is the source
            of truth for this location&apos;s stock. Turning it off freezes Medusa&apos;s
            stocked quantities at their last synced values (nothing is reverted) and leaves
            order pushes, status polling and shipments unaffected.
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <>
            <Label htmlFor="ongoing-stock-sync-interval">Stock sync interval (ms)</Label>
            <Input
              id="ongoing-stock-sync-interval"
              value={form.stock_sync_interval}
              disabled={disabled}
              onChange={(e) => {
                setForm({ ...form, stock_sync_interval: e.target.value })
                setStockSyncIntervalError(null)
              }}
              onBlur={(e) =>
                setStockSyncIntervalError(
                  validateIntervalField(e.target.value, "Stock sync interval")
                )
              }
              placeholder="e.g. 3600000 (1 hour)"
            />
            {stockSyncIntervalError && <FieldError>{stockSyncIntervalError}</FieldError>}
          </>
        }
        description={
          <FieldHint>
            Shortest time between stock syncs for this warehouse, in milliseconds (900000 =
            15 min, 3600000 = 1 hour). Leave blank to inherit{" "}
            <code>defaultStockSyncInterval</code> from the plugin options, which itself
            defaults to 600000 (10 min). The job only ticks every 15 minutes, so any value
            below 900000 simply means &quot;every tick&quot;.
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <>
            <Label htmlFor="ongoing-status-poll-interval">Status poll interval (ms)</Label>
            <Input
              id="ongoing-status-poll-interval"
              value={form.status_poll_interval}
              disabled={disabled}
              onChange={(e) => {
                setForm({ ...form, status_poll_interval: e.target.value })
                setStatusPollIntervalError(null)
              }}
              onBlur={(e) =>
                setStatusPollIntervalError(
                  validateIntervalField(e.target.value, "Status poll interval")
                )
              }
              placeholder="e.g. 900000 (15 min)"
            />
            {statusPollIntervalError && <FieldError>{statusPollIntervalError}</FieldError>}
          </>
        }
        description={
          <FieldHint>
            Shortest time between Ongoing order-status polls, in milliseconds. Leave blank to
            inherit <code>defaultStatusPollInterval</code>, which itself defaults to 60000
            (1 min). This job also ticks every 15 minutes, so anything below 900000 means
            &quot;every tick&quot;; raise it to poll a quiet warehouse less often.
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <>
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
          </>
        }
        description={
          <>
            <FieldHint>
              How an Ongoing quantity becomes a Medusa stocked quantity. A change takes
              effect on the next stock sync. All three also write the incoming quantity from
              Ongoing&apos;s inbound count.
            </FieldHint>
            {STOCK_RECONCILE_MODE_OPTIONS.map((option) => (
              <Text key={option.value} size="small" className="text-ui-fg-subtle">
                <strong className="text-ui-fg-base">{option.label}.</strong> {option.description}
              </Text>
            ))}
          </>
        }
      />

      {/* MVP editor: raw JSON. Out of scope for #40/#41 to build a structured
          rule builder. */}
      <FormField
        twoColumn={twoColumn}
        control={
          <>
            <Label htmlFor="ongoing-edit-sync-rules">Edit sync rules (JSON)</Label>
            <Textarea
              id="ongoing-edit-sync-rules"
              rows={6}
              value={form.edit_sync_rules_json}
              disabled={disabled}
              onChange={(e) => {
                setForm({ ...form, edit_sync_rules_json: e.target.value })
                setEditSyncRulesError(null)
              }}
              onBlur={(e) => {
                // bead atq: validate on blur, not only on Save — a typo used to mean
                // filling in the rest of the form, pressing Save, and reading the
                // error at the bottom.
                try {
                  parseEditSyncRulesJson(e.target.value)
                  setEditSyncRulesError(null)
                } catch (err) {
                  setEditSyncRulesError(err instanceof Error ? err.message : "Invalid input")
                }
              }}
              placeholder={EDIT_SYNC_RULES_PLACEHOLDER}
            />
            {editSyncRulesError && <FieldError>{editSyncRulesError}</FieldError>}
          </>
        }
        description={
          <>
            <FieldHint>
              Which order edits may be re-pushed to Ongoing, per category, based on the
              order&apos;s current Ongoing status code. One array of status codes per
              category: <code>address_contact</code> covers address, contact and email
              edits; <code>line_items</code> covers line-item and shipping-line edits. An
              edit re-pushes only when the order&apos;s current status is listed under its
              own category.
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
          </>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <StatusCodePicker
            label="Shipped status codes"
            statuses={testConnection.data?.statuses ?? []}
            selected={form.shipped_status_codes}
            disabled={disabled}
            onChange={(next) => setForm({ ...form, shipped_status_codes: next })}
          />
        }
        description={
          <FieldHint>
            Ongoing statuses that mean the order has left the warehouse. When the poll or a
            webhook sees one of these, the Medusa fulfillment is marked shipped and tracking
            numbers are pulled in. Leave empty to use Ongoing&apos;s canonical codes (425,
            450, 451).
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <StatusCodePicker
            label="Delivered status codes"
            statuses={testConnection.data?.statuses ?? []}
            selected={form.delivered_status_codes}
            disabled={disabled}
            onChange={(next) => setForm({ ...form, delivered_status_codes: next })}
          />
        }
        description={
          <FieldHint>
            Ongoing statuses that mean the goods reached the customer — typically collection
            at a pickup point. Checked before the shipped list, so a code in both counts as
            delivered. Leave empty to use the canonical code (500).
          </FieldHint>
        }
      />

      <FormField
        twoColumn={twoColumn}
        control={
          <StatusCodePicker
            label="Cancellable status codes"
            statuses={testConnection.data?.statuses ?? []}
            selected={form.cancellable_status_codes}
            disabled={disabled}
            onChange={(next) => setForm({ ...form, cancellable_status_codes: next })}
          />
        }
        description={
          <FieldHint>
            Ongoing statuses at which a Medusa cancellation may still be sent. Unlike the two
            lists above there is no fallback: while this is empty, every cancel on an order
            with a known status is refused and flagged on the order widget. A cancel is
            attempted anyway when the order&apos;s Ongoing status is not known yet.
          </FieldHint>
        }
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

      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}

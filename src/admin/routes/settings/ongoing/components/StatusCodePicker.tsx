import { Checkbox, Label, Text } from "@medusajs/ui"
import { toggleStatusCode } from "../utils/toggle-status-code"
import { mergeStatusOptions } from "../utils/merge-status-options"

export interface StatusCodePickerOption {
  number: number
  text: string
}

export interface StatusCodePickerProps {
  label: string
  // What checking a code in THIS list actually causes. Passed in rather than mapped
  // from `label` so the three call sites keep their copy next to the field they
  // configure (bead 4ng).
  description?: string
  statuses: StatusCodePickerOption[]
  selected: number[]
  onChange: (next: number[]) => void
  disabled?: boolean
}

export const StatusCodePicker = ({
  label,
  description,
  statuses,
  selected,
  onChange,
  disabled,
}: StatusCodePickerProps) => {
  const handleToggle = (statusNumber: number, checked: boolean) => {
    onChange(toggleStatusCode(selected, statusNumber, checked))
  }

  // Union of the live status list and the codes already stored on the
  // integration, so stored codes stay visible and editable before (and without)
  // a live "Test connection" round-trip. Label-less entries enrich once a live
  // fetch resolves. See merge-status-options for the merge rules.
  const options = mergeStatusOptions(statuses, selected)

  return (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">
        {label}
      </Label>
      {description && (
        <Text size="small" className="text-ui-fg-subtle">
          {description}
        </Text>
      )}
      {options.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">
          Run &quot;Test connection&quot; to load statuses from Ongoing.
        </Text>
      ) : (
        <div className="flex flex-col gap-y-2">
          {statuses.length === 0 && (
            <Text size="small" className="text-ui-fg-subtle">
              Showing stored codes. Run &quot;Test connection&quot; to load their
              labels and the full list from Ongoing.
            </Text>
          )}
          {options.map((status) => {
            const inputId = `${label}-status-${status.number}`
            return (
              <div key={status.number} className="flex items-center gap-x-2">
                <Checkbox
                  id={inputId}
                  checked={selected.includes(status.number)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    handleToggle(status.number, checked === true)
                  }
                />
                <Label htmlFor={inputId} size="small">
                  {status.text ? `${status.number} — ${status.text}` : status.number}
                </Label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

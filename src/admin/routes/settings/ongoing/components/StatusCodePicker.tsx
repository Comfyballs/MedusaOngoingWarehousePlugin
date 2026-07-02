import { Checkbox, Label, Text } from "@medusajs/ui"
import { toggleStatusCode } from "../utils/toggle-status-code"

export interface StatusCodePickerOption {
  number: number
  text: string
}

export interface StatusCodePickerProps {
  label: string
  statuses: StatusCodePickerOption[]
  selected: number[]
  onChange: (next: number[]) => void
  disabled?: boolean
}

export const StatusCodePicker = ({
  label,
  statuses,
  selected,
  onChange,
  disabled,
}: StatusCodePickerProps) => {
  const handleToggle = (statusNumber: number, checked: boolean) => {
    onChange(toggleStatusCode(selected, statusNumber, checked))
  }

  return (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">
        {label}
      </Label>
      {statuses.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">
          Run &quot;Test connection&quot; to load statuses from Ongoing.
        </Text>
      ) : (
        <div className="flex flex-col gap-y-2">
          {statuses.map((status) => {
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
                  {status.number} — {status.text}
                </Label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

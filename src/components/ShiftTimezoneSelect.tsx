import { shiftTimezoneOptions } from "@/lib/attendance";

/**
 * The clock a shift is saved on, grouped by the VAs' own clocks and each
 * client region. A shift saved on the client's clock follows their daylight
 * saving by itself.
 */
export function ShiftTimezoneSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (timezone: string) => void;
  className?: string;
}) {
  const options = shiftTimezoneOptions(value);
  const groups = [...new Set(options.map((option) => option.group))];
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
      title="Save the shift on the client's clock so it follows their daylight saving"
    >
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {options
            .filter((option) => option.group === group)
            .map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

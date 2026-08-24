export const DAY_OPTIONS = [
  { value: 0, label: "Sun", short: "Sun" },
  { value: 1, label: "Mon", short: "Mon" },
  { value: 2, label: "Tue", short: "Tue" },
  { value: 3, label: "Wed", short: "Wed" },
  { value: 4, label: "Thu", short: "Thu" },
  { value: 5, label: "Fri", short: "Fri" },
  { value: 6, label: "Sat", short: "Sat" },
];

export function formatWorkingDaysSummary(days?: number[]): string {
  const resolved = Array.isArray(days) && days.length > 0 ? days : [0, 1, 2, 3, 4, 5];
  if (resolved.length === 7) return "7 Days (Sun–Sat)";
  if (resolved.length === 6 && resolved.join(",") === "0,1,2,3,4,5") return "6 Days (Sun–Fri)";
  if (resolved.length === 6 && resolved.join(",") === "1,2,3,4,5,6") return "6 Days (Mon–Sat)";
  if (resolved.length === 5 && resolved.join(",") === "1,2,3,4,5") return "5 Days (Mon–Fri)";
  if (resolved.length === 5 && resolved.join(",") === "0,1,2,3,4") return "5 Days (Sun–Thu)";
  const labels = resolved.map((d) => DAY_OPTIONS.find((o) => o.value === d)?.short || d);
  return `${resolved.length} Days (${labels.join(", ")})`;
}

export function WorkingDaysPicker({
  value = [0, 1, 2, 3, 4, 5],
  onChange,
  label,
  compact = false,
}: {
  value?: number[];
  onChange: (days: number[]) => void;
  label?: string;
  compact?: boolean;
}) {
  const currentDays = Array.isArray(value) && value.length > 0 ? value : [0, 1, 2, 3, 4, 5];

  const toggleDay = (day: number) => {
    if (currentDays.includes(day)) {
      if (currentDays.length === 1) return; // keep at least 1 day
      onChange(currentDays.filter((d) => d !== day).sort((a, b) => a - b));
    } else {
      onChange([...currentDays, day].sort((a, b) => a - b));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <label className={`${compact ? "text-xs" : "text-sm"} font-medium`}>
          {label ?? `Working days (${currentDays.length} days/week)`}
        </label>
        <div className="flex flex-wrap gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => onChange([0, 1, 2, 3, 4, 5, 6])}
            className="text-primary hover:underline font-bold"
          >
            All 7d
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => onChange([1, 2, 3, 4, 5])}
            className="text-primary hover:underline font-bold"
          >
            Mon–Fri (5d)
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => onChange([1, 2, 3, 4, 5, 6])}
            className="text-primary hover:underline font-bold"
          >
            Mon–Sat (6d)
          </button>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            onClick={() => onChange([0, 1, 2, 3, 4, 5])}
            className="text-primary hover:underline font-bold"
          >
            Sun–Fri (6d)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {DAY_OPTIONS.map((day) => {
          const selected = currentDays.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              onClick={() => toggleDay(day.value)}
              className={`${compact ? "py-1 text-[11px]" : "py-1.5 text-xs"} rounded-md border font-bold transition-all ${
                selected
                  ? "bg-primary text-primary-foreground border-primary shadow-xs"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              }`}
            >
              {day.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

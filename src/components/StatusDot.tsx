export type Status = "in" | "out" | "leave" | "holiday";

export function StatusDot({ status }: { status: Status }) {
  const map = {
    in: { color: "var(--status-in)", label: "Punched in" },
    out: { color: "var(--status-out)", label: "Punched out" },
    leave: { color: "var(--status-leave)", label: "On leave" },
    holiday: { color: "#9333ea", label: "Holiday" },
  }[status];
  return (
    <span
      title={map.label}
      aria-label={map.label}
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: map.color }}
    />
  );
}

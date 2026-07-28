export type Status = "in" | "out" | "leave";

export function StatusDot({ status }: { status: Status }) {
  const map = {
    in: { color: "var(--status-in)", label: "Punched in" },
    out: { color: "var(--status-out)", label: "Punched out" },
    leave: { color: "var(--status-leave)", label: "On leave" },
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

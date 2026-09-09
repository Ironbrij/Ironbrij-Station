import type { Punch } from "./types.ts";
import { toMillis } from "./time.ts";

export function breakDurationMs(punches: Punch[], start: Date, end: Date): number {
  let open: number | null = null;
  let total = 0;
  for (const punch of [...punches].sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))) {
    const time = toMillis(punch.timestamp);
    if (punch.voidedAt || time > end.getTime()) continue;
    if (punch.type === "lunch_start" && open === null) open = time;
    if ((punch.type === "lunch_end" || punch.type === "out" || punch.type === "extra_out") && open !== null) {
      total += Math.max(0, time - Math.max(open, start.getTime())); open = null;
    }
  }
  if (open !== null) total += Math.max(0, end.getTime() - Math.max(open, start.getTime()));
  return total;
}

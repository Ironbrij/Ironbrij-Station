import { AlertTriangle, Clock, Calendar } from "lucide-react";
import type { ShiftConflict } from "@/lib/shift-conflict";

interface ShiftConflictAlertProps {
  conflicts: ShiftConflict[];
  className?: string;
}

export function ShiftConflictAlert({ conflicts, className = "" }: ShiftConflictAlertProps) {
  if (!conflicts || conflicts.length === 0) return null;

  return (
    <div
      className={`rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-left shadow-sm animate-in fade-in duration-200 ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500 text-white shrink-0 shadow-xs">
          <AlertTriangle className="h-5 w-5 animate-pulse" />
        </div>
        <div className="space-y-1 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-bold text-sm text-rose-950 dark:text-rose-200">
              Shift Scheduling Conflict Detected
            </h4>
            <span className="rounded-full bg-rose-500/20 text-rose-800 dark:text-rose-300 font-extrabold text-[10px] px-2 py-0.5 border border-rose-500/30">
              {conflicts.length} Overlap{conflicts.length > 1 ? "s" : ""}
            </span>
          </div>
          <p className="text-xs text-rose-900/80 dark:text-rose-300/80 font-medium">
            Overlapping shift times found on the same scheduled working days (similar to Google
            Calendar / Meet conflict warnings).
          </p>

          <div className="mt-3 space-y-2">
            {conflicts.map((conflict, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-rose-500/20 bg-background/80 p-2.5 text-xs text-foreground shadow-2xs space-y-1"
              >
                <div className="flex flex-wrap items-center gap-1.5 font-bold text-xs">
                  <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                    <Calendar className="h-3.5 w-3.5" />
                    {conflict.dayName}:
                  </span>
                  <span>{conflict.shift1Name}</span>
                  <span className="text-muted-foreground font-normal">
                    ({conflict.shift1TimeFormatted})
                  </span>
                  <span className="text-rose-500 font-extrabold">&harr;</span>
                  <span>{conflict.shift2Name}</span>
                  <span className="text-muted-foreground font-normal">
                    ({conflict.shift2TimeFormatted})
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 text-rose-700 dark:text-rose-300 font-medium">
                    <Clock className="h-3 w-3" />
                    {conflict.overlapMinutes} min conflict
                  </span>
                  {conflict.company1Name &&
                    conflict.company2Name &&
                    conflict.company1Name !== conflict.company2Name && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                        Cross-Company: {conflict.company1Name} vs {conflict.company2Name}
                      </span>
                    )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

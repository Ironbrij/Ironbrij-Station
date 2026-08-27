import { useEffect, useState } from "react";
import { Play, PauseCircle, CheckCircle2 } from "lucide-react";
import { MunchingBuddyMascot } from "./MunchingBuddyMascot";
import { CalendarFlipCounter } from "./CalendarFlipCounter";

interface LunchBreakCardProps {
  lunchStartTime: Date;
  allowedMinutes?: number;
  breakNumber?: number;
  maxBreaks?: number;
  onEndLunch: () => void;
  loading?: boolean;
}

export function LunchBreakCard({
  lunchStartTime,
  allowedMinutes = 30,
  breakNumber = 1,
  maxBreaks = 1,
  onEndLunch,
  loading = false,
}: LunchBreakCardProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const allowedSeconds = allowedMinutes * 60;
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - lunchStartTime.getTime()) / 1000),
  );
  const isOverdue = elapsedSeconds > allowedSeconds;

  let displayMinutes = 0;
  let displaySeconds = 0;

  if (isOverdue) {
    const overdueSeconds = elapsedSeconds - allowedSeconds;
    displayMinutes = Math.floor(overdueSeconds / 60);
    displaySeconds = overdueSeconds % 60;
  } else {
    const remainingSeconds = Math.max(0, allowedSeconds - elapsedSeconds);
    displayMinutes = Math.floor(remainingSeconds / 60);
    displaySeconds = remainingSeconds % 60;
  }

  const progressPercent = Math.min(100, (elapsedSeconds / allowedSeconds) * 100);

  return (
    <div className="relative w-full max-w-xl mx-auto animate-in fade-in zoom-in-95 duration-200">
      {/* Executive Card Container */}
      <div
        className={`relative overflow-hidden rounded-3xl border p-6 sm:p-7 shadow-xl backdrop-blur-md transition-all duration-300 ${
          isOverdue
            ? "border-rose-500/30 bg-gradient-to-b from-rose-500/10 via-background to-background shadow-rose-950/20"
            : "border-amber-500/25 bg-gradient-to-b from-amber-500/10 via-background to-background shadow-amber-950/15"
        }`}
      >
        {/* Subtle Ambient Glow */}
        <div
          className={`absolute -top-16 left-1/2 -translate-x-1/2 w-48 h-24 rounded-full blur-3xl pointer-events-none opacity-40 ${
            isOverdue ? "bg-rose-500" : "bg-amber-500"
          }`}
        />

        {/* Header Badge */}
        <div className="flex flex-col items-center justify-center text-center gap-2 mb-2">
          <MunchingBuddyMascot isOverdue={isOverdue} durationMinutes={allowedMinutes} />

          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground mt-1">
            <span>
              Break {breakNumber} of {maxBreaks}
            </span>
            <span>·</span>
            <span>{allowedMinutes}m allocated</span>
          </div>
        </div>

        {/* 3D Chronograph Split-Flap Counter */}
        <div className="my-1">
          <CalendarFlipCounter
            minutes={displayMinutes}
            seconds={displaySeconds}
            isOverdue={isOverdue}
          />
        </div>

        {/* Progress Bar & Readout */}
        <div className="space-y-2 my-4 px-1">
          <div className="flex items-center justify-between text-xs font-medium">
            <span
              className={
                isOverdue
                  ? "font-bold text-rose-600 dark:text-rose-400"
                  : "font-semibold text-amber-700 dark:text-amber-300"
              }
            >
              {isOverdue ? "Overdue Time Accruing" : "Break Elapsed"}
            </span>
            <span className="font-mono text-xs font-bold text-foreground">
              {Math.floor(elapsedSeconds / 60)}m {elapsedSeconds % 60}s / {allowedMinutes}m
            </span>
          </div>

          <div className="w-full h-2 rounded-full bg-secondary/80 overflow-hidden border border-border/50 p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isOverdue
                  ? "bg-gradient-to-r from-rose-500 to-rose-600 shadow-sm shadow-rose-500/50"
                  : "bg-gradient-to-r from-amber-400 to-amber-500 shadow-sm shadow-amber-500/40"
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Overdue Warning Notice */}
        {isOverdue && (
          <div className="my-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 text-xs font-semibold text-center leading-relaxed animate-pulse">
            ⚠️ Your {allowedMinutes}-minute break has finished. Your shift timer remains paused and time continues to accrue as lunch break until you return and click below.
          </div>
        )}

        {/* Primary Action Button (Exit break at any moment) */}
        <div className="pt-2">
          <button
            type="button"
            disabled={loading}
            onClick={onEndLunch}
            className={`w-full py-3.5 px-6 rounded-2xl font-black text-sm shadow-lg flex items-center justify-center gap-2.5 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 ${
              isOverdue
                ? "bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/25"
                : "bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-slate-950 font-extrabold shadow-amber-500/20"
            }`}
          >
            <Play className="h-4 w-4 fill-current" />
            {loading ? "Resuming Shift..." : "End Break & Resume Shift"}
          </button>
        </div>
      </div>
    </div>
  );
}

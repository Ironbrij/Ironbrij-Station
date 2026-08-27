import { memo } from "react";

interface DigitCardProps {
  digit: string;
  label: string;
  isOverdue?: boolean;
}

const SingleDigitCard = memo(function SingleDigitCard({
  digit,
  label,
  isOverdue = false,
}: DigitCardProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Clean, High-Legibility Digital Card */}
      <div
        className={`w-20 h-24 sm:w-24 sm:h-28 rounded-2xl border shadow-lg flex items-center justify-center font-mono font-black text-4xl sm:text-5xl select-none transition-all duration-300 ${
          isOverdue
            ? "border-rose-500/40 bg-gradient-to-b from-rose-500/10 via-card to-background text-rose-600 dark:text-rose-400 shadow-rose-950/10"
            : "border-amber-500/30 bg-gradient-to-b from-amber-500/10 via-card to-background text-amber-600 dark:text-amber-400 shadow-amber-950/10"
        }`}
      >
        <span className="leading-none tracking-tight font-mono drop-shadow-xs">
          {digit}
        </span>
      </div>

      <span
        className={`text-[10px] sm:text-[11px] font-bold uppercase tracking-widest ${
          isOverdue ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"
        }`}
      >
        {label}
      </span>
    </div>
  );
});

export function CalendarFlipCounter({
  minutes,
  seconds,
  isOverdue = false,
}: {
  minutes: number;
  seconds: number;
  isOverdue?: boolean;
}) {
  const mm = String(Math.abs(minutes)).padStart(2, "0");
  const ss = String(Math.abs(seconds)).padStart(2, "0");

  return (
    <div className="flex items-center justify-center gap-3 sm:gap-5 py-2">
      {/* Minutes Card */}
      <SingleDigitCard digit={mm} label="Minutes" isOverdue={isOverdue} />

      {/* Clean Static Colon */}
      <div className="flex flex-col items-center justify-center gap-2 pb-6">
        <span
          className={`w-2 h-2 rounded-full ${
            isOverdue ? "bg-rose-500" : "bg-amber-500"
          }`}
        />
        <span
          className={`w-2 h-2 rounded-full ${
            isOverdue ? "bg-rose-500" : "bg-amber-500"
          }`}
        />
      </div>

      {/* Seconds Card */}
      <SingleDigitCard digit={ss} label="Seconds" isOverdue={isOverdue} />
    </div>
  );
}

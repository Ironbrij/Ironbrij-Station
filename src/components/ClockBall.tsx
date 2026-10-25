import { Link } from "@tanstack/react-router";
import { useClockBallExtension } from "@/lib/use-clock-ball";

/** A still picture of the extension's ball, in Ironbrij blue. */
export function ClockBallPreview({
  size = 84,
  time = "2:14:09",
}: {
  size?: number;
  time?: string;
}) {
  const scale = size / 84;
  return (
    <div
      aria-hidden
      className="flex shrink-0 flex-col items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        gap: 5 * scale,
        background: "radial-gradient(circle at 32% 26%, #6aa8ff 0%, #1d4ed8 52%, #0b2a7a 100%)",
        boxShadow:
          "0 10px 24px rgba(11,42,122,.45), inset 0 -6px 12px rgba(0,0,0,.28), inset 0 4px 10px rgba(255,255,255,.35)",
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 46 * scale,
          height: 20 * scale,
          gap: 9 * scale,
          borderRadius: 10 * scale,
          background: "#0a1330",
        }}
      >
        {[0, 1].map((eye) => (
          <span
            key={eye}
            style={{
              width: 8 * scale,
              height: 11 * scale,
              borderRadius: 4 * scale,
              background: "#7dd3fc",
              boxShadow: "0 0 6px #7dd3fc",
            }}
          />
        ))}
      </div>
      <span
        className="font-mono font-bold text-white tabular-nums"
        style={{ fontSize: 13 * scale, textShadow: "0 1px 2px rgba(0,0,0,.4)" }}
      >
        {time}
      </span>
    </div>
  );
}

/** "New: get the Clock Ball", shown until the extension is installed. */
export function ClockBallBanner() {
  if (useClockBallExtension() !== false) return null;
  return (
    <Link
      to="/app/clock-ball"
      className="flex items-center gap-4 rounded-2xl bg-gradient-to-r from-[#0b2a7a] to-[#1d4ed8] p-4 text-white shadow-xs transition-opacity hover:opacity-95"
    >
      <ClockBallPreview size={56} />
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/75">
          New update
        </div>
        <div className="font-semibold">Keep your time in view with the Clock Ball</div>
        <p className="text-sm text-white/80">
          Download the Chrome extension: a little robot ball that counts your shift on every
          website.
        </p>
      </div>
      <span className="ml-auto hidden shrink-0 rounded-xl bg-white/15 px-4 py-2 text-sm font-semibold sm:block">
        Get it
      </span>
    </Link>
  );
}

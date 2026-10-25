import { Link } from "@tanstack/react-router";
import { useClockBallExtension } from "@/lib/use-clock-ball";
import { DEFAULT_LOGO } from "@/lib/types";

/** A still picture of the extension's ball with its default face, the Ironbrij logo. */
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
      className="flex shrink-0 flex-col items-center justify-end rounded-full bg-cover bg-center"
      style={{
        width: size,
        height: size,
        paddingBottom: 11 * scale,
        backgroundColor: "#04307f",
        backgroundImage: `url("${DEFAULT_LOGO}")`,
        boxShadow: "0 10px 24px rgba(11,42,122,.45)",
      }}
    >
      <span
        className="font-mono font-bold text-white tabular-nums"
        style={{
          fontSize: 11.5 * scale,
          padding: `${3 * scale}px ${6 * scale}px`,
          borderRadius: 7 * scale,
          background: "rgba(3,22,66,.82)",
          boxShadow: "0 0 0 1px rgba(255,255,255,.35)",
        }}
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

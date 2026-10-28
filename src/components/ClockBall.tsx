import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CLOCK_BALL_STORE } from "@/lib/clock-ball";
import { useAuth } from "@/lib/auth-context";
import { connectClockBall, useClockBallExtension } from "@/lib/use-clock-ball";
import { DEFAULT_LOGO, type Employee } from "@/lib/types";

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
      {/* Too small to read at icon sizes, so those pass no time. */}
      {time && (
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
      )}
    </div>
  );
}

const PROMO_DAYS = 2;
const PROMO_KEY = "clockBallPromoSince";

/** Whether the store prompt is still in its first two days on this browser. */
function useStorePromoWindow(): boolean {
  const [inWindow] = useState(() => {
    try {
      const since = Number(localStorage.getItem(PROMO_KEY));
      if (!since) {
        localStorage.setItem(PROMO_KEY, String(Date.now()));
        return true;
      }
      return Date.now() - since < PROMO_DAYS * 24 * 60 * 60 * 1000;
    } catch {
      // Private windows and blocked storage: show it rather than hide it for good.
      return true;
    }
  });
  return inWindow;
}

// One slim strip, so the punch card right below stays the first thing people see.
const BANNER =
  "flex items-center gap-3 rounded-xl bg-gradient-to-r from-[#0b2a7a] to-[#1d4ed8] px-3 py-2 text-sm text-white shadow-xs";
const BANNER_BUTTON =
  "inline-flex shrink-0 items-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-[#0b2a7a] hover:bg-white/90";

/**
 * The Clock Ball on the main screen, where people actually look. Not installed:
 * how to add it, for the first two days on each browser. Installed but not
 * signed in: a Connect button until it is. Set up: nothing.
 */
export function ClockBallBanner() {
  const inWindow = useStorePromoWindow();
  const extension = useClockBallExtension();
  const { employee } = useAuth();

  if (extension && !extension.connectedAs && employee) {
    return (
      <div className={BANNER}>
        <ClockBallPreview size={32} time="" />
        <p className="min-w-0 flex-1 leading-snug">
          <strong>Your Clock Ball isn't connected.</strong> Connect it to see your shift time on
          every website.
        </p>
        <button type="button" onClick={() => connectClockBall(employee)} className={BANNER_BUTTON}>
          Connect
        </button>
      </div>
    );
  }

  if (!inWindow || extension !== false) return null;
  return (
    <div className={BANNER}>
      <ClockBallPreview size={32} time="" />
      <p className="min-w-0 flex-1 leading-snug">
        <strong>New: the Clock Ball.</strong> Your shift time on every website. Add it, then click
        its icon → <strong>Continue with Google</strong> → <strong>Connect</strong>.{" "}
        <Link to="/app/clock-ball" className="whitespace-nowrap text-white/80 underline">
          How it works
        </Link>
      </p>
      <a href={CLOCK_BALL_STORE} target="_blank" rel="noreferrer" className={BANNER_BUTTON}>
        Add to Chrome
      </a>
    </div>
  );
}

/**
 * Shown in the extension's side panel when the extension isn't signed in yet:
 * the employee sees exactly which account it will follow, and can switch.
 */
export function ClockBallConnectPrompt({ employee }: { employee: Employee }) {
  const { user, logout } = useAuth();
  return (
    <div
      role="dialog"
      aria-label="Connect the Clock Ball"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border bg-card p-4 shadow-lift"
    >
      <div className="flex items-center gap-3">
        <ClockBallPreview size={48} time="0:00:00" />
        <p className="text-sm leading-snug">
          Connect the Clock Ball to <strong>{employee.name}</strong>
          <br />
          <span className="text-muted-foreground">{user?.email}</span>?
        </p>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => connectClockBall(employee)}
          className="flex-1 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Connect
        </button>
        <button
          type="button"
          // Signing out here brings up the sign-in page, where Google offers its account picker.
          onClick={() => void logout()}
          className="flex-1 rounded-xl border bg-secondary px-3 py-2 text-sm font-semibold text-secondary-foreground hover:bg-secondary/80"
        >
          Use another account
        </button>
      </div>
    </div>
  );
}

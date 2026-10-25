// Shared by the ball on web pages (ball.js) and the toolbar popup (popup.js).
// `var` so a second injection into the same page (after an update) cannot fail on redeclaring.

var CLOCK_BALL_COLORS = {
  blue: {
    name: "Ironbrij blue",
    light: "#6aa8ff",
    main: "#1d4ed8",
    dark: "#0b2a7a",
    eye: "#7dd3fc",
  },
  sky: { name: "Sky", light: "#a5f3fc", main: "#0ea5e9", dark: "#075985", eye: "#e0f2fe" },
  pink: { name: "Pink", light: "#ffb3dc", main: "#ec4899", dark: "#9d174d", eye: "#fce7f3" },
  purple: { name: "Purple", light: "#d8b4fe", main: "#8b5cf6", dark: "#4c1d95", eye: "#ede9fe" },
  green: { name: "Green", light: "#86efac", main: "#16a34a", dark: "#14532d", eye: "#dcfce7" },
  orange: { name: "Orange", light: "#fdba74", main: "#f97316", dark: "#9a3412", eye: "#ffedd5" },
  midnight: {
    name: "Midnight",
    light: "#64748b",
    main: "#1e293b",
    dark: "#020617",
    eye: "#38bdf8",
  },
};

var CLOCK_BALL_SIZE = 84;
// Overtime has no set end; if SavyTime can't be reached at all, the ball gives up after this.
var CLOCK_BALL_MAX_OPEN_MS = 16 * 60 * 60 * 1000;

/** What the ball shows at `now` (SavyTime's clock), or null when it should be hidden. */
function clockBallView(shift, now) {
  if (!shift || !shift.active || !shift.countFrom) return null;
  const breakSoFar = shift.pausedAt ? Math.max(0, now - shift.pausedAt) : 0;
  const endsAt = shift.endsAt
    ? shift.endsAt + breakSoFar
    : shift.countFrom + CLOCK_BALL_MAX_OPEN_MS;
  if (now < shift.countFrom - 60_000 || now >= endsAt) return null;
  return {
    time: clockBallTime((shift.pausedAt || now) - shift.countFrom),
    paused: Boolean(shift.pausedAt),
    // Shown on the computer's own clock.
    until: shift.endsAt ? endsAt - (shift.clockOffset || 0) : 0,
  };
}

/** A punch as the Firestore REST API returns it, cut down to what the ball needs. */
function clockBallPunch(doc) {
  const f = doc.fields || {};
  const str = (name) => (f[name] && (f[name].stringValue || f[name].timestampValue)) || "";
  return {
    id: doc.name.split("/").pop(),
    type: str("type"),
    company: str("companyId") || "default",
    companyName: str("companyName"),
    at: Date.parse(str("timestamp")) || 0,
    endsAt: Date.parse(str("scheduledShiftEnd")) || 0,
    voided: Boolean(f.voidedAt && !("nullValue" in f.voidedAt)),
  };
}

/**
 * The ball's state from the employee's recent punches (oldest first), read the
 * way SavyTime reads them: a start opens a session, and only a punch from that
 * session's company pauses or closes it.
 */
function clockBallFromPunches(punches) {
  let start = null;
  let breakMs = 0;
  let pausedAt = 0;
  for (const p of punches) {
    if (p.voided) continue;
    if (p.type === "in" || p.type === "extra_in") {
      start = p;
      breakMs = 0;
      pausedAt = 0;
      continue;
    }
    if (!start || p.company !== start.company) continue;
    if (p.type === "out" || p.type === "extra_out") start = null;
    else if (p.type === "lunch_start") pausedAt = p.at;
    else if (p.type === "lunch_end" && pausedAt) {
      breakMs += p.at - pausedAt;
      pausedAt = 0;
    }
  }
  if (!start) return { active: false, countFrom: 0, pausedAt: 0, endsAt: 0, company: "" };
  return {
    active: true,
    countFrom: start.at + breakMs,
    pausedAt,
    endsAt: start.type === "in" && start.endsAt > start.at ? start.endsAt + breakMs : 0,
    company: start.companyName,
  };
}

function clockBallTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** The ball itself: a visor with two robot eyes and the time underneath. */
function clockBallElement(doc) {
  const ball = doc.createElement("div");
  ball.className = "ball";
  const visor = doc.createElement("div");
  visor.className = "visor";
  visor.append(doc.createElement("i"), doc.createElement("i"));
  const time = doc.createElement("div");
  time.className = "time";
  const label = doc.createElement("div");
  label.className = "label";
  label.textContent = "BREAK";
  ball.append(visor, time, label);
  return { ball, time };
}

function clockBallCss(color) {
  return `
:host { all: initial; }
.ball {
  position: fixed; z-index: 2147483647; box-sizing: border-box;
  width: ${CLOCK_BALL_SIZE}px; height: ${CLOCK_BALL_SIZE}px; border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  background: radial-gradient(circle at 32% 26%, ${color.light} 0%, ${color.main} 52%, ${color.dark} 100%);
  box-shadow: 0 10px 24px ${color.dark}73, inset 0 -6px 12px rgba(0,0,0,.28), inset 0 4px 10px rgba(255,255,255,.35);
  cursor: grab; user-select: none; touch-action: none;
  font: 700 13px/1 ui-monospace, "SF Mono", Consolas, "Courier New", monospace;
  transition: transform .15s ease;
}
.ball:hover { transform: scale(1.05); }
.ball.dragging { cursor: grabbing; transform: scale(1.08); transition: none; }
.visor {
  display: flex; gap: 9px; align-items: center; justify-content: center;
  width: 46px; height: 20px; border-radius: 10px; background: #0a1330;
  box-shadow: inset 0 2px 4px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.25);
}
.visor i {
  display: block; width: 8px; height: 11px; border-radius: 4px;
  background: ${color.eye}; box-shadow: 0 0 6px ${color.eye}, 0 0 12px ${color.eye};
  animation: blink 5s infinite;
}
.time { color: #fff; letter-spacing: .5px; text-shadow: 0 1px 2px rgba(0,0,0,.4); font-variant-numeric: tabular-nums; }
.label { display: none; color: #fff; font-size: 8px; letter-spacing: 1.5px; opacity: .85; margin-top: -2px; }
.paused .visor i { height: 3px; animation: none; }
.paused .label { display: block; }
@keyframes blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
`;
}

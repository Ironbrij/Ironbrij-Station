// Shared by the ball on web pages (ball.js), the popup (popup.js) and the
// background worker (background.js).
// `var` so a second injection into the same page (after an update) cannot fail on redeclaring.

var CLOCK_BALL_SITE = "https://station.savykids.com";
// The live SavyTime's public web settings, the same ones its own pages ship with.
// A sign-in handed over by a SavyTime page brings that page's own settings instead
// (a copy running on a developer's computer may use another project).
var CLOCK_BALL_FIREBASE = {
  apiKey: "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
  projectId: "ironbrij-timestation",
  appId: "1:1094579363471:web:87518314d7de1779d85afa",
};

/**
 * Headers for Google's sign-in service. Firebase's own code sends the app ID, which
 * tells Google the project; without it Google goes by the key alone and can refuse
 * the sign-in as PROJECT_NUMBER_MISMATCH when the key was made in another project.
 */
function clockBallAuthHeaders(firebase, contentType) {
  return { "content-type": contentType, "X-Firebase-gmpid": firebase.appId };
}

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

var CLOCK_BALL_SIZES = { tiny: 52, small: 68, medium: 84, large: 108 };
// What a fresh install looks like; each can be changed from the popup.
var CLOCK_BALL_DEFAULTS = {
  face: "logo",
  color: "blue",
  size: "medium",
  blink: true,
  jokes: true,
  hat: "",
};
// Its own little jokes, shown now and then in a speech bubble.
var CLOCK_BALL_JOKES = [
  "Fun fact: I have never dropped the ball. I am the ball.",
  "No hands, no feet, still clocking more hours than my legs would.",
  "I am 100% circle. Can't cut corners even if I wanted to.",
  "My only skill is counting. Please don't tell my manager.",
  "Some balls go to the World Cup. I go to work.",
  "Keep the ball rolling, they said. I'm trying, I'm just a bit flat today.",
  "I blink so you think I'm working.",
  "Drag me anywhere. I have zero opinions and zero spine.",
  "I'm not lazy, I'm energy efficient. Mostly sphere.",
  "If I had a coffee I'd spill it. No hands, remember?",
  "I've been staring at this timer all day. It's literally my face.",
  "Round, blue and always on the clock. Living the dream.",
  "Break time? I'll just sit here. Like always.",
  "Technically I'm always on the ball. Technically.",
  "Someone please invent tiny arms so I can stretch.",
];
/** The look the employee picked, with the defaults filled in. */
function clockBallLook(saved) {
  const look = {};
  for (const [key, value] of Object.entries(CLOCK_BALL_DEFAULTS)) look[key] = saved[key] ?? value;
  return look;
}
// Overtime has no set end; if SavyTime can't be reached at all, the ball gives up after this.
var CLOCK_BALL_MAX_OPEN_MS = 16 * 60 * 60 * 1000;

/** What the ball shows at `now`, or null when it should be hidden. */
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
    until: shift.endsAt ? endsAt : 0,
  };
}

/** Runs a Firestore query as the signed-in employee; rows come back as plain documents. */
async function clockBallQuery(idToken, structuredQuery, firebase = CLOCK_BALL_FIREBASE) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${firebase.projectId}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery }),
    },
  );
  if (!response.ok) throw new Error(`SavyTime answered ${response.status}`);
  return (await response.json()).filter((row) => row.document).map((row) => row.document);
}

/** A string or timestamp field of a Firestore document, as text. */
function clockBallText(doc, name) {
  const value = (doc.fields || {})[name];
  return (value && (value.stringValue || value.timestampValue)) || "";
}

/** A punch as the Firestore REST API returns it, cut down to what the ball needs. */
function clockBallPunch(doc) {
  const text = (name) => clockBallText(doc, name);
  return {
    id: doc.name.split("/").pop(),
    type: text("type"),
    company: text("companyId") || "default",
    companyName: text("companyName"),
    at: Date.parse(text("timestamp")) || 0,
    endsAt: Date.parse(text("scheduledShiftEnd")) || 0,
    // Voided the way the app judges it: only when it has a value.
    voided: Boolean(text("voidedAt")),
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

/**
 * The ball itself: the Ironbrij logo (or a robot visor) with the time on it,
 * an optional hat on top and a speech bubble for its jokes.
 */
function clockBallElement(doc) {
  const ball = doc.createElement("div");
  ball.className = "ball";
  const hat = doc.createElement("img");
  hat.className = "hat";
  hat.alt = "";
  hat.hidden = true;
  const visor = doc.createElement("div");
  visor.className = "visor";
  visor.append(doc.createElement("i"), doc.createElement("i"));
  const time = doc.createElement("div");
  time.className = "time";
  const label = doc.createElement("div");
  label.className = "label";
  label.textContent = "BREAK";
  const bubble = doc.createElement("div");
  bubble.className = "bubble";
  ball.append(hat, visor, time, label, bubble);
  return { ball, time, hat, bubble };
}

/** Puts the chosen face, blink and hat on a ball made by clockBallElement. */
function clockBallDress(parts, look) {
  parts.ball.classList.toggle("logo", look.face !== "robot");
  parts.ball.classList.toggle("still", !look.blink);
  parts.hat.hidden = !look.hat;
  // shortcut: a page whose CSP forbids data: images shows no hat; fine for a decoration.
  if (look.hat && parts.hat.src !== look.hat) parts.hat.src = look.hat;
}

/** Drawn at 84px and scaled, so every size keeps the same look. */
function clockBallCss(color, size, logoUrl) {
  const px = (n) => `${Math.round(((n * size) / 84) * 10) / 10}px`;
  const shadow = `0 ${px(10)} ${px(24)} ${color.dark}73`;
  return `
:host { all: initial; }
.ball {
  position: fixed; z-index: 2147483647; box-sizing: border-box;
  width: ${size}px; height: ${size}px; border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${px(5)};
  background: radial-gradient(circle at 32% 26%, ${color.light} 0%, ${color.main} 52%, ${color.dark} 100%);
  box-shadow: ${shadow}, inset 0 ${px(-6)} ${px(12)} rgba(0,0,0,.28), inset 0 ${px(4)} ${px(10)} rgba(255,255,255,.35);
  cursor: pointer; user-select: none; touch-action: none;
  font: 700 ${px(13)}/1 ui-monospace, "SF Mono", Consolas, "Courier New", monospace;
  transition: transform .15s ease;
}
.ball:hover { transform: scale(1.05); }
.ball.dragging { cursor: grabbing; transform: scale(1.08); transition: none; }
.visor {
  display: flex; gap: ${px(9)}; align-items: center; justify-content: center;
  width: ${px(46)}; height: ${px(20)}; border-radius: ${px(10)}; background: #0a1330;
  box-shadow: inset 0 ${px(2)} ${px(4)} rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.25);
}
.visor i {
  display: block; width: ${px(8)}; height: ${px(11)}; border-radius: ${px(4)};
  background: ${color.eye}; box-shadow: 0 0 ${px(6)} ${color.eye}, 0 0 ${px(12)} ${color.eye};
  animation: blink 5s infinite;
}
.time { color: #fff; letter-spacing: ${px(0.5)}; text-shadow: 0 1px 2px rgba(0,0,0,.4); font-variant-numeric: tabular-nums; }
.label { display: none; color: #fff; font-size: ${px(8)}; letter-spacing: ${px(1.5)}; opacity: .85; margin-top: ${px(-2)}; }
.paused .visor i { height: ${px(3)}; animation: none; }
.paused .label { display: block; }

/* Ironbrij logo face: the time sits in a pill over the logo's dark lower half. */
.ball.logo {
  justify-content: flex-end; padding-bottom: ${px(11)};
  background: #04307f url("${logoUrl}") center / cover no-repeat;
  box-shadow: ${shadow};
  animation: glow 3.2s ease-in-out infinite;
}
.logo .visor, .logo .label { display: none; }
.logo .time {
  font-size: ${px(11.5)}; padding: ${px(3)} ${px(6)}; border-radius: ${px(7)};
  background: rgba(3, 22, 66, .82); box-shadow: 0 0 0 1px rgba(255,255,255,.35);
}
.logo.paused .time { background: rgba(180, 83, 9, .9); }
.still, .still .visor i { animation: none; }

.hat {
  position: absolute; left: 50%; bottom: 80%; width: 80%; height: auto;
  transform: translateX(-50%) rotate(-8deg); pointer-events: none;
}
.hat[hidden] { display: none; }
.bubble {
  position: absolute; top: 50%; right: calc(100% + ${px(10)}); transform: translateY(-50%);
  width: max-content; max-width: 220px; padding: 8px 11px; border-radius: 12px;
  background: #fff; color: #14213d; box-shadow: 0 6px 20px rgba(11,42,122,.25);
  font: 600 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left;
  opacity: 0; visibility: hidden; transition: opacity .25s ease; pointer-events: none;
}
.bubble.right { right: auto; left: calc(100% + ${px(10)}); }
.bubble.show { opacity: 1; visibility: visible; }
@keyframes blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
@keyframes glow {
  0%, 100% { box-shadow: ${shadow}, 0 0 0 0 rgba(106,168,255,0); }
  50% { box-shadow: ${shadow}, 0 0 0 ${px(5)} rgba(106,168,255,.35); }
}
`;
}

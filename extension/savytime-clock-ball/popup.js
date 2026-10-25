const $ = (id) => document.getElementById(id);
if (location.search.includes("welcome")) document.body.classList.add("page");

const root = $("preview").attachShadow({ mode: "open" });
const sheet = new CSSStyleSheet();
const still = new CSSStyleSheet();
still.replaceSync(".ball { position: relative; }");
root.adoptedStyleSheets = [sheet, still];
const parts = clockBallElement(document);
root.append(parts.ball);

let saved = {};

function minutesAgo(at) {
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function render() {
  const { shift, link, synced } = saved;
  const look = clockBallLook(saved);
  const view = link ? clockBallView(shift, Date.now()) : null;
  parts.time.textContent = view ? view.time : "0:00:00";
  parts.ball.classList.toggle("paused", Boolean(view && view.paused));
  sheet.replaceSync(
    clockBallCss(
      CLOCK_BALL_COLORS[look.color] || CLOCK_BALL_COLORS.blue,
      CLOCK_BALL_SIZES[look.size] || CLOCK_BALL_SIZES.medium,
      chrome.runtime.getURL("logo.png"),
    ),
  );
  clockBallDress(parts, look);
  for (const key of ["color", "size", "face"]) {
    for (const button of document.querySelectorAll(`[data-${key}]`)) {
      button.setAttribute("aria-pressed", String(button.dataset[key] === look[key]));
    }
  }
  // Colours tint the robot; the logo keeps Ironbrij's own.
  $("colours").hidden = look.face !== "robot";
  $("blink").checked = look.blink;
  $("jokes").checked = look.jokes;
  $("removeHat").hidden = !look.hat;

  $("signin").hidden = Boolean(link);
  $("signedin").hidden = !link;
  if (!link) {
    $("title").textContent = "Sign in to start";
    $("detail").textContent = "Use your Ironbrij SavyTime account.";
    // Why the last sign-in didn't stick, if one was tried.
    $("signinProblem").hidden = !synced?.error;
    $("signinProblem").textContent = synced?.error
      ? `Last sign-in ${minutesAgo(synced.at)} didn't work: ${synced.error}`
      : "";
    return;
  }
  const until = view?.until
    ? `Shift ends ${new Date(view.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "";
  $("title").textContent = !view ? "Not clocked in" : view.paused ? "On a break" : "Clocked in";
  $("detail").textContent = !view
    ? "Start work on SavyTime and the ball pops up."
    : [shift.company, until].filter(Boolean).join(" · ") || "The ball is counting your time.";
  $("who").textContent = link.name || link.email;
  $("synced").textContent = !synced
    ? "Checking your punches…"
    : synced.error
      ? `Couldn't check SavyTime ${minutesAgo(synced.at)}: ${synced.error}`
      : `Punches checked ${minutesAgo(synced.at)}`;
}

for (const [key, color] of Object.entries(CLOCK_BALL_COLORS)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.color = key;
  button.title = color.name;
  button.setAttribute("aria-label", color.name);
  button.style.background = `radial-gradient(circle at 32% 26%, ${color.light}, ${color.main} 55%, ${color.dark})`;
  button.addEventListener("click", () => chrome.storage.local.set({ color: key }));
  $("swatches").append(button);
}
for (const key of Object.keys(CLOCK_BALL_SIZES)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.size = key;
  button.textContent = key[0].toUpperCase() + key.slice(1);
  button.addEventListener("click", () => chrome.storage.local.set({ size: key }));
  $("sizes").append(button);
}

for (const button of document.querySelectorAll("[data-face]")) {
  button.addEventListener("click", () => chrome.storage.local.set({ face: button.dataset.face }));
}
for (const key of ["blink", "jokes"]) {
  $(key).addEventListener("change", () => chrome.storage.local.set({ [key]: $(key).checked }));
}
$("hatFile").addEventListener("change", () => {
  const file = $("hatFile").files[0];
  $("hatError").hidden = true;
  if (!file) return;
  if (file.type !== "image/png" || file.size > 500_000) {
    $("hatError").textContent = "Pick a PNG picture under 500 KB.";
    $("hatError").hidden = false;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => chrome.storage.local.set({ hat: reader.result });
  reader.readAsDataURL(file);
});
$("removeHat").addEventListener("click", () => chrome.storage.local.set({ hat: "" }));

// Known before the click: Chrome only opens the panel straight from the click itself.
let windowId = chrome.windows.WINDOW_ID_CURRENT;
chrome.windows.getCurrent().then((win) => (windowId = win.id));
$("open").addEventListener("click", () => {
  chrome.sidePanel.open({ windowId }).then(() => {
    if (!document.body.classList.contains("page")) window.close();
  });
});
// Google sign-in happens in SavyTime itself, in the side panel; once signed in
// there, SavyTime connects the extension to that account (see bridge.js).
$("google").addEventListener("click", () => {
  chrome.sidePanel.open({ windowId });
  $("googleHint").hidden = false;
});
$("reset").addEventListener("click", () => chrome.storage.local.remove("pos"));
$("signout").addEventListener("click", async () => {
  await chrome.storage.session.remove("token");
  await chrome.storage.local.remove(["link", "cache", "synced"]);
  await chrome.storage.local.set({ shift: { active: false } });
});

const SIGN_IN_ERRORS = {
  INVALID_LOGIN_CREDENTIALS: "Wrong email or password.",
  INVALID_PASSWORD: "Wrong email or password.",
  EMAIL_NOT_FOUND: "Wrong email or password.",
  INVALID_EMAIL: "That email doesn't look right.",
  USER_DISABLED: "This account has been turned off. Ask your admin.",
  TOO_MANY_ATTEMPTS_TRY_LATER: "Too many tries. Wait a minute and try again.",
};

/** Signs in with SavyTime's own account system and finds the employee it belongs to. */
async function signIn(email, password) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CLOCK_BALL_FIREBASE.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    const code = String(body.error?.message || "").split(" ")[0];
    throw new Error(SIGN_IN_ERRORS[code] || "Couldn't sign in. Check your internet and try again.");
  }
  // The same lookup SavyTime's own sign-in makes.
  const employees = await clockBallQuery(body.idToken, {
    from: [{ collectionId: "employees" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "email" },
        op: "EQUAL",
        value: { stringValue: body.email },
      },
    },
    limit: 10,
  });
  if (!employees.length) {
    throw new Error("This account isn't set up as a SavyTime employee yet. Ask your admin.");
  }
  const ids = new Set([body.localId]);
  for (const doc of employees) {
    ids.add(doc.name.split("/").pop());
    if (clockBallText(doc, "authUid")) ids.add(clockBallText(doc, "authUid"));
  }
  await chrome.storage.session.set({
    token: {
      value: body.idToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    },
  });
  await chrome.storage.local.remove(["cache", "synced"]);
  await chrome.storage.local.set({
    link: {
      refreshToken: body.refreshToken,
      email: body.email,
      name: clockBallText(employees[0], "name"),
      employeeIds: [...ids].slice(0, 10),
    },
  });
  chrome.runtime.sendMessage("sync");
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("submit").textContent = "Signing in…";
  $("error").hidden = true;
  try {
    await signIn($("email").value.trim(), $("password").value);
    $("password").value = "";
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "Sign in";
  }
});

chrome.storage.local.get(
  ["shift", "link", "synced", ...Object.keys(CLOCK_BALL_DEFAULTS)],
  (values) => {
    saved = values;
    render();
  },
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) saved[key] = newValue;
  render();
});
setInterval(render, 1000);

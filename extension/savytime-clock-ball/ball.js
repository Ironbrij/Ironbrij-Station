// Draws the clock ball on every page while the shift runs. It reads only the
// extension's storage, which the background worker keeps in step with the
// signed-in employee's punches, so no SavyTime tab needs to be open.
// Click it to open SavyTime in the side panel; drag it to move it.
(() => {
  if (window.top !== window) return;

  const GAP = 24;
  const LOOK_KEYS = Object.keys(CLOCK_BALL_DEFAULTS);
  const JOKE_FIRST_MS = 3 * 60e3;
  const JOKE_EVERY_MS = 30 * 60e3;
  const JOKE_SHOWN_MS = 8000;
  let shift = null;
  let look = clockBallLook({});
  let size = CLOCK_BALL_SIZES.medium;
  let pos = null;
  let host = null;
  let parts = null;
  let drag = null;
  let nextJokeAt = 0;
  const sheet = new CSSStyleSheet();

  function place() {
    const max = (space) => Math.max(8, space - size - 8);
    const x = pos ? pos.x : window.innerWidth - size - GAP;
    const y = pos ? pos.y : window.innerHeight - size - GAP;
    const left = Math.min(Math.max(8, x), max(window.innerWidth));
    parts.ball.style.left = `${left}px`;
    parts.ball.style.top = `${Math.min(Math.max(8, y), max(window.innerHeight))}px`;
    // The joke bubble opens towards the middle of the screen.
    parts.bubble.classList.toggle("right", left + size / 2 < window.innerWidth / 2);
  }

  function mount() {
    host = document.createElement("savytime-clock-ball");
    // Closed and with a constructed sheet, so the page's own CSS and CSP leave it alone.
    const root = host.attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [sheet];
    parts = clockBallElement(document);
    root.append(parts.ball);
    clockBallDress(parts, look);
    wirePointer(parts.ball);
    document.documentElement.append(host);
    nextJokeAt = Date.now() + JOKE_FIRST_MS;
    greet();
  }

  function say(text) {
    parts.bubble.textContent = text;
    parts.bubble.classList.add("show");
    setTimeout(() => parts?.bubble.classList.remove("show"), JOKE_SHOWN_MS);
  }

  // The first time the ball shows up for a newly signed-in employee, it introduces itself.
  function greet() {
    if (document.visibilityState !== "visible") return;
    chrome.storage.local.get(["link", "greetedFor"], ({ link, greetedFor }) => {
      if (!parts || !link || greetedFor === link.email) return;
      chrome.storage.local.set({ greetedFor: link.email });
      say(CLOCK_BALL_HELLO);
    });
  }

  function joke() {
    if (!look.jokes || document.visibilityState !== "visible" || Date.now() < nextJokeAt) return;
    nextJokeAt = Date.now() + JOKE_EVERY_MS;
    say(CLOCK_BALL_JOKES[Math.floor(Math.random() * CLOCK_BALL_JOKES.length)]);
  }

  function render() {
    // An updated extension injects a fresh copy; this old one steps aside.
    if (!chrome.runtime?.id) {
      host?.remove();
      window.clearInterval(timer);
      return;
    }
    const view = clockBallView(shift, Date.now());
    if (!view) {
      host?.remove();
      host = parts = null;
      return;
    }
    if (!host) mount();
    if (!host.isConnected) document.documentElement.append(host);
    parts.time.textContent = view.time;
    parts.ball.classList.toggle("paused", view.paused);
    const until = view.until
      ? ` · until ${new Date(view.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
    parts.ball.title = `SavyTime${shift.company ? ` · ${shift.company}` : ""}${until}${
      view.paused ? " · on a break" : ""
    }\nClick to open SavyTime · drag to move`;
    if (!drag) place();
    joke();
  }

  function wirePointer(ball) {
    ball.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = ball.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      ball.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ball.addEventListener("pointermove", (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) {
        return;
      }
      drag.moved = true;
      ball.classList.add("dragging");
      pos = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
      place();
    });
    ball.addEventListener("pointerup", () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      ball.classList.remove("dragging");
      // Saved for every tab, so the ball stays where it was put.
      if (moved) chrome.storage.local.set({ pos });
      // A click, not a drag: open SavyTime beside this page.
      else chrome.runtime.sendMessage("panel").catch(() => {});
    });
    ball.addEventListener("pointercancel", () => {
      drag = null;
      ball.classList.remove("dragging");
    });
  }

  function setLook(saved) {
    look = clockBallLook(saved);
    size = CLOCK_BALL_SIZES[look.size] || CLOCK_BALL_SIZES.medium;
    sheet.replaceSync(
      clockBallCss(
        CLOCK_BALL_COLORS[look.color] || CLOCK_BALL_COLORS.blue,
        size,
        chrome.runtime.getURL("logo.png"),
      ),
    );
    if (parts) clockBallDress(parts, look);
  }

  const lookSaved = {};
  setLook(lookSaved);
  chrome.storage.local.get(["shift", "pos", ...LOOK_KEYS], (saved) => {
    shift = saved.shift || null;
    pos = saved.pos || null;
    for (const key of LOOK_KEYS) lookSaved[key] = saved[key];
    setLook(lookSaved);
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.shift) shift = changes.shift.newValue || null;
    if (changes.pos && !drag) pos = changes.pos.newValue || null;
    if (LOOK_KEYS.some((key) => changes[key])) {
      for (const key of LOOK_KEYS) if (changes[key]) lookSaved[key] = changes[key].newValue;
      setLook(lookSaved);
    }
    render();
  });
  window.addEventListener("resize", () => parts && place());
  const timer = window.setInterval(render, 1000);
})();

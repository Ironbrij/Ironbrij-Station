// Draws the clock ball on every page while the shift runs. It reads only the
// extension's storage, so it keeps counting with SavyTime closed and comes back
// by itself when Chrome is reopened mid-shift.
(() => {
  if (window.top !== window) return;

  const GAP = 24;
  let shift = null;
  let colorKey = "blue";
  let pos = null;
  let host = null;
  let parts = null;
  let drag = null;
  const sheet = new CSSStyleSheet();

  function place() {
    const max = (size) => Math.max(8, size - CLOCK_BALL_SIZE - 8);
    const x = pos ? pos.x : window.innerWidth - CLOCK_BALL_SIZE - GAP;
    const y = pos ? pos.y : window.innerHeight - CLOCK_BALL_SIZE - GAP;
    parts.ball.style.left = `${Math.min(Math.max(8, x), max(window.innerWidth))}px`;
    parts.ball.style.top = `${Math.min(Math.max(8, y), max(window.innerHeight))}px`;
  }

  function mount() {
    host = document.createElement("savytime-clock-ball");
    // Closed and with a constructed sheet, so the page's own CSS and CSP leave it alone.
    const root = host.attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [sheet];
    parts = clockBallElement(document);
    root.append(parts.ball);
    wireDrag(parts.ball);
    document.documentElement.append(host);
  }

  function render() {
    // An updated extension injects a fresh copy; this old one steps aside.
    if (!chrome.runtime?.id) {
      host?.remove();
      window.clearInterval(timer);
      return;
    }
    const view = clockBallView(shift, Date.now() + ((shift && shift.clockOffset) || 0));
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
    parts.ball.title = `SavyTime${shift.company ? ` · ${shift.company}` : ""}${until}\nDrag me anywhere`;
    if (!drag) place();
  }

  function wireDrag(ball) {
    ball.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = ball.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      ball.setPointerCapture(event.pointerId);
      ball.classList.add("dragging");
      event.preventDefault();
    });
    ball.addEventListener("pointermove", (event) => {
      if (!drag) return;
      pos = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
      place();
    });
    const drop = () => {
      if (!drag) return;
      drag = null;
      ball.classList.remove("dragging");
      // Saved for every tab, so the ball stays where it was put.
      chrome.storage.local.set({ pos });
    };
    ball.addEventListener("pointerup", drop);
    ball.addEventListener("pointercancel", drop);
  }

  function setColor(key) {
    colorKey = CLOCK_BALL_COLORS[key] ? key : "blue";
    sheet.replaceSync(clockBallCss(CLOCK_BALL_COLORS[colorKey]));
  }

  setColor(colorKey);
  chrome.storage.local.get(["shift", "color", "pos"], (saved) => {
    shift = saved.shift || null;
    pos = saved.pos || null;
    setColor(saved.color);
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.shift) shift = changes.shift.newValue || null;
    if (changes.pos && !drag) pos = changes.pos.newValue || null;
    if (changes.color) setColor(changes.color.newValue);
    render();
  });
  window.addEventListener("resize", () => parts && place());
  const timer = window.setInterval(render, 1000);
})();

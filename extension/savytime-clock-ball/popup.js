const preview = document.getElementById("preview");
const root = preview.attachShadow({ mode: "open" });
const sheet = new CSSStyleSheet();
const still = new CSSStyleSheet();
still.replaceSync(".ball { position: relative; }");
root.adoptedStyleSheets = [sheet, still];
const parts = clockBallElement(document);
root.append(parts.ball);

let shift = null;
let colorKey = "blue";

function render() {
  const view = clockBallView(shift, Date.now() + ((shift && shift.clockOffset) || 0));
  parts.time.textContent = view ? view.time : "0:00:00";
  parts.ball.classList.toggle("paused", Boolean(view && view.paused));
  document.getElementById("title").textContent = !view
    ? "Not clocked in"
    : view.paused
      ? "On a break"
      : "Clocked in";
  const until =
    view && view.until
      ? `Shift ends ${new Date(view.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
  document.getElementById("detail").textContent = !view
    ? "Start work on SavyTime and the ball pops up."
    : [shift.company, until].filter(Boolean).join(" · ") || "The ball is counting your time.";
}

function setColor(key) {
  colorKey = CLOCK_BALL_COLORS[key] ? key : "blue";
  sheet.replaceSync(clockBallCss(CLOCK_BALL_COLORS[colorKey]));
  for (const button of document.querySelectorAll(".swatches button")) {
    button.setAttribute("aria-pressed", String(button.dataset.color === colorKey));
  }
}

const swatches = document.getElementById("swatches");
for (const [key, color] of Object.entries(CLOCK_BALL_COLORS)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.color = key;
  button.title = color.name;
  button.setAttribute("aria-label", color.name);
  button.style.background = `radial-gradient(circle at 32% 26%, ${color.light}, ${color.main} 55%, ${color.dark})`;
  button.addEventListener("click", () => {
    setColor(key);
    chrome.storage.local.set({ color: key });
  });
  swatches.append(button);
}

document
  .getElementById("reset")
  .addEventListener("click", () => chrome.storage.local.remove("pos"));

chrome.storage.local.get(["shift", "color"], (saved) => {
  shift = saved.shift || null;
  setColor(saved.color);
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.shift) shift = changes.shift.newValue || null;
  render();
});
setInterval(render, 1000);

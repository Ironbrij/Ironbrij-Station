// The ball in an always-on-top window (Document Picture-in-Picture), so it shows
// over every app, not only on web pages. Chrome only opens one from a click, and
// closes it with the page that opened it, so this page stays open as a pinned tab.
const $ = (id) => document.getElementById(id);
const SIZE = CLOCK_BALL_SIZES.large;
let saved = {};
let pip = null;
let parts = null;
let sheet = null;

chrome.tabs.getCurrent((tab) => tab && chrome.tabs.update(tab.id, { pinned: true }));

function render() {
  if (!pip) return;
  const look = clockBallLook(saved);
  const view = saved.link ? clockBallView(saved.shift, Date.now()) : null;
  sheet.replaceSync(
    clockBallCss(
      CLOCK_BALL_COLORS[look.color] || CLOCK_BALL_COLORS.blue,
      SIZE,
      chrome.runtime.getURL("logo.png"),
    ) +
      // Centred in its window instead of floating over a page.
      `.ball { position: relative; margin: 0 auto; } .ball:hover { transform: none; }
       body { margin: 0; height: 100vh; display: grid; place-content: center; gap: 6px;
              background: #eef3fc; font: 600 12px system-ui, sans-serif; color: #14213d; text-align: center; }`,
  );
  clockBallDress(parts, { ...look, hat: "" });
  parts.time.textContent = view ? view.time : "0:00:00";
  parts.ball.classList.toggle("paused", Boolean(view?.paused));
  pip.document.getElementById("status").textContent = !saved.link
    ? "Sign in to start"
    : !view
      ? "Not clocked in"
      : view.paused
        ? "On a break"
        : "";
}

$("pop").addEventListener("click", async () => {
  pip = await documentPictureInPicture.requestWindow({ width: 190, height: 190 });
  sheet = new pip.CSSStyleSheet();
  pip.document.adoptedStyleSheets = [sheet];
  pip.document.title = "SavyTime";
  parts = clockBallElement(pip.document);
  const status = pip.document.createElement("div");
  status.id = "status";
  pip.document.body.append(parts.ball, status);
  render();
  $("pop").hidden = true;
  $("open").hidden = false;
  pip.addEventListener("pagehide", () => {
    pip = parts = null;
    $("pop").hidden = false;
    $("open").hidden = true;
  });
});

chrome.storage.local.get(["shift", "link", ...Object.keys(CLOCK_BALL_DEFAULTS)], (values) => {
  saved = values;
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) saved[key] = newValue;
  render();
});
setInterval(render, 1000);

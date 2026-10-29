chrome.storage.local.get("site", ({ site }) => {
  document.getElementById("app").src = `${site || CLOCK_BALL_SITE}/app/punch`;
});

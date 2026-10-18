// Run before the page paints so a saved dark preference never flashes white.
export const themeScript = `(() => {
  let theme;
  try { theme = localStorage.getItem("savytime-theme"); } catch {}
  document.documentElement.classList.toggle("dark",
    theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches));
})();`;

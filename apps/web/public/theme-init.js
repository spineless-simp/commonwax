/*
 * Applies the member's saved appearance before React mounts, so there is no
 * flash of the default theme on load. Lives in its own same-origin file
 * rather than an inline <script> because the deployed CSP is `script-src
 * 'self'` with no `'unsafe-inline'` (see infrastructure/security-headers.conf)
 * — an inline script there is silently dropped by the browser, which is
 * exactly what let this run in local dev (no CSP) while doing nothing behind
 * the real proxy: the setting was saved, but never re-applied on load, until
 * a member touched the toggle again and the already-loaded app code applied
 * it directly.
 */
(function () {
  var chromeByTheme = { dark: "#080a09", dim: "#262922", light: "#ececE6", "dark-hc": "#000000", "light-hc": "#ffffff" };
  try {
    var theme = localStorage.getItem("cw:theme") || "dark";
    if (theme !== "dark") document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && chromeByTheme[theme]) meta.setAttribute("content", chromeByTheme[theme]);
    if (localStorage.getItem("cw:logo-invert") === "false") document.documentElement.setAttribute("data-logo-invert", "off");
    if (localStorage.getItem("cw:logo-border") === "true") document.documentElement.setAttribute("data-logo-border", "on");
  } catch (e) {}
})();

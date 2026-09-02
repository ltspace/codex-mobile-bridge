(() => {
  let theme = "dark";
  try {
    if (localStorage.getItem("codexBridge.theme") === "light") theme = "light";
  } catch {}

  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#ffffff" : "#0b0d12");
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute("content", theme === "light" ? "default" : "black-translucent");
})();

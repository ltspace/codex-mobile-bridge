const CACHE_NAME = "codex-bridge-shell-v7";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-180.png",
  "/icon-192.png",
  "/icon-512.png",
  "/modules/api.js",
  "/modules/elements.js",
  "/modules/event-stream.js",
  "/modules/formatters.js",
  "/modules/i18n.js",
  "/modules/markdown.js",
  "/modules/messages.js",
  "/modules/state.js",
  "/modules/theme-init.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("codex-bridge-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return await network || Response.error();
  })());
});

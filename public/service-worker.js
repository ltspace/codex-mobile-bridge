const APP_VERSION = "0.8.3";
const CACHE_PREFIX = "codex-bridge-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;
const NAVIGATION_TIMEOUT_MS = 3_500;
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
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
  "/modules/pwa.js",
  "/modules/state.js",
  "/modules/theme-init.js",
];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      SHELL.map((path) => new Request(path, { cache: "reload" })),
    )),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function timeoutAfter(milliseconds) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("navigation timeout")), milliseconds));
}

async function navigationResponse(event) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put("/index.html", response.clone());
    return response;
  });

  try {
    return await Promise.race([network, timeoutAfter(NAVIGATION_TIMEOUT_MS)]);
  } catch {
    const cached = await cache.match("/index.html");
    if (cached) {
      event.waitUntil(network.catch(() => null));
      return cached;
    }
    try {
      return await network;
    } catch {
      return new Response("Codex Bridge is offline. Reconnect to your tailnet and try again.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }
}

async function shellAssetResponse(request, pathname) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(pathname);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(pathname, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(event));
    return;
  }

  if (SHELL_PATHS.has(url.pathname)) event.respondWith(shellAssetResponse(request, url.pathname));
});

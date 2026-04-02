const CACHE_NAME = "love-sync-cache-v5";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg"
];
const NETWORK_FIRST_EXTENSIONS = new Set([".html", ".css", ".js", ".webmanifest"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;

  if (!isSameOrigin) {
    return;
  }

  if (requestUrl.pathname === "/app-config" || requestUrl.pathname === "/healthz") {
    return;
  }

  const extension = requestUrl.pathname.includes(".")
    ? requestUrl.pathname.slice(requestUrl.pathname.lastIndexOf("."))
    : "";
  const shouldUseNetworkFirst =
    event.request.mode === "navigate" || NETWORK_FIRST_EXTENSIONS.has(extension);

  if (shouldUseNetworkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          }

          if (event.request.mode === "navigate") {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", cloned));
          }

          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) {
            return cached;
          }

          return caches.match("/") || caches.match("/index.html");
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        return response;
      });
    })
  );
});

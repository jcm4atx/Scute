/* Scute service worker: offline app shell. API traffic is never cached here;
   the app keeps its own encrypted cache in IndexedDB. */
const VERSION = "scute-1.20.2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  // Take over immediately so upgrades don't wait for every tab to close.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return; // always network
  if (url.pathname.includes("/shared/")) return; // published shares: not part of the app
  if (/\/dav(\/|$)/.test(url.pathname)) return; // Scute Drive (WebDAV): always network, never cached

  // App navigations: network first, fall back to cached shell
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  // Plug-in files: network first so edits show up, cached copy when offline
  if (url.origin === self.location.origin && url.pathname.includes("/plugins/")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION + "-plugins").then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.open(VERSION + "-plugins").then((c) => c.match(req)).then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build assets: cache first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Web fonts: stale-while-revalidate
  if (/fontshare|fonts\.(googleapis|gstatic)/.test(url.hostname)) {
    e.respondWith(
      caches.open(VERSION + "-fonts").then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req)
            .then((res) => {
              c.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || net;
        }),
      ),
    );
  }
});

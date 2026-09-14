/* Service worker of the livreur space (registered with scope /livreur):
   makes the app installable and keeps the /livreur shell and its static
   assets available when the network drops. Data calls (Supabase) are never
   cached — the page keeps the last tour and the pending confirmations itself.

   v1 was registered for the whole site ("/"): when that old registration
   updates to this file it clears the old cache and unregisters itself, so
   the dashboard is no longer served by the driver's worker. */
const CACHE = "autodecision-livreur-v2";
const SHELL = ["/livreur", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
const MAX_STATIC = 80;
const ROOT_SCOPE = new URL(self.registration.scope).pathname === "/";

self.addEventListener("install", (event) => {
  if (!ROOT_SCOPE) {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => undefined)));
  }
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("autodecision-livreur-") && k !== CACHE).map((k) => caches.delete(k)),
      );
      if (ROOT_SCOPE) {
        await self.registration.unregister();
        return;
      }
      await self.clients.claim();
    })(),
  );
});

async function remember(req, res) {
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
  const statics = (await cache.keys()).filter((k) => new URL(k.url).pathname.startsWith("/_next/static/"));
  if (statics.length > MAX_STATIC) {
    await Promise.all(statics.slice(0, statics.length - MAX_STATIC).map((k) => cache.delete(k)));
  }
}

self.addEventListener("fetch", (event) => {
  if (ROOT_SCOPE) return; // the old site-wide worker never answers anymore
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase & co: network only
  if (url.pathname.startsWith("/api/")) return;

  const isStatic = url.pathname.startsWith("/_next/static/") || /\.(png|svg|webmanifest|woff2)$/.test(url.pathname);
  if (isStatic) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) void remember(req, res.clone());
            return res;
          }),
      ),
    );
    return;
  }

  if (req.mode === "navigate" && url.pathname.startsWith("/livreur")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) void remember(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/livreur"))),
    );
  }
});

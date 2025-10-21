// sw.js — cache-first pano fetch with bounded size (no runaway memory)
const VERSION = "v7";
const CACHE   = `pano-cache-${VERSION}`;
const PANO_RE = /\/panos\/.+\.(jpg|jpeg|png|webp)$/i;
const MAX_ENTRIES = 100;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.map((n) =>
        n.startsWith("pano-cache-") && n !== CACHE ? caches.delete(n) : Promise.resolve()
      )
    );
  })());
  self.clients.claim();
});

// Trim helper (best-effort)
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const toDelete = keys.length - MAX_ENTRIES;
  for (let i = 0; i < toDelete; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!PANO_RE.test(url.pathname)) return;

  // Cache-first, background refresh
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const fetchAndUpdate = (async () => {
      try {
        const resp = await fetch(request, { credentials: "same-origin", cache: "no-cache" });
        if (resp && resp.ok) {
          await cache.put(request, resp.clone());
          trimCache(cache).catch(() => {});
        }
        return resp;
      } catch {
        return null;
      }
    })();

    if (cached) {
      event.waitUntil(fetchAndUpdate);
      return cached;
    }
    const fresh = await fetchAndUpdate;
    return fresh || Response.error();
  })());
});

self.addEventListener("message", (event) => {
  const { type, urls } = event.data || {};
  if (type !== "precache" || !Array.isArray(urls) || urls.length === 0) return;

  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of urls) {
      try {
        const req = new Request(u, { credentials: "same-origin", cache: "no-cache" });
        const hit = await cache.match(req);
        if (!hit) {
          const resp = await fetch(req);
          if (resp && resp.ok) await cache.put(req, resp.clone());
        }
      } catch {}
    }
    trimCache(cache).catch(() => {});
  })());
});

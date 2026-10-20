const CACHE = "pointo-v6";
// ?v=6 sur les scripts/styles : l'ancien service worker (v5) les servait depuis son cache,
// ce qui aurait mélangé le nouveau HTML avec l'ancien JS au premier chargement de cette version.
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=6",
  "./app.js?v=6",
  "./calc.js?v=6",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Réseau d'abord pour tout : HTML et JS viennent toujours de la même version ; le cache ne sert qu'hors-ligne.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if(req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});

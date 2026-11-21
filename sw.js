// Service worker: works offline after the first visit, and adds the COOP/COEP headers
// that let ONNX Runtime use several CPU threads (static hosts like GitHub Pages can't set them).
const VERSION = 'v5';
const SHELL_CACHE = `shell-${VERSION}`;
const BIG_CACHE = 'big-v1'; // models + wasm: large, change rarely, kept across app updates
const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/common.js',
  'js/curl.js',
  'js/draw.js',
  'js/exercises.js',
  'js/pose.js',
  'js/squat.js',
  'vendor/ort/ort.webgpu.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL_CACHE && key !== BIG_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function cacheFirst(req) {
  const cache = await caches.open(BIG_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // 'no-cache' = always ask the server whether the file changed (the host lets browsers reuse a copy
    // for 10 minutes, which delayed updates); unchanged files cost a tiny "not modified" reply.
    const res = await Promise.race([
      fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.headers.has('range') || /\.(mp4|mov|m4v|webm)$/i.test(url.pathname)) return; // media: straight to network
  const big = /\.(onnx|wasm)$/.test(url.pathname);
  event.respondWith((big ? cacheFirst(req) : networkFirst(req)).then(isolate));
});

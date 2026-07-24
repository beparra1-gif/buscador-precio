// Subir este número cada vez que se despliegue un cambio en el app shell
// (index.html, style.css, app.js, manifest.json) para forzar la actualización de caché.
const CACHE_VERSION = 'v5';
const CACHE_NAME = `buscador-shell-${CACHE_VERSION}`;

const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Precios y catálogo: siempre a red, nunca cacheados (los datos cambian constantemente).
    if (url.hostname.includes('script.google.com')) {
        return;
    }

    // App shell: cache-first, para que la app cargue instantáneo y funcione sin conexión.
    const shellPaths = APP_SHELL.map(p => new URL(p, self.location).pathname);
    if (url.origin === self.location.origin && shellPaths.includes(url.pathname)) {
        e.respondWith(
            caches.match(e.request).then(cached => cached || fetch(e.request))
        );
        return;
    }

    // Fotos de productos: cache-first con relleno en segundo plano (network fallback si no está cacheada).
    if (url.pathname.includes('/fotos/')) {
        e.respondWith(
            caches.match(e.request).then(cached => {
                if (cached) return cached;
                return fetch(e.request).then(res => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                    }
                    return res;
                });
            })
        );
    }
});

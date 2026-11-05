// El app shell se sirve con "stale-while-revalidate": responde al tiro desde
// caché y en paralelo trae la versión nueva de la red, que queda lista para la
// próxima apertura. Así un cambio en app.js/index.html llega solo, sin depender
// de subir CACHE_VERSION. Subirlo sigue sirviendo para forzar una limpieza
// completa del shell (por ejemplo si se quita un archivo).
const CACHE_VERSION = 'v16';
const CACHE_SHELL = `buscador-shell-${CACHE_VERSION}`;

// Fotos y librerías van en cachés propios que NO dependen de CACHE_VERSION:
// subir la versión del shell ya no borra las fotos que el vendedor ya bajó.
const CACHE_FOTOS = 'buscador-fotos-v1';
const CACHE_LIBS = 'buscador-libs-v1';
const MAX_FOTOS = 400; // tope de fotos guardadas; se borran las más antiguas

const CACHES_VIGENTES = [CACHE_SHELL, CACHE_FOTOS, CACHE_LIBS];

const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

// Librerías de CDN (index.html). Versiones fijas, así que se pueden guardar para siempre.
const LIBS = [
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js',
    'https://unpkg.com/jspdf-autotable@5.0.8/dist/jspdf.plugin.autotable.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
        const shell = await caches.open(CACHE_SHELL);
        await shell.addAll(APP_SHELL);
        // Las librerías se intentan guardar, pero si el CDN falla no se bloquea la instalación
        const libs = await caches.open(CACHE_LIBS);
        await Promise.all(LIBS.map(url =>
            libs.match(url).then(ya => ya || libs.add(new Request(url, { mode: 'cors' }))).catch(() => {})
        ));
    })());
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => !CACHES_VIGENTES.includes(k)).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Borra las fotos más antiguas cuando se pasa del tope (caches.keys() viene en orden de inserción)
async function recortarFotos() {
    const cache = await caches.open(CACHE_FOTOS);
    const claves = await cache.keys();
    const sobran = claves.length - MAX_FOTOS;
    for (let i = 0; i < sobran; i++) await cache.delete(claves[i]);
}

function staleWhileRevalidate(e) {
    const red = fetch(e.request).then(res => {
        if (res.ok) {
            const copia = res.clone();
            caches.open(CACHE_SHELL).then(cache => cache.put(e.request, copia));
        }
        return res;
    });
    e.waitUntil(red.then(() => {}, () => {}));
    return caches.match(e.request).then(cached => cached || red);
}

function cacheFirst(e, nombreCache, alGuardar) {
    return caches.open(nombreCache).then(cache =>
        cache.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res.ok) {
                    const copia = res.clone();
                    e.waitUntil(cache.put(e.request, copia).then(() => alGuardar && alGuardar()));
                }
                return res;
            });
        })
    );
}

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);

    // Precios y catálogo: siempre a red, nunca cacheados (los datos cambian constantemente).
    if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) {
        return;
    }

    if (url.origin === self.location.origin) {
        const shellPaths = APP_SHELL.map(p => new URL(p, self.location).pathname);
        if (shellPaths.includes(url.pathname)) {
            e.respondWith(staleWhileRevalidate(e));
            return;
        }
        if (url.pathname.includes('/fotos/')) {
            e.respondWith(cacheFirst(e, CACHE_FOTOS, recortarFotos));
            return;
        }
    }

    if (LIBS.includes(e.request.url)) {
        e.respondWith(cacheFirst(e, CACHE_LIBS));
    }
});

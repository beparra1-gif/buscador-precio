// Esto permite que el navegador reconozca la web como una App instalable
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Instalado');
});

self.addEventListener('fetch', (e) => {
    // Permite que siga funcionando online normalmente
});
// Permite instalar Vaelo como app en el celular. Guarda solo archivos de diseño; los datos siempre se piden en vivo.
const CACHE = 'vaelo-v2';
const ARCHIVOS = ['/css/styles.css', '/js/comun.js', '/img/logo-blanco.png', '/img/logo-negro.png', '/img/icono-192.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Primero la red (para tener siempre lo último); si no hay internet, lo guardado
  ev.respondWith(
    fetch(ev.request).then((r) => {
      if (r.ok && ARCHIVOS.includes(url.pathname)) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copia)); }
      return r;
    }).catch(() => caches.match(ev.request).then((r) => r || new Response('Sin conexión. Revisa tu internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});

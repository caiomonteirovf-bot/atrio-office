/**
 * Átrio Office — Service Worker com push notifications (v2).
 *
 * network-first pra HTML/JS/CSS; cache-first pra assets estáticos.
 * NÃO cacheia /api/* nem /ws.
 */

const CACHE_VERSION = 'atrio-office-v1778594919324';
const STATIC_ASSETS = [
  '/favicon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(STATIC_ASSETS).catch(() => null)
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  if (/\.(png|svg|ico|woff2?|ttf)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy)).catch(() => {});
          return resp;
        })
      )
    );
    return;
  }

  event.respondWith(
    fetch(request).then((resp) => {
      if (resp.ok && request.method === 'GET') {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(request).then(c => c || caches.match('/')))
  );
});

// === Push notifications ===
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Átrio Office', body: event.data.text() }; }

  const title = payload.title || 'Átrio Office';
  const opts = {
    body: payload.body || '',
    icon: payload.icon || '/pwa-icon-192.png',
    badge: '/pwa-icon-192.png',
    tag: payload.tag || 'atrio-push',
    data: { url: payload.url || '/' },
    renotify: true,
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.focus();
          c.navigate(targetUrl).catch(() => {});
          return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

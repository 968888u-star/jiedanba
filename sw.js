const CACHE_NAME = 'jiedan-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // 这里的监听器是为了告诉浏览器，这个网站支持离线拦截
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

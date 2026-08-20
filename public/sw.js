// Service worker для офлайн-работы PWA.
// Все пути относительные: приложение живёт в подкаталоге GitHub Pages (например /password/).
const CACHE = 'safekey-shell-v3'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './app-config.js']

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
))

self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())
))

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  // Кэшируем только собственные файлы приложения; к Яндекс Диску не прикасаемся
  if (url.origin !== self.location.origin) return
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone()
      caches.open(CACHE).then(cache => cache.put(event.request, copy))
      return response
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
  )
})

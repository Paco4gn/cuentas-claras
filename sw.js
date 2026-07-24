const cacheName = 'cuentas-claras-v2'
const scopeUrl = new URL(self.registration.scope)
const basePath = scopeUrl.pathname.replace(/\/$/, '')
const withBase = (path) => `${basePath}${path}`
const assets = [withBase('/'), withBase('/index.html'), withBase('/manifest.webmanifest'), withBase('/favicon.svg')]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== location.origin || !requestUrl.pathname.startsWith(`${basePath}/`)) return
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone()
          caches.open(cacheName).then((cache) => cache.put(event.request, clone))
          return response
        })
        .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(withBase('/index.html')))),
    )
    return
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((response) => {
        const clone = response.clone()
        caches.open(cacheName).then((cache) => cache.put(event.request, clone))
        return response
      })
    }),
  )
})

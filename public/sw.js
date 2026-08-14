const cacheName = 'cazamorosos-v5'
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

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('push', (event) => {
  const fallback = { title: 'Pago avisado', body: 'Alguien ha confirmado un pago en CazaMorosos.', url: withBase('/?avisos=pagos') }
  let payload = fallback
  try {
    const data = event.data?.json() || {}
    payload = {
      title: data.notification?.title || data.title || fallback.title,
      body: data.notification?.body || data.body || fallback.body,
      url: data.data?.url || data.url || fallback.url,
    }
  } catch {
    payload = fallback
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      badge: withBase('/favicon.svg'),
      icon: withBase('/favicon.svg'),
      tag: 'payment-confirmation',
      data: { url: payload.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || withBase('/?avisos=pagos')
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const appClient = clientList.find((client) => client.url.startsWith(self.registration.scope))
      if (appClient) {
        appClient.focus()
        appClient.navigate(targetUrl)
        return
      }
      return self.clients.openWindow(targetUrl)
    }),
  )
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

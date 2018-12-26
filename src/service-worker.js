// The Service Worker acts like an HTTP server, serving all your "local" files
// so they are accessible. You can navigate to "local" HTML pages, use "local"
// files as the 'src' for image tags, CSS tags, and script tags.
import { serve } from './serve.js'

// Eagerly claim pages
self.addEventListener('activate', event => {
  return event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', event => {
  // Try serving from the file system.
  event.respondWith(serve(path))
})

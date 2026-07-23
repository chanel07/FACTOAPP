importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// Service worker mínimo — solo lo necesario para que Chrome/Android ofrezca "Instalar"
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

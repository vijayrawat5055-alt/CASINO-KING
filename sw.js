// Minimal service worker so the browser offers 'Install app'. The games need the internet, so nothing is cached.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});

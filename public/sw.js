const CACHE='moviwatch-shell-v1';
const SHELL=['/','/manifest.webmanifest','/assets/moviwatch-app-icon.svg','/assets/moviwatch-logo-4k.svg','/pwa-install.css','/pwa-install.js'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const c=await caches.open(CACHE);await Promise.all(SHELL.map(async p=>{try{const r=await fetch(p,{cache:'reload'});if(r.ok)await c.put(p,r)}catch{}}));await self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('moviwatch-shell-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim()})()));
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET')return;const u=new URL(req.url);if(u.origin!==location.origin)return;
// Never cache APIs, movie/watch routes, downloads, admin pages, or byte-range requests.
if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/watch/')||u.pathname==='/admin'||u.pathname==='/admin.html'||req.headers.has('Range'))return;
if(req.mode==='navigate'){event.respondWith((async()=>{try{const r=await fetch(req);if(r.ok&&u.pathname==='/'){const c=await caches.open(CACHE);await c.put('/',r.clone())}return r}catch{return await caches.match('/')||Response.error()}})());return}
if(u.pathname.startsWith('/assets/')||u.pathname==='/manifest.webmanifest'||u.pathname==='/pwa-install.css'||u.pathname==='/pwa-install.js')event.respondWith((async()=>{const c=await caches.o¶»§q«^
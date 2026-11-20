const CACHE='moviwatch-shell-v3';
const SHELL=['/','/manifest.webmanifest','/assets/moviwatch-app-icon.svg','/assets/moviwatch-logo-4k.svg','/pwa-install.css','/pwa-install.js'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await Promise.all(SHELL.map(async path=>{try{const response=await fetch(path,{cache:'reload'});if(response.ok)await cache.put(path,response)}catch{}}));
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const keys=await caches.keys();
 await Promise.all(keys.filter(key=>key.startsWith('moviwatch-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request;if(request.method!=='GET')return;
 const url=new URL(request.url);if(url.origin!==self.location.origin)return;
 // Never cache APIs, watch pages, downloads, admin, or byte-range requests.
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/watch/')||url.pathname==='/admin'||url.pathname==='/admin.html'||request.headers.has('Range'))return;
 if(request.mode==='navigate'){
  event.respondWith((async()=>{
   try{const response=await fetch(request);if(response.ok&&url.pathname==='/'){const cache=await caches.open(CACHE);await cache.put('/',response.clone())}return response}
   catch{return await caches.match('/')||Response.error()}
  })());return;
 }
 if(url.pathname.startsWith('/assets/')||url.pathname==='/manifest.webmanifest'||url.pathname==='/pwa-install.css'||url.pathname==='/pwa-install.js'){
  event.respondWith((async()=>{const cache=await caches.open(CACHE);const cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response})());
 }
});
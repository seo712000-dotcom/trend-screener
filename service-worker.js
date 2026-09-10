const CACHE_NAME="trend-screener-v58-1-audit";
const CACHE_PREFIX="trend-screener-";
const APP_SHELL=["./","index.html","paper-engine.js","manifest.json"];
self.addEventListener("install",event=>event.waitUntil(
  caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting())
));
self.addEventListener("activate",event=>event.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE_NAME)
    .map(key=>caches.delete(key)))).then(()=>self.clients.claim())
));
self.addEventListener("fetch",event=>{
  const request=event.request,url=new URL(request.url),scope=new URL(self.registration.scope);
  // 연결키·API 응답·다른 앱은 캐시하지 않습니다.
  if(request.method!=="GET"||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname)||
    url.searchParams.has("action")||url.searchParams.has("callback")||url.searchParams.has("key"))return;
  const relative=url.pathname.slice(scope.pathname.length)||"index.html";
  if(relative!=="index.html"&&!APP_SHELL.includes(relative))return;
  event.respondWith(fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME)
      .then(cache=>cache.put(request,copy)).catch(()=>{}))}
    return response;
  }).catch(async()=>{
    const cache=await caches.open(CACHE_NAME);
    return await cache.match(request)||await cache.match(relative)||
      (request.mode==="navigate"?await cache.match("index.html"):null)||Response.error();
  }));
});

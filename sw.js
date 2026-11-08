/* 離線快取：程式檔先問網路（有更新就用新的），連不上才用快取，所以沒有網路也能打開。日誌資料不在這裏，存在 IndexedDB。 */
const CACHE = "diary-pwa-v2"
const FILES = ["./", "index.html", "host-pwa.js", "diary_template.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"]
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())) })
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) })
self.addEventListener("fetch", e => {
  const r = e.request
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)) } return res }).catch(() => caches.match(r, { ignoreSearch: true })))
})
/* 點提醒通知：日誌已經開著（含背景）就叫到前面，並請它切到「提醒清單」（訊息由 host-pwa.js 接收）；沒開著就打開日誌，網址帶 ?tab=rem 直接進提醒清單。 */
self.addEventListener("notificationclick", e => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const c = list.find(x => x.url.startsWith(self.registration.scope))
    if (c) { c.postMessage({ type: "diary-open-rem" }); return c.focus() }
    return self.clients.openWindow(new URL("./?tab=rem", self.registration.scope).href)
  }))
})

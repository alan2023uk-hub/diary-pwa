/* 離線快取：程式檔先問網路（有更新就用新的；no-cache＝每次都向伺服器確認，不吃瀏覽器自己的暫存，所以上傳新檔後重開就是新版），連不上才用快取，所以沒有網路也能打開。日誌資料不在這裏，存在 IndexedDB。 */
const CACHE = "diary-pwa-v5"
const FILES = ["./", "index.html", "host-pwa.js", "diary_template.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"]
/* 編者按 / Editor's note：PDF 閱讀工具（pdf.js）的兩個檔案另外放在「選用」清單，用逐個 add 並吞掉錯誤；不要併進上面的 FILES。
   FILES 用 addAll：只要有一個檔案抓不到，整個安裝就失敗，日誌會一直停在舊版、也沒有離線快取。（使用者還沒上傳 pdf 工具檔時，不能因此壞掉整個日誌。）
   The two pdf.js files are OPTIONAL and added one by one with errors swallowed; do not merge them into FILES. addAll fails the whole install if any single file is missing, which would freeze the diary on the old version with no offline cache. */
const OPTIONAL = ["pdf.min.mjs", "pdf.worker.min.mjs"]
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).then(() => Promise.all(OPTIONAL.map(f => c.add(f).catch(() => {}))))).then(() => self.skipWaiting())) })
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("diary-pwa-") && k !== CACHE).map(k => caches.delete(k))   /* 只清日誌自己的舊快取：同一個 github.io 網站下還有 UKHKbus、LondonBus，不能刪它們的 */)).then(() => self.clients.claim())) })
self.addEventListener("fetch", e => {
  const r = e.request
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return
  e.respondWith(fetch(r, { cache: "no-cache" }).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)) } return res }).catch(() => caches.match(r, { ignoreSearch: true })))
})
/* 點提醒通知：日誌已經開著（含背景）就叫到前面，並請它切到「提醒清單」（訊息由 host-pwa.js 接收）；沒開著就打開日誌，網址帶 ?tab=rem 直接進提醒清單。 */
self.addEventListener("notificationclick", e => {
  e.notification.close()
  const bk = !!(e.notification.data && e.notification.data.tab === "backup")   /* 「該備份了」：不進提醒清單；日誌已開著就請它馬上彈出備份視窗（訊息由 host-pwa.js 接收），沒開著就打開日誌（約 5 秒後自己檢查、彈出） */
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const c = list.find(x => x.url.startsWith(self.registration.scope))
    if (c) { c.postMessage({ type: bk ? "diary-bkrem" : "diary-open-rem" }); return c.focus() }
    return self.clients.openWindow(new URL(bk ? "./" : "./?tab=rem", self.registration.scope).href)
  }))
})
/* 推播：日誌關閉時由伺服器叫醒。伺服器只送「哪一天」；通知文字在這裏從本機的 IndexedDB 讀出（和 host-pwa.js 的 remCheck / remText 同一套規則），日誌內容不經過伺服器。
   顯示後把這次記進 remfired，日誌下次打開時不會再重複提醒。iOS 規定每個推播都必須顯示通知，所以讀不到資料時也會顯示一則簡單的「日誌提醒」。 */
const remDays = r => Math.max(1, Math.min(60, r.repeat || 1))
const occTime = (r, k) => { const d = new Date(r.due); d.setDate(d.getDate() + k); return d.getTime() }
function dueOccurrence(r, now) { let k = -1; for (let i = 0; i < remDays(r); i++) { if (occTime(r, i) <= now) k = i; else break } return k }
const kvOpen = () => new Promise((res, rej) => { const q = indexedDB.open("diary-host", 1); q.onupgradeneeded = () => q.result.createObjectStore("kv"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
const kvGet = (db, k) => new Promise(res => { try { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined) } catch (e) { res(undefined) } })
const kvPut = (db, k, v) => new Promise(res => { try { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); t.onabort = () => res() } catch (e) { res() } })
function remText(date, fb, rows, edits) {   // 通知內文：這一天現在的文字，去掉「19. 星期一」那行標題
  const e = edits.find(r => r.date === date && !r.del)
  const raw = rows.find(x => x[0] === date && !x[3])
  const full = e ? (e.deleted ? (fb || "") : (e.text || "")) : (raw ? raw[2] : (fb || ""))
  const lines = full.split("\n").filter(l => l.trim() !== "")
  if (raw && lines.length > 1 && new RegExp("^\\s*" + parseInt(date.slice(8)) + "\\s*[.．]").test(lines[0])) lines.shift()
  return lines.map(l => l.trim()).join(" ").slice(0, 200)
}
/* 備份提醒的推播：伺服器只認「日期＋時間」，所以借用日誌沒有的 1999-01-01（和 host-pwa.js 的 BK_PUSH_DATE 一樣）。到點時先在本機再核對一次還要不要提醒（備份、關閉都在本機的 IndexedDB），
   不需要了也照樣顯示一則簡單的通知（iOS 規定每個推播都必須顯示通知）。 */
const BK_DATE = "1999-01-01"
const bkAt = (ms, plus, min) => { const t = new Date(ms); return new Date(t.getFullYear(), t.getMonth(), t.getDate() + plus, Math.floor(min / 60), min % 60).getTime() }
function bkAgo(ms) {
  if (!ms) return "還沒有手動備份的記錄"
  const a = new Date(ms), n = new Date(), d = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5)
  return "上次手動備份：" + (d <= 0 ? "今天" : d === 1 ? "昨天" : d + " 天前")
}
async function bkNote() {
  let title = "該備份了", body = "打開日誌，按「立即備份」。"
  try {
    const db = await kvOpen()
    const cfg = (await kvGet(db, "bkrem:cfg")) || {}, last = Number(await kvGet(db, "bk:lastManual")) || 0
    db.close()
    const days = Number.isInteger(cfg.days) && cfg.days >= 0 && cfg.days <= 365 ? cfg.days : 7
    const min = Number.isInteger(cfg.min) && cfg.min >= 0 && cfg.min < 1440 ? cfg.min : 1200
    const due = last ? bkAt(last, days, min) : 0
    if (days <= 0 || Date.now() < due - 120000) { title = "備份提醒"; body = "這則提醒已經不需要了（已經備份過，或提醒已關閉）。" }
    else body = bkAgo(last) + "。打開日誌，按「立即備份」。"
  } catch (e) {}
  await self.registration.showNotification(title, { body, tag: "diarybkrem", icon: "icon-180.png", data: { tab: "backup" } })
}
async function pushNote(data) {
  const date = data && typeof data.date === "string" ? data.date : ""
  if (date === BK_DATE) return bkNote()
  let title = "日誌提醒", body = ""
  try {
    const db = await kvOpen()
    const rems = (await kvGet(db, "reminders")) || [], rows = (await kvGet(db, "rows")) || [], edits = (await kvGet(db, "edits")) || []
    const r = rems.find(x => x && x.date === date && !x.del && x.due)
    if (r) {
      const n = remDays(r), k = Math.max(0, dueOccurrence(r, Date.now()))
      title = "日誌提醒 " + parseInt(date.slice(5, 7)) + "月" + parseInt(date.slice(8)) + "日"
      body = remText(date, r.txt, rows, edits) + (n > 1 ? "\n（第 " + (k + 1) + "/" + n + " 天）" : "")
      const fired = (await kvGet(db, "remfired")) || {}
      fired[date] = { due: r.due, k }
      await kvPut(db, "remfired", fired)
    }
    db.close()
  } catch (e) {}
  await self.registration.showNotification(title, { body, tag: "diaryrem_" + (date || "x"), icon: "icon-180.png", data: { tab: "rem" } })
}
self.addEventListener("push", e => {
  let d = null
  try { d = e.data && e.data.json() } catch (x) {}
  e.waitUntil(pushNote(d))
})
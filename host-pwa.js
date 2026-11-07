/* 日誌 PWA 宿主（第二個宿主）
   頁面（diary_template.html）只負責介面，所有「要宿主幫忙」的事都用 hostSend 發訊息；這個檔案就是 PWA 這一邊的宿主：
     · 儲存：日誌資料（rows）和修改（edits）存在這部裝置的瀏覽器裏（IndexedDB），不上傳到任何地方
     · 組頁：把模板、日誌資料、修改組成頁面，寫進目前的視窗
     · 訊息：頁面的 hostSend 不再導向網址，改由 window.HOST_DELIVER 直接交給 PwaHost.handle
   目前支援：同步（修改存進宿主）、打開連結。照片、提醒、天氣、備份、還原還沒開放（會在頁面上提示）。 */
(function (root) {
  "use strict"
  const DATERE = /^\d{4}-\d{2}-\d{2}$/
  const DB_NAME = "diary-host", KV = "kv"

  // ---------- 儲存：IndexedDB（正式）／記憶體（測試用）----------
  function idbStore() {
    let dbp = null
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(KV)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    }))
    const tx = async (mode, fn) => {
      const db = await open()
      return new Promise((res, rej) => {
        const t = db.transaction(KV, mode), q = fn(t.objectStore(KV))
        t.oncomplete = () => res(q && q.result)
        t.onerror = () => rej(t.error)
        t.onabort = () => rej(t.error)
      })
    }
    return { get: k => tx("readonly", s => s.get(k)), set: (k, v) => tx("readwrite", s => s.put(v, k)), del: k => tx("readwrite", s => s.delete(k)) }
  }
  function memStore() {
    const m = new Map()
    return { get: async k => m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined, set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))) }, del: async k => { m.delete(k) } }
  }
  let store = null
  const getStore = () => store || (store = idbStore())

  // ---------- 資料：日誌列（rows）和修改（edits）----------
  // 一列＝[日期, 星期, 文字, 是否前言]；前言列的日期是「年-00-00」
  const validRow = r => Array.isArray(r) && typeof r[0] === "string" && DATERE.test(r[0]) && typeof r[2] === "string"
  const rowKey = r => r[0] + (r[3] ? "#pre" : "")
  function mergeRows(existing, incoming) {   // 同一天（前言另算）以後來的為準
    const by = new Map((existing || []).map(r => [rowKey(r), r]))
    for (const r of incoming) by.set(rowKey(r), r)
    return [...by.values()]
  }
  function sortRows(all) {   // 和 Scriptable 宿主一樣：日期由舊到新，同一天前言排前面
    return all.slice().sort((a, b) => a[0] === b[0] ? ((b[3] ? 1 : 0) - (a[3] ? 1 : 0)) : (a[0] < b[0] ? -1 : 1))
  }
  function mergeEdits(existing, incoming) {   // 和 Scriptable 宿主 liveMerge 同一個規則：同一天，時間較新（或一樣）的留下
    const by = new Map((existing || []).map(r => [r.date, r]))
    for (const r of incoming) {
      const ex = by.get(r.date)
      if (!ex || (r.t || 0) >= (ex.t || 0)) by.set(r.date, r)
    }
    return [...by.values()]
  }

  // ---------- 組頁：模板 + 日誌資料 + 修改 ----------
  function assemble(tpl, rows, edits, opts) {
    opts = opts || {}
    if (!tpl.includes("__DATA__")) throw new Error("模板裏找不到 __DATA__")
    const esc = o => JSON.stringify(o).replace(/</g, "\\u003c")
    const html = tpl.replace("__DATA__", () => JSON.stringify(sortRows(rows)).replace(/<\//g, "<\\/"))
    const head = '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png">' +
      '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="日誌">'
    const inject = "<script>window.ICLOUD_EDITS=" + esc(edits) + ";window.UNDATED=0;window.PHOTOS_LOADED=false;window.OFFLINE=0;window.LIVE=true;window.HOST_NO_LIMIT=true;window.GOTO=" + esc(opts.go || "") + "</script>" +
      '<script src="host-pwa.js"></script><script>window.HOST_DELIVER=function(u){PwaHost.handle(u)}</script>'
    return html.replace("</head>", () => head + inject + "</head>")
  }

  // ---------- 訊息：頁面 hostSend 發來的網址 ----------
  function parse(u) {   // scriptable:///run?scriptName=日誌&k=v&… → { k: v }（編碼方式由頁面的 hostURL 決定，這裏只負責解開）
    const p = {}, q = String(u).split("?")[1] || ""
    for (const kv of q.split("&")) {
      if (!kv) continue
      const i = kv.indexOf("=")
      try { p[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1)) } catch (e) {}
    }
    return p
  }
  const UNSUPPORTED = { backup: "備份", restore: "還原", addphoto: "照片", delphoto: "照片", movephoto: "照片", loadphotos: "照片", remsave: "提醒", wxcfg: "天氣設定" }
  function actionOf(p) {   // 這個訊息要做什麼：同步（沒有任何動作參數）、打開連結，或還沒開放的動作名
    if (p.openurl) return "open"
    for (const k of Object.keys(UNSUPPORTED)) if (p[k] !== undefined) return k
    return "sync"
  }
  const say = m => { try { root.toast(m, 3500) } catch (e) {} }
  async function mergeIncoming(p) {   // 頁面附上的待同步修改，併進宿主的 edits
    try {
      const raw = p.data || await root.navigator.clipboard.readText()
      const incoming = (JSON.parse(raw).edits || []).filter(r => r && typeof r === "object" && DATERE.test(r.date || ""))
      const s = getStore()
      await s.set("edits", mergeEdits(await s.get("edits") || [], incoming))
      return true
    } catch (e) { say("同步失敗：" + (e && e.message || e)); return false }
  }
  async function pushCloud() {   // 把宿主現有的修改推回頁面（頁面的 __cloudUpdate 會合併、清掉「待同步」、必要時重畫）
    const edits = await getStore().get("edits") || []
    if (typeof root.__cloudUpdate === "function") await root.__cloudUpdate(edits, 0)
  }
  function openUrl(u) {
    if (/^https?:\/\//i.test(u)) root.open(u, "_blank", "noopener")
    else if (/^mailto:[^\s]+$/i.test(u)) root.location.href = u
  }
  async function run(u) {
    const p = parse(u)
    if (p.scriptName !== "日誌") return
    const merged = (p.data || p.via === "clip") ? await mergeIncoming(p) : false
    const act = actionOf(p)
    if (act === "open") openUrl(p.openurl)
    else if (act !== "sync") say("「" + UNSUPPORTED[act] + "」在 PWA 版還沒開放")
    if (merged) await pushCloud()
  }
  let queue = Promise.resolve()   // 一個一個處理，免得連按兩下時互相蓋掉
  function handle(u) { queue = queue.then(() => run(u)).catch(e => say("出錯了：" + (e && e.message || e))); return queue }

  // ---------- 啟動：有資料就組頁；沒有就先請使用者匯入 ----------
  async function launch() {
    const r = await fetch("diary_template.html", { cache: "no-cache" })
    if (!r.ok) throw new Error("讀不到 diary_template.html（" + r.status + "）")
    const s = getStore(), rows = await s.get("rows") || [], edits = await s.get("edits") || []
    const html = assemble(await r.text(), rows, edits)
    root.document.open(); root.document.write(html); root.document.close()
  }
  async function importFiles(files) {   // 讀 dataXXXX.json（可一次選好幾個）；回傳摘要
    const s = getStore(), found = []
    for (const f of files) {
      let list
      try { list = JSON.parse(await f.text()) } catch (e) { throw new Error("「" + f.name + "」不是有效的 JSON") }
      if (!Array.isArray(list)) throw new Error("「" + f.name + "」的格式不對（應該是一列一列的日誌）")
      const ok = list.filter(validRow)
      if (!ok.length) throw new Error("「" + f.name + "」裏找不到日誌")
      found.push(...ok)
    }
    const rows = mergeRows(await s.get("rows") || [], found)
    await s.set("rows", rows)
    const days = rows.filter(r => !r[3]).length, years = [...new Set(rows.map(r => r[0].slice(0, 4)))].sort()
    return { days, years }
  }
  function showImport(el) {
    el.innerHTML = '<h1>生活日誌</h1><p>第一次使用：請選取日誌資料檔（<code>data2025.json</code>、<code>data2026.json</code> …，可以一次選好幾個）。資料只會存在這部裝置的瀏覽器裏，不會上傳到任何地方。</p>' +
      '<label class="btn">選取資料檔<input id="pick" type="file" accept=".json,application/json" multiple hidden></label><p id="msg"></p><button id="go" class="btn pri" hidden>開始使用</button>'
    const msg = el.querySelector("#msg"), go = el.querySelector("#go")
    el.querySelector("#pick").onchange = async e => {
      msg.className = ""; msg.textContent = "匯入中…"
      try {
        const r = await importFiles([...e.target.files])
        msg.textContent = "已匯入 " + r.days + " 天（" + r.years.join("、") + " 年）"; go.hidden = false
      } catch (err) { msg.className = "err"; msg.textContent = String(err.message || err) }
    }
    go.onclick = () => launch().catch(err => { msg.className = "err"; msg.textContent = String(err.message || err) })
  }
  async function boot() {
    try { if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist() } catch (e) {}   // 請瀏覽器別隨便清掉資料
    try { if ("serviceWorker" in root.navigator) root.navigator.serviceWorker.register("sw.js") } catch (e) {}
    const el = root.document.getElementById("boot")
    try {
      const rows = await getStore().get("rows")
      if (rows && rows.length) await launch(); else showImport(el)
    } catch (e) { el.innerHTML = '<h1>生活日誌</h1><p class="err">打不開：' + String(e && e.message || e) + "</p>" }
  }

  const api = { boot, launch, handle, assemble, parse, mergeEdits, mergeRows, sortRows, importFiles, validRow,
    get store() { return getStore() }, useStore(s) { store = s }, memStore }
  root.PwaHost = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof window !== "undefined" ? window : globalThis)

/* 日誌 PWA 宿主（第二個宿主）
   頁面（diary_template.html）只負責介面，所有「要宿主幫忙」的事都用 hostSend 發訊息；這個檔案就是 PWA 這一邊的宿主：
     · 儲存：日誌資料（rows）和修改（edits）存在這部裝置的瀏覽器裏（IndexedDB），不上傳到任何地方
     · 組頁：把模板、日誌資料、修改組成頁面，寫進目前的視窗
     · 訊息：頁面的 hostSend 不再導向網址，改由 window.HOST_DELIVER 直接交給 PwaHost.handle
   目前支援：同步（修改存進宿主）、打開連結、全年備份與還原（備份檔格式和 Scriptable 版相同，兩邊可以互相使用）、卡片照片（加入、顯示、刪除、換日期）。提醒、天氣、整年照片頁還沒開放（會在頁面上提示）。
   注意：照片存在這部裝置的瀏覽器裏，備份檔只含日誌文字和提醒，不含照片（和 Scriptable 版的備份檔相同）。 */
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
    const inject = "<script>window.ICLOUD_EDITS=" + esc(edits) + ";window.UNDATED=0;window.PHOTOS_LOADED=false;window.OFFLINE=0;window.LIVE=true;window.LIVE_PH=true;window.LIVE_BK=true;window.LIVE_RS=true;window.SYNC_NAME='本機';window.HOST_NO_LIMIT=true;window.GOTO=" + esc(opts.go || "") + "</script>" +
      '<script src="host-pwa.js"></script><script>window.HOST_DELIVER=function(u){PwaHost.handle(u)};document.addEventListener("DOMContentLoaded",function(){PwaHost.loadCardPhotos()})</script>'
    return html.replace("</head>", () => head + inject + "</head>")
  }

  // ---------- 備份與還原：備份檔格式和 Scriptable 版完全一樣（{ v:1, kind:"diary-backup", year, created, pre, days:[{date,text}], reminders:[] }）----------
  const p2 = n => String(n).padStart(2, "0")
  const stampOf = t => t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) + "_" + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds())
  const fmtTime = ms => { const t = new Date(ms); return t.getFullYear() + "-" + p2(t.getMonth() + 1) + "-" + p2(t.getDate()) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes()) }
  const preKey = year => year + "-00-00", isPreKey = d => /-00-00$/.test(d)   // 前言（開頭未標日期的文字）的修改，用「年-00-00」當日期鍵
  function effectiveDays(year, rows, edits) {   // 目前這一年實際看到的日誌：原稿加上修改（和頁面的算法一樣）
    rows = rows.filter(r => r[0].startsWith(year + "-"))
    const raw = new Map(rows.filter(r => !r[3]).map(r => [r[0], r[2]]))
    const by = new Map(raw)
    for (const e of edits) if (!e.del && e.date.startsWith(year + "-") && !isPreKey(e.date)) { if (e.deleted) by.delete(e.date); else by.set(e.date, e.text) }
    const rawPre = (rows.find(r => r[3]) || [])[2] || ""
    const pe = edits.find(e => !e.del && e.date === preKey(year))
    return { raw, rawPre, pre: pe ? (pe.text || "") : rawPre, days: new Map([...by].filter(([d, t]) => (t || "").trim() !== "")) }
  }
  function makeBackupBody(year, rows, edits, now, isPre) {
    const { days, pre } = effectiveDays(year, rows, edits)
    const name = "backup_" + year + "_" + stampOf(new Date(now)) + (isPre ? "_pre" : "") + "_" + days.size + "d_0r.json"
    const body = { v: 1, kind: "diary-backup", year, created: now, pre, days: [...days].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, text]) => ({ date, text })), reminders: [] }
    return { name, body, days: days.size }
  }
  function planRestore(year, rows, edits, b, now) {   // 算出還原要做的修改（還沒寫入）；和 Scriptable 版 restoreYear 同一套算法，只是這個版本沒有提醒
    if (!b || b.kind !== "diary-backup" || !Array.isArray(b.days)) return { ok: false, error: "這不是日誌的備份檔" }
    if (b.year !== year) return { ok: false, error: "這份備份是 " + b.year + " 年的，不能還原到 " + year + " 年。請先切換到 " + b.year + " 年再還原。" }
    const inYear = d => DATERE.test(d || "") && d.startsWith(year + "-")
    const target = new Map(b.days.filter(x => x && inYear(x.date) && typeof x.text === "string" && x.text.trim() !== "").map(x => [x.date, x.text]))
    const { raw, rawPre, pre: curPre, days: cur } = effectiveDays(year, rows, edits)
    const preChange = typeof b.pre === "string" && b.pre !== curPre   // 舊備份沒有前言欄位，就不動前言
    let add = 0, chg = 0, del = 0
    for (const [d, t] of target) { if (!cur.has(d)) add++; else if (cur.get(d) !== t) chg++ }
    for (const d of cur.keys()) if (!target.has(d)) del++
    const out = { ok: true, target, cur, add, chg, del, preChange, same: !add && !chg && !del && !preChange, reminders: Array.isArray(b.reminders) ? b.reminders.length : 0 }
    const by = new Map(edits.map(r => [r.date, r]))
    for (const [d, text] of target) {   // 日誌：只改和備份不同的日子
      if (cur.get(d) === text) continue
      if (raw.has(d) && raw.get(d) === text) by.set(d, { date: d, del: true, t: now })   // 回到原稿＝清掉修改
      else by.set(d, { date: d, text, orig: raw.has(d) ? raw.get(d) : null, isNew: !raw.has(d), t: now })
    }
    for (const [d, text] of cur) {
      if (target.has(d)) continue
      if (raw.has(d)) by.set(d, { date: d, deleted: true, text, orig: raw.get(d), isNew: false, t: now })
      else by.set(d, { date: d, del: true, t: now })
    }
    if (preChange) {
      if (b.pre === rawPre) by.set(preKey(year), { date: preKey(year), del: true, t: now })   // 和原稿相同＝清掉修改
      else by.set(preKey(year), { date: preKey(year), text: b.pre, orig: rawPre, pre: true, t: now })
    }
    out.edits = [...by.values()]
    return out
  }

  // ---------- 對話框（備份、還原要用）----------
  const CSS = ".hu-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}" +
    ".hu-box{width:min(26rem,100%);max-height:100%;overflow:auto;box-sizing:border-box;background:#fff;color:#222;border-radius:14px;padding:18px 18px 12px;font:15px/1.6 -apple-system,'PingFang TC','Noto Sans TC',sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.3)}" +
    ".hu-box h3{margin:0 0 .5rem;font-size:1.05rem}.hu-box p{margin:0 0 .9rem;white-space:pre-wrap;color:#555}" +
    ".hu-btn{display:block;width:100%;margin:.4rem 0;padding:.7rem;border:1px solid #2f5d8a;border-radius:10px;background:none;color:#2f5d8a;font:inherit}.hu-btn.pri{background:#2f5d8a;color:#fff}.hu-btn.dng{border-color:#b3261e;color:#b3261e}" +
    "@media (prefers-color-scheme:dark){.hu-box{background:#222;color:#eee}.hu-box p{color:#aaa}.hu-btn{border-color:#7fb0e0;color:#7fb0e0}.hu-btn.pri{background:#7fb0e0;color:#111}.hu-btn.dng{border-color:#ff8a80;color:#ff8a80}}"
  // 按鈕：{ label, kind, value }＝按了就回傳 value；或 { label, kind, onclick(done) }＝按了當場執行（選檔案、分享都要在按下的當下呼叫）
  function modal(title, message, buttons) {
    return new Promise(res => {
      const d = root.document
      if (!d.getElementById("hu-css")) { const st = d.createElement("style"); st.id = "hu-css"; st.textContent = CSS; d.head.appendChild(st) }
      const o = d.createElement("div"), b = d.createElement("div"), h = d.createElement("h3"), m = d.createElement("p")
      o.className = "hu-ov"; b.className = "hu-box"; b.setAttribute("role", "dialog"); h.textContent = title; m.textContent = message; b.append(h, m)
      const done = v => { o.remove(); res(v) }
      for (const bt of buttons) {
        const x = d.createElement("button"); x.type = "button"; x.className = "hu-btn" + (bt.kind ? " " + bt.kind : ""); x.textContent = bt.label
        x.onclick = () => bt.onclick ? bt.onclick(done) : done(bt.value)
        b.appendChild(x)
      }
      o.appendChild(b); d.body.appendChild(o)
    })
  }
  function pickFile(done) {   // 在按鈕被按下的當下呼叫
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = ".json,application/json"; inp.hidden = true
    inp.onchange = () => { const f = inp.files && inp.files[0]; inp.remove(); if (f) done({ file: f }) }
    d.body.appendChild(inp); inp.click()
  }
  function download(name, text) {
    const d = root.document, a = d.createElement("a"), u = root.URL.createObjectURL(new root.Blob([text], { type: "application/json" }))
    a.href = u; a.download = name; d.body.appendChild(a); a.click(); a.remove(); setTimeout(() => root.URL.revokeObjectURL(u), 10000)
  }
  async function deliverFile(name, text) {   // 手機：開分享選單（可「儲存到檔案」）；電腦：直接下載。回傳 "shared" | "downloaded" | "cancelled" | "failed"
    const nav = root.navigator, file = new root.File([text], name, { type: "application/json" })
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title: name }); return "shared" } catch (e) {
        if (e && e.name === "AbortError") return "cancelled"
        // 分享選單要在「剛按下」時才能打開；時間過了就請使用者再按一次
        return await modal("備份已準備好", name, [
          { label: "儲存備份檔", kind: "pri", onclick: done => nav.share({ files: [file], title: name }).then(() => done("shared"), err => done(err && err.name === "AbortError" ? "cancelled" : "failed")) },
          { label: "改用下載", value: "download" }, { label: "取消", value: "cancelled" }]).then(v => { if (v === "download") { download(name, text); return "downloaded" } return v })
      }
    }
    download(name, text); return "downloaded"
  }
  const PRE_KEEP = 5
  async function savePre(year, item) {   // 還原前的自動備份：存在這部裝置，最多留 5 份
    const s = getStore(), list = await s.get("pre:" + year) || []
    await s.set("pre:" + year, [item, ...list].slice(0, PRE_KEEP))
  }
  async function doBackup(yearStr) {
    if (!/^\d{4}$/.test(yearStr || "")) { say("備份失敗：年份不對"); return false }
    const year = +yearStr, s = getStore()
    const r = makeBackupBody(year, await s.get("rows") || [], await s.get("edits") || [], Date.now(), false)
    const how = await deliverFile(r.name, JSON.stringify(r.body))
    say(how === "cancelled" ? "已取消備份" : how === "failed" ? "備份失敗，請再試一次" : "已備份 " + year + " 年：" + r.days + " 天" + (how === "downloaded" ? "（已下載 " + r.name + "）" : ""))
    return how === "shared" || how === "downloaded"
  }
  async function doRestore(yearStr) {   // 回傳 true＝有改動（呼叫端要把最新的修改推回頁面）
    if (!/^\d{4}$/.test(yearStr || "")) { say("還原失敗：年份不對"); return false }
    const year = +yearStr, s = getStore(), pres = await s.get("pre:" + year) || []
    const buttons = [{ label: "從檔案選取…", kind: "pri", onclick: pickFile }]
    pres.forEach((x, i) => buttons.push({ label: fmtTime(x.created) + " · " + x.body.days.length + " 天（還原前自動備份）", value: { pre: i } }))
    buttons.push({ label: "取消", value: null })
    const pick = await modal("還原 " + year + " 年日誌", "選取一份備份檔（.json）。" + (pres.length ? "\n或選一份還原前自動留下的備份：" : ""), buttons)
    if (!pick) return false
    let b
    try { b = pick.file ? JSON.parse(await pick.file.text()) : pres[pick.pre].body } catch (e) { await modal("備份檔讀取失敗", String(e && e.message || e), [{ label: "好", value: 1 }]); return false }
    const rows = await s.get("rows") || [], edits = await s.get("edits") || [], now = Date.now()
    const plan = planRestore(year, rows, edits, b, now)
    if (!plan.ok) { await modal("沒辦法還原", plan.error, [{ label: "好", value: 1 }]); return false }
    if (plan.same) { await modal("不需要還原", "目前的日誌，與這份備份完全相同。", [{ label: "好", value: 1 }]); return false }
    const parts = []
    if (plan.add) parts.push("新增 " + plan.add + " 天")
    if (plan.chg) parts.push("改回備份內容 " + plan.chg + " 天")
    if (plan.del) parts.push("刪除 " + plan.del + " 天")
    if (plan.preChange) parts.push("前言改回備份內容")
    const ok = await modal("確定還原 " + year + " 年？", "備份時間：" + fmtTime(b.created || now) + "\n日誌：目前 " + plan.cur.size + " 天 → " + plan.target.size + " 天（" + parts.join("、") + "）" +
      (plan.reminders ? "\n（備份裏的 " + plan.reminders + " 則提醒：這個版本還不支援提醒，會略過）" : "") + "\n\n還原前會先自動備份目前的內容（存在這部裝置），之後可以再還原回來。",
      [{ label: "還原", kind: "dng", value: true }, { label: "取消", value: false }])
    if (!ok) return false
    await savePre(year, { created: now, body: makeBackupBody(year, rows, edits, now, true).body })   // 還原前先存一份
    await s.set("edits", plan.edits)
    say("已還原 " + year + " 年：日誌 " + plan.target.size + " 天；還原前的內容已自動備份")
    return true
  }

  // ---------- 卡片照片：縮小後存在這部裝置（IndexedDB），檔名規則和 Scriptable 版一樣：「日期_時間_序號.jpg」----------
  const IMG_W = 450, Q_STEPS = [0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1], NOSRC_BPP = 0.25   // 和 Scriptable 版相同：最大寬度、JPEG 品質由高到低、沒有原檔時的容量上限（每像素位元組）
  const okName = n => /^\d{4}(-\d{2}-\d{2})?_[\w.-]+\.jpg$/.test(n || "")
  const dateOf = n => /^\d{4}-\d{2}-\d{2}_/.test(n || "") ? n.slice(0, 10) : ""   // 檔名以日期開頭＝屬於那一天的卡片；以年份開頭＝只屬於那一年
  const photoUrls = new Map()   // 檔名 → blob 網址（顯示用，不佔太多記憶體）
  async function photoIndex() { return await getStore().get("photoIndex") || [] }
  const namesOf = (idx, d) => idx.filter(x => dateOf(x.f) === d).map(x => x.f).sort()
  async function urlFor(f) {
    if (photoUrls.has(f)) return photoUrls.get(f)
    const blob = await getStore().get("photo:" + f)
    if (!blob) return ""
    const u = root.URL.createObjectURL(blob); photoUrls.set(f, u); return u
  }
  async function cardMap(dates) {   // 日期 → [{f, s}]：頁面更新卡片照片用的格式
    const idx = await photoIndex(), map = {}
    for (const d of dates) map[d] = await Promise.all(namesOf(idx, d).map(async f => ({ f, s: await urlFor(f) })))
    return map
  }
  function pushPhotos(map, msg) { if (typeof root.__photosUpdate === "function") root.__photosUpdate(map, msg) }
  async function loadCardPhotos() {   // 頁面載入後，把所有卡片照片補上去
    try {
      const idx = await photoIndex(), dates = [...new Set(idx.map(x => dateOf(x.f)).filter(Boolean))]
      if (dates.length) pushPhotos(await cardMap(dates), "")
    } catch (e) { say("載入照片失敗：" + (e && e.message || e)) }
  }
  async function encodePhoto(file) {   // 縮到最大寬度 IMG_W，JPEG 品質由高往低試，直到不超過原檔大小（和 Scriptable 版同一套規則）
    const url = root.URL.createObjectURL(file)
    try {
      const img = new root.Image(); img.src = url; await img.decode()
      const iw = img.naturalWidth, ih = img.naturalHeight
      if (!iw || !ih) throw new Error("讀不到圖片大小")
      const small = iw <= IMG_W + 8, w = Math.min(IMG_W, iw), h = Math.round(ih * w / iw)
      const isJpeg = /jpe?g$/i.test(file.name) || file.type === "image/jpeg"
      const budget = isJpeg ? file.size : w * h * NOSRC_BPP
      const c = root.document.createElement("canvas"); c.width = w; c.height = h
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h)
      let blob = null
      for (const q of Q_STEPS) { blob = await new Promise(r => c.toBlob(r, "image/jpeg", q)); if (blob && blob.size <= budget) break }
      if (!blob) throw new Error("壓縮失敗")
      if (isJpeg && blob.size > file.size && small) blob = file.slice(0, file.size, "image/jpeg")   // 壓縮後仍比原檔大，而且原圖本來就夠小 → 直接用原檔
      return blob
    } finally { root.URL.revokeObjectURL(url) }
  }
  function pickImages(done) {   // 在按鈕被按下的當下呼叫（手機：相片圖庫／拍照／檔案）
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  async function doAddPhotos(date) {
    if (!DATERE.test(date || "")) { say("加入照片失敗：日期不對"); return }
    const pick = await modal("加入照片到 " + date, "選取一張或好幾張相片，會縮小後存在這部裝置。", [{ label: "選取相片…", kind: "pri", onclick: pickImages }, { label: "取消", value: null }])
    if (!pick) return
    const s = getStore(); let idx = await photoIndex(), ok = 0, bad = 0, i = 0
    say("處理 " + pick.files.length + " 張照片…")
    for (const f of pick.files) {
      try {
        const blob = await encodePhoto(f)
        let name = date + "_" + Date.now() + "_" + (i++) + ".jpg"
        while (idx.some(x => x.f === name)) name = date + "_" + Date.now() + "_" + (i++) + ".jpg"
        await s.set("photo:" + name, blob)
        idx = [...idx, { f: name, size: blob.size, created: Date.now() }]
        await s.set("photoIndex", idx); ok++
      } catch (e) { bad++ }
    }
    pushPhotos(await cardMap([date]), ok ? "已加入 " + ok + " 張照片" + (bad ? "，有 " + bad + " 張讀不了" : "") : "")
    if (!ok) say(bad ? "這 " + bad + " 張照片讀不了（可能不是常見的圖片格式）" : "沒有加入任何照片")
  }
  async function doDelPhoto(name) {
    if (!okName(name)) { say("刪除失敗：檔名不對"); return }
    const s = getStore(), idx = await photoIndex()
    await s.set("photoIndex", idx.filter(x => x.f !== name)); await s.del("photo:" + name)
    if (photoUrls.has(name)) { root.URL.revokeObjectURL(photoUrls.get(name)); photoUrls.delete(name) }
    const d = dateOf(name)
    pushPhotos(d ? await cardMap([d]) : {}, "已刪除")
  }
  async function doMovePhoto(name, to) {   // to＝年份（變成只屬於那一年）或日期（綁到那一天）
    if (!okName(name) || !/^(\d{4}|\d{4}-\d{2}-\d{2})$/.test(to || "")) { say("移動失敗：參數不對"); return }
    const s = getStore(), idx = await photoIndex(), nn = to + name.replace(/^\d{4}(-\d{2}-\d{2})?/, "")
    if (nn !== name) {
      if (idx.some(x => x.f === nn)) { say("移動失敗：那裏已經有同名的照片"); return }
      const blob = await s.get("photo:" + name)
      if (!blob) { say("移動失敗：找不到這張照片"); return }
      await s.set("photo:" + nn, blob)
      await s.set("photoIndex", idx.map(x => x.f === name ? { ...x, f: nn } : x)); await s.del("photo:" + name)
      if (photoUrls.has(name)) { photoUrls.set(nn, photoUrls.get(name)); photoUrls.delete(name) }
    }
    const dates = [...new Set([dateOf(name), dateOf(nn)].filter(Boolean))]
    pushPhotos(await cardMap(dates), "已更新")
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
  const UNSUPPORTED = { loadphotos: "整年照片頁", remsave: "提醒", wxcfg: "天氣設定" }
  function actionOf(p) {   // 這個訊息要做什麼：同步（沒有任何動作參數）、打開連結、備份、還原，或還沒開放的動作名
    if (p.openurl) return "open"
    if (p.backup !== undefined) return "backup"
    if (p.restore !== undefined) return "restore"
    if (p.addphoto) return "addphoto"
    if (p.delphoto) return "delphoto"
    if (p.movephoto) return "movephoto"
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
    if (merged) await pushCloud()   // 頁面附上的待同步修改先存好、先推回頁面（後面的動作可能要等使用者操作很久）
    const act = actionOf(p)
    let restored = false
    if (act === "open") openUrl(p.openurl)
    else if (act === "backup") await doBackup(p.backup)
    else if (act === "restore") restored = await doRestore(p.restore)
    else if (act === "addphoto") await doAddPhotos(p.addphoto)
    else if (act === "delphoto") await doDelPhoto(p.delphoto)
    else if (act === "movephoto") await doMovePhoto(p.movephoto, p.to)
    else if (act !== "sync") say("「" + UNSUPPORTED[act] + "」在 PWA 版還沒開放")
    if (restored) await pushCloud()
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
      if (list && list.kind === "diary-backup" && Array.isArray(list.days)) {   // 備份檔也可以直接當資料來源（例如搬到新手機）
        list = list.days.filter(x => x && typeof x.text === "string").map(x => [x.date, "", x.text]).concat(list.pre ? [[list.year + "-00-00", "", list.pre, true]] : [])
      }
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
    el.innerHTML = '<h1>生活日誌</h1><p>第一次使用：請選取日誌資料檔（<code>data2025.json</code>、<code>data2026.json</code> …，或之前備份的 <code>backup_…json</code>，可以一次選好幾個）。資料只會存在這部裝置的瀏覽器裏，不會上傳到任何地方。</p>' +
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

  const api = { boot, launch, handle, loadCardPhotos, okName, dateOf, assemble, parse, mergeEdits, mergeRows, sortRows, importFiles, validRow, effectiveDays, makeBackupBody, planRestore,
    get store() { return getStore() }, useStore(s) { store = s }, memStore }
  root.PwaHost = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof window !== "undefined" ? window : globalThis)

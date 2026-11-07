/* 日誌 PWA 宿主（第二個宿主）
   頁面（diary_template.html）只負責介面，所有「要宿主幫忙」的事都用 hostSend 發訊息；這個檔案就是 PWA 這一邊的宿主：
     · 儲存：日誌資料（rows）和修改（edits）存在這部裝置的瀏覽器裏（IndexedDB），不上傳到任何地方
     · 組頁：把模板、日誌資料、修改組成頁面，寫進目前的視窗
     · 訊息：頁面的 hostSend 不再導向網址，改由 window.HOST_DELIVER 直接交給 PwaHost.handle
   目前支援：同步（修改存進宿主）、打開連結、全年備份與還原（內容格式和 Scriptable 版相同，網頁版可以讀 Scriptable 的備份；但網頁版的備份檔，Scriptable 不認得）、卡片照片（加入、顯示、刪除、換日期）。天氣（每張卡片標題欄的「地名 溫度 有雨／下雪 大風 酷熱」、未來預報、日誌頁選單裏的「天氣」設定，規則和 Scriptable 版相同；見下面「天氣」一節）。提醒、整年照片頁還沒開放（會在頁面上提示）。
   注意：照片存在這部裝置的瀏覽器裏；備份檔（.json）只含日誌文字和提醒，不含照片（和 Scriptable 版的備份檔相同）。照片另外備份：備份完文字後會問要不要把照片存成一張張 .jpg（經分享選單存到「檔案」），還原時在還原視窗按「還原照片」，依檔名放回原來的卡片。按卡片上的「加入照片」會直接打開相簿選單（宿主組頁時在按鈕處理函式裏插一行；模板改過、找不到那一行時，會退回先顯示對話框）。 */
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

  // ---------- 預先打開相簿（省掉「加入照片」中間那個對話框）----------
  // 瀏覽器只准許在「剛按下按鈕」的當下打開選照片的選單；但頁面按下「加入照片」後要先存檔，才把訊息交給宿主，到那時已經過了「剛按下」，所以以前宿主得先顯示一個對話框，請使用者再按一次。
  // 現在的做法：組頁時，在頁面「加入照片」按鈕的處理函式裏，於存檔之前插入一行，按下的當下就呼叫 HOST_PICK_PHOTOS 打開選單；之後宿主收到訊息，只要等使用者選完。
  // 如果模板裏找不到這一行（模板改過），就不插，宿主照舊顯示對話框，功能不受影響。
  const PICK_ANCHOR = "再加入照片');return}await saveEdit(d,ta.value,null,true);"
  const PICK_PATCH = "再加入照片');return}window.HOST_PICK_PHOTOS&&window.HOST_PICK_PHOTOS();await saveEdit(d,ta.value,null,true);"

  // ---------- 組頁：模板 + 日誌資料 + 修改 ----------
  function assemble(tpl, rows, edits, opts) {
    opts = opts || {}
    if (!tpl.includes("__DATA__")) throw new Error("模板裏找不到 __DATA__")
    const esc = o => JSON.stringify(o).replace(/</g, "\\u003c")
    if (tpl.includes(PICK_ANCHOR)) tpl = tpl.replace(PICK_ANCHOR, () => PICK_PATCH)   // 找不到那一行（模板改過）就不插，照舊顯示對話框
    const html = tpl.replace("__DATA__", () => JSON.stringify(sortRows(rows)).replace(/<\//g, "<\\/"))
    const head = '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png">' +
      '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="日誌">'
    const inject = "<script>window.ICLOUD_EDITS=" + esc(edits) + ";window.UNDATED=0;window.PHOTOS_LOADED=false;window.OFFLINE=0;window.LIVE=true;window.LIVE_PH=true;window.LIVE_BK=true;window.LIVE_RS=true;window.LIVE_ACT=true;window.WEATHER=" + esc(opts.weather || {}) + ";window.WXCFG=" + esc(opts.wxcfg || { fcDays: W.fcDays, hotC: W.hotC }) + ";window.SYNC_NAME='本機';window.HOST_NO_LIMIT=true;window.GOTO=" + esc(opts.go || "") + "</script>" +
      '<script src="host-pwa.js"></script><script>window.HOST_DELIVER=function(u){PwaHost.handle(u)};window.HOST_PICK_PHOTOS=function(){PwaHost.prePickPhotos()};document.addEventListener("DOMContentLoaded",function(){PwaHost.loadCardPhotos();PwaHost.startWeather()})</script>'
    return html.replace("</head>", () => head + inject + "</head>")
  }

  // ---------- 備份與還原 ----------
  // 內容的格式和 Scriptable 版一樣（v、year、created、pre、days:[{date,text}]、reminders），但「檔名」和「類型（kind）」刻意不同，免得兩邊的檔案混在一起：
  //   網頁版的備份：diary-pwa_backup_年_日期_時間_N d.json，kind＝"diary-pwa-backup"
  //   Scriptable 的備份：backup_年_日期_時間_N d_N r.json，kind＝"diary-backup"
  //   網頁版備份出來的照片：diary-pwa_＋原檔名.jpg（Scriptable 的照片資料夾只認「日期_…jpg」開頭的檔名，所以不會把它當成自己的照片）
  // 這樣就算網頁版的備份檔或照片不小心存進 Scriptable 的資料夾（diary_backups、diary_photos），Scriptable 也不會列出、不會認得它們。
  // 網頁版這邊兩種備份都認得（可以還原、匯入 Scriptable 的備份），照片則有沒有 diary-pwa_ 前綴都認。
  const BK_KIND = "diary-pwa-backup", SCRIPTABLE_KIND = "diary-backup", PWA_PHOTO_PREFIX = "diary-pwa_"
  const okKind = k => k === BK_KIND || k === SCRIPTABLE_KIND
  const p2 = n => String(n).padStart(2, "0")
  const stampOf = t => t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) + "_" + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds())
  const fmtShort = ms => { const t = new Date(ms); return p2(t.getMonth() + 1) + "-" + p2(t.getDate()) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes()) }   // 按鈕上用的短格式（月-日 時:分）
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
    const name = "diary-pwa_backup_" + year + "_" + stampOf(new Date(now)) + (isPre ? "_pre" : "") + "_" + days.size + "d.json"
    const body = { v: 1, kind: BK_KIND, app: "pwa", year, created: now, pre, days: [...days].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, text]) => ({ date, text })), reminders: [] }
    return { name, body, days: days.size }
  }
  function planRestore(year, rows, edits, b, now) {   // 算出還原要做的修改（還沒寫入）；和 Scriptable 版 restoreYear 同一套算法，只是這個版本沒有提醒
    if (!b || !okKind(b.kind) || !Array.isArray(b.days)) return { ok: false, error: "這不是日誌的備份檔" }
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
    ".hu-btn{display:block;width:100%;margin:.4rem 0;padding:.7rem;border:1px solid #2f5d8a;border-radius:10px;background:none;color:#2f5d8a;font:inherit;line-height:1.4;white-space:normal;overflow-wrap:anywhere}.hu-btn.pri{background:#2f5d8a;color:#fff}.hu-btn.dng{border-color:#b3261e;color:#b3261e}" +
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
    if (!await s.get("hint:backup")) {   // 第一次備份：先提醒存到哪裏（網頁版沒辦法自己指定資料夾，iOS 會預設停在你上次用的位置）
      const go = await modal("備份前先看一下", "備份檔和備份的照片，會存到你接著選的位置。\n\n建議另外建一個專用資料夾（例如「日誌網頁版備份」），不要存進 Scriptable 的資料夾（diary_backups、diary_photos），免得兩邊的檔案混在一起。\n\n就算不小心存進去，Scriptable 也不會認得網頁版的備份檔和照片。",
        [{ label: "繼續備份", kind: "pri", value: true }, { label: "取消", value: false }])
      if (!go) { say("已取消備份"); return false }
      await s.set("hint:backup", 1)
    }
    const how = await deliverFile(r.name, JSON.stringify(r.body))
    say(how === "cancelled" ? "已取消備份" : how === "failed" ? "備份失敗，請再試一次" : "已備份 " + year + " 年：" + r.days + " 天" + (how === "downloaded" ? "（已下載 " + r.name + "）" : ""))
    const saved = how === "shared" || how === "downloaded"
    if (saved) await offerPhotoBackup(year)
    return saved
  }
  async function doRestore(yearStr) {   // 回傳 true＝有改動（呼叫端要把最新的修改推回頁面）
    if (!/^\d{4}$/.test(yearStr || "")) { say("還原失敗：年份不對"); return false }
    const year = +yearStr, s = getStore(), pres = await s.get("pre:" + year) || []
    const buttons = [{ label: "從檔案選取…", kind: "pri", onclick: pickFile }, { label: "還原照片（.jpg）…", value: "photos" }]
    pres.forEach((x, i) => buttons.push({ label: "還原前 " + fmtShort(x.created) + " · " + x.body.days.length + " 天", value: { pre: i } }))
    buttons.push({ label: "取消", value: null })
    const pick = await modal("還原 " + year + " 年日誌", "選取一份備份檔（.json）；或按「還原照片」把備份的照片放回卡片。" + (pres.length ? "\n也可以選一份還原前自動留下的備份：" : ""), buttons)
    if (!pick) return false
    if (pick === "photos") { await doRestorePhotos(); return false }
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
  let prePick = null   // 按下「加入照片」當下已經打開的相簿選單：{ promise（選完得到檔案；取消得到 null）, at, cancel }
  function prePickPhotos() {   // 由頁面按鈕的處理函式在按下的當下呼叫（HOST_PICK_PHOTOS）
    if (prePick) prePick.cancel()
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.hidden = true
    let finish
    const promise = new Promise(res => { finish = res })
    prePick = { promise, at: Date.now(), cancel: () => { inp.remove(); finish(null) } }
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); finish(fs) }
    inp.addEventListener("cancel", () => { inp.remove(); finish(null) })
    d.body.appendChild(inp); inp.click()
  }
  async function doAddPhotos(date) {
    if (!DATERE.test(date || "")) { say("加入照片失敗：日期不對"); return }
    const pre = prePick; prePick = null
    if (pre && Date.now() - pre.at < 10000) {   // 按下按鈕時相簿已經打開了：選完再處理；這裏不等，沒選照片也不會卡住後面的動作
      pre.promise.then(fs => { if (fs && fs.length) queue = queue.then(() => addPhotoFiles(date, fs)).catch(e => say("出錯了：" + (e && e.message || e))) })
      return
    }
    if (pre) pre.cancel()
    const pick = await modal("加入照片到 " + date, "選取一張或好幾張相片，會縮小後存在這部裝置。", [{ label: "選取相片…", kind: "pri", onclick: pickImages }, { label: "取消", value: null }])
    if (!pick) return
    await addPhotoFiles(date, pick.files)
  }
  async function addPhotoFiles(date, files) {
    const s = getStore(); let idx = await photoIndex(), ok = 0, bad = 0, i = 0
    say("處理 " + files.length + " 張照片…")
    for (const f of files) {
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

  // ---------- 照片備份與還原：備份檔（.json）不含照片，所以照片另外存成一張張 .jpg（檔名不變），還原時依檔名放回原來的卡片 ----------
  const PHOTO_BATCH = 40   // 一次分享的張數上限（太多張時分享選單可能開不起來，所以分批）
  const yearPhotoNames = (idx, year) => idx.filter(x => okName(x.f) && x.f.slice(0, 4) === String(year)).map(x => x.f).sort()
  async function photoFilesOf(year) {
    const s = getStore(), out = []
    for (const f of yearPhotoNames(await photoIndex(), year)) {
      const blob = await s.get("photo:" + f)
      if (blob) out.push(new root.File([blob], PWA_PHOTO_PREFIX + f, { type: "image/jpeg" }))
    }
    return out
  }
  function downloadBlob(name, blob) {
    const d = root.document, a = d.createElement("a"), u = root.URL.createObjectURL(blob)
    a.href = u; a.download = name; d.body.appendChild(a); a.click(); a.remove(); setTimeout(() => root.URL.revokeObjectURL(u), 10000)
  }
  async function backupPhotos(year, files) {   // 一批一批存；每一批都要使用者按一下（分享選單只能在按下的當下打開）。回傳實際存出幾張
    const nav = root.navigator, batches = []
    for (let i = 0; i < files.length; i += PHOTO_BATCH) batches.push(files.slice(i, i + PHOTO_BATCH))
    let saved = 0
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i], title = "備份 " + year + " 年照片" + (batches.length > 1 ? "（第 " + (i + 1) + "／" + batches.length + " 批）" : "")
      let note = ""
      for (;;) {
        const buttons = []
        if (nav && nav.share) buttons.push({ label: "儲存照片", kind: "pri", onclick: done => nav.share({ files: batch, title: year + " 年照片" }).then(() => done("shared"), err => done(err && err.name === "AbortError" ? "again" : "failed")) })
        buttons.push({ label: "改用下載", value: "download" }, { label: "停止", value: "stop" })
        const r = await modal(title, "這一批 " + batch.length + " 張。按「儲存照片」後，選「儲存到檔案」，並選一個資料夾" + (batches.length > 1 ? "（每一批都選同一個）" : "") + "。" + note, buttons)
        if (r === "shared") { saved += batch.length; break }
        if (r === "download") { for (const f of batch) { downloadBlob(f.name, f); await new Promise(res => setTimeout(res, 300)) } saved += batch.length; break }
        if (r === "stop") return saved
        note = r === "failed" ? "\n\n剛才分享失敗了，請再按一次，或改用下載。" : ""
      }
    }
    return saved
  }
  async function offerPhotoBackup(year) {   // 文字備份完成後呼叫：這一年有照片，就問要不要另外備份
    const n = yearPhotoNames(await photoIndex(), year).length
    if (!n) return
    const go = await modal("要連照片一起備份嗎？", year + " 年有 " + n + " 張照片。日誌文字的備份檔不含照片，要另外把照片存到「檔案」App 嗎？", [{ label: "備份照片", kind: "pri", value: true }, { label: "不用了", value: false }])
    if (!go) return
    const files = await photoFilesOf(year), saved = files.length ? await backupPhotos(year, files) : 0
    say(saved ? "已備份 " + saved + " 張照片" : "沒有備份照片")
  }
  function pickPhotoFiles(done) {   // 在按鈕被按下的當下呼叫
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "image/jpeg,.jpg,.jpeg"; inp.multiple = true; inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  async function doRestorePhotos() {   // 把備份的 .jpg 放回來（各年份可以一次選）：檔名要是「日期_….jpg」，依日期放回對應的卡片；已經有的略過；原檔直接存，不再壓縮
    const pick = await modal("還原照片", "選取備份的照片（檔名像 diary-pwa_2026-03-05_….jpg），會依檔名上的日期放回對應的日誌卡片，不同年份可以一次選。已經有的會略過。\n在選單裏請選「選擇檔案」，從「檔案」App 選取；從「照片」圖庫選的話，檔名會被改掉，就放不回原來的日子。", [{ label: "選取照片…", kind: "pri", onclick: pickPhotoFiles }, { label: "取消", value: null }])
    if (!pick) return
    const s = getStore(), dates = new Set()
    let idx = await photoIndex(), ok = 0, dup = 0, skip = 0
    say("處理 " + pick.files.length + " 張照片…")
    for (const f of pick.files) {
      try {
        const nm = f.name.startsWith(PWA_PHOTO_PREFIX) ? f.name.slice(PWA_PHOTO_PREFIX.length) : f.name   // 備份時加的前綴，還原時拿掉
        if (!okName(nm)) { skip++; continue }
        if (idx.some(x => x.f === nm)) { dup++; continue }
        const buf = await f.arrayBuffer(), head = new Uint8Array(buf.slice(0, 2))
        if (head[0] !== 0xFF || head[1] !== 0xD8) { skip++; continue }   // 不是 JPEG
        const blob = new root.Blob([buf], { type: "image/jpeg" })
        await s.set("photo:" + nm, blob)
        idx = [...idx, { f: nm, size: blob.size, created: Date.now() }]
        await s.set("photoIndex", idx); ok++
        if (dateOf(nm)) dates.add(dateOf(nm))
      } catch (e) { skip++ }
    }
    const msg = "已還原 " + ok + " 張照片" + (dup ? "，略過 " + dup + " 張已有的" : "") + (skip ? "，" + skip + " 張不能用（檔名不對或不是 JPEG）" : "")
    pushPhotos(await cardMap([...dates]), ok ? msg : "")
    if (!ok) say(msg)
  }

  // ---------- 天氣：每張日誌卡片的標題欄顯示「地名 溫度範圍 有雨／下雪 大風 酷熱」（判斷規則和 Scriptable 版相同）----------
  // 聯網：預報用 Open-Meteo（免費、不用金鑰）；位置用瀏覽器的定位（第一次要在瀏覽器裏允許「位置」）；地名用 OpenStreetMap 的 Nominatim 反查（Scriptable 版用的是 iOS 的反查，同一個地點的地名寫法可能略有不同，不喜歡的可以用 alias 改寫）。
  // 日誌只存地名；唯一存的位置是「最後一次所在地」（收窄到約 1 公里，用來判斷有沒有換地方）。全部只存在這部裝置的瀏覽器裏（IndexedDB 的 weather），不上傳到別處。
  // 沒網路、不給定位、查不到：什麼都不顯示，不影響日誌；之後離線也看得到上次存的天氣。
  // 和 Scriptable 版的差別：Scriptable 打開時最多等 waitMs 毫秒才組頁；網頁版先用上次存的天氣組頁，查到新的再用頁面的 __wxUpdate 換上去，頁面不用等。
  const W = {
    rainHours: 12,      // 一天裏降水的小時數「超過」這個數，才算有雨（12 ＝ 超過一半時間在下雨）
    rainMinMm: 0,       // 全日降水量至少多少 mm 才算有雨；倫敦常有毛毛雨，覺得太常顯示「有雨」可改成 1
    rainHeavyMm: 10,    // 全日降水量達這個數（mm）就算有雨，即使下雨的時數不到一半
    fcDays: 7,          // 預設值：預報往後看幾天（從明天起算，0＝不顯示，最多 16）。日誌頁選單的「天氣」可以直接改，存起來後優先於這裏
    hotC: 38,           // 預設值：最高氣溫達這個數（°C）就顯示「酷熱」。日誌頁選單的「天氣」可以直接改，優先於這裏
    snowMinCm: 0.5,     // 全日降雪量達這個數（cm）就顯示「下雪」（有下雪就顯示「下雪」，不顯示「有雨」）
    stormKmh: 62,       // 一天裏最大風速達這個數（km/h）就顯示「大風」；62 約是蒲福風級 8 級，想更嚴格可改 89（10 級）
    sameKm: 30,         // 和上次的位置相距不超過這個距離（公里），視為同一個地方：漏掉的日子用上次的地名和這裏的天氣補上；超過就留空白，不猜
    stickyKm: 1.5,      // 離上次記錄的位置不到這個距離，沿用上次的地名，不重新判斷（避免在區界附近今天 A 區、明天 B 區）
    fillDays: 14,       // 漏掉的日子最多往回補幾天
    minGapMin: 20,      // 同一天內，離上次更新不到這麼多分鐘就不再聯網
    netMs: 8000,        // 定位、查天氣、查地名，每一步最多等多久（毫秒）
    alias: {},          // 地名改寫，例如 { "New Malden": "新莫爾登" }
    debugPlace: false,  // 改成 true：每次查地名時，在畫面上顯示反查回來的原始地址（欄位）和選出的地名，方便檢查為什麼選了這個名字
    bigCities: ["greater london", "london", "倫敦", "伦敦", "hong kong", "香港", "guangzhou", "廣州", "广州", "shenzhen", "深圳", "macau", "澳門", "澳门"]   // 這些城市（以及所有以「市」結尾的中文城市）改用更細的「區」；其他地方用「城鎮」
  }
  const w2 = n => Math.round(n * 100) / 100
  const NAME_V = 2   // 地名挑選規則的版本；改了規則就把這個數字加一，舊規則存下的地名會重新查一次
  const ymd = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate())
  const noon = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8), 12)
  const shiftDay = (s, n) => { const d = noon(s); d.setDate(d.getDate() + n); return ymd(d) }
  const dayGap = (a, b) => Math.round((noon(b) - noon(a)) / 864e5)
  function distKm(a, b) {
    const r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon)
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2
    return 2 * 6371 * Math.asin(Math.sqrt(h))
  }
  const inZh = (lat, lon) => lat >= 18 && lat <= 54 && lon >= 73 && lon <= 123.5   // 大約是中國、香港、澳門、台灣一帶：這裏用中文地名，其他地方用英文地名
  async function fetchJson(url) {
    const ctl = typeof root.AbortController === "function" ? new root.AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), W.netMs) : 0
    try {
      const r = await root.fetch(url, ctl ? { signal: ctl.signal } : {})
      if (!r.ok) throw new Error("HTTP " + r.status)
      return await r.json()
    } finally { if (timer) clearTimeout(timer) }
  }
  function getPosition() {   // 回傳 { latitude, longitude }；使用者不給定位回傳 "denied"；其他失敗（逾時、瀏覽器沒有定位）回傳 null
    return new Promise(res => {
      let done = false
      function fin(v) { if (!done) { done = true; clearTimeout(guard); res(v) } }
      const guard = setTimeout(() => fin(null), W.netMs + 7000)   // 「允許位置」的詢問框還沒按時，瀏覽器的 timeout 不計時；這裏另設一個上限，免得後面的天氣工作一直卡住
      const g = root.navigator && root.navigator.geolocation
      if (!g) return fin(null)
      try {
        g.getCurrentPosition(p => fin(p && p.coords ? { latitude: p.coords.latitude, longitude: p.coords.longitude } : null),
          e => fin(e && e.code === 1 ? "denied" : null), { enableHighAccuracy: false, timeout: W.netMs, maximumAge: 600000 })
      } catch (e) { fin(null) }
    })
  }
  // 地名：反查地址，取「最細」的一層——大城市（倫敦、香港、廣州…）用「區」（尖沙咀、荔灣區），其他用「城鎮」（New Malden）
  // 不指定 zoom（用預設的最細一級）才會拿到完整的一串（suburb、town、borough、city…）；指定太粗，只會回傳到「郡／大倫敦」一級。
  // 只送出約 100 米精度的位置（小數 3 位）；地名只要到區、城鎮，不需要更準。
  async function placeName(lat, lon) {
    const zh = inZh(lat, lon), w3 = n => Math.round(n * 1000) / 1000
    let a = null
    try {
      const j = await fetchJson("https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=" + w3(lat) + "&lon=" + w3(lon) + "&accept-language=" + (zh ? "zh-HK,zh" : "en-GB,en"))
      a = j && j.address
    } catch (e) {}
    if (!a) return ""
    const t = x => String(x || "").trim()
    const city = t(a.city), town = t(a.town || a.village || a.municipality)
    const loc = city || town                                                                              // 城市／城鎮
    const s1 = t(a.suburb || a.hamlet)                                                                     // 最細的一層（尖沙咀、New Malden）
    const s2 = t(a.city_district || a.borough || a.district || a.quarter || a.neighbourhood)               // 行政區之類，比較粗
    const sub = s1 || s2
    const wide = t(a.county || a.state_district || a.state || a.region)                                    // 郡、州：只有其他都沒有時才用
    const big = !!loc && (/市$/.test(loc) || W.bigCities.includes(loc.replace(/市$/, "").toLowerCase()))
    const fine = s1 || (city && town && town !== city ? town : "") || s2   // 大城市裏的順序：最細一層 → 城鎮名（例如倫敦的 New Malden）→ 行政區；城鎮名比「Royal Borough of …」更貼近 iOS 的結果
    const n = (big && fine) ? fine : (loc || sub || wide)
    if (W.debugPlace) say("地名查詢：" + JSON.stringify(a) + " → " + n, 15000)
    return W.alias[n] || n
  }
  async function fetchDaily(lat, lon, past) {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + w2(lat) + "&longitude=" + w2(lon) +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_hours,snowfall_sum,wind_speed_10m_max" +
      "&past_days=" + past + "&forecast_days=" + (W.fcDays + 1) + "&timezone=auto"
    const j = await fetchJson(url)
    return j && j.daily && Array.isArray(j.daily.time) ? j.daily : null
  }
  function applyWxCfg(c) {   // 套用在日誌頁設定的預報天數和酷熱溫度（不合理的數字不理）
    if (!c || typeof c !== "object") return false
    let ok = false
    const d = Number(c.fcDays), h = Number(c.hotC)
    if (c.fcDays != null && Number.isInteger(d) && d >= 0 && d <= 16) { W.fcDays = d; ok = true }
    if (c.hotC != null && isFinite(h) && h >= 25 && h <= 50) { W.hotC = h; ok = true }
    return ok
  }
  function wxRecord(dly, i) {
    const n = k => (dly[k] && dly[k][i] != null && isFinite(dly[k][i])) ? +dly[k][i] : null
    const hi = n("temperature_2m_max"), lo = n("temperature_2m_min")
    if (hi == null || lo == null) return null
    const hrs = n("precipitation_hours"), mm = n("precipitation_sum"), sn = n("snowfall_sum"), wd = n("wind_speed_10m_max")
    return {
      lo: Math.round(lo) + 0, hi: Math.round(hi) + 0,
      r: ((hrs != null && hrs > W.rainHours && (mm == null || mm >= W.rainMinMm)) || (mm != null && mm >= W.rainHeavyMm)) ? 1 : 0,
      s: (sn != null && sn >= W.snowMinCm) ? 1 : 0,
      w: (wd != null && wd >= W.stormKmh) ? 1 : 0,
      rv: 2
    }
  }
  async function readWeather() {   // 天氣資料：{ v, days（已發生的日子）, fc（未來預報）, last（最後一次所在地）, u（上次更新時間）, cfg（日誌頁設定的預報天數、酷熱溫度） }
    let st = { v: 1, days: {} }
    try { const t = await getStore().get("weather"); if (t && typeof t === "object") st = Object.assign(st, t) } catch (e) {}
    if (!st.days || typeof st.days !== "object") st.days = {}
    applyWxCfg(st.cfg)   // 日誌頁設定過的數字，優先於上面的預設值
    return st
  }
  const saveWeather = st => getStore().set("weather", st)
  async function wxDeniedHint() {   // 使用者不給定位：只提示一次，之後安靜
    const s = getStore()
    if (await s.get("hint:wxdenied")) return
    await s.set("hint:wxdenied", 1)
    say("天氣需要「位置」權限：請在瀏覽器的網站設定裏允許位置，之後打開就會顯示天氣", 7000)
  }
  async function weatherUpdate(st) {   // 回傳 true＝有查到新資料並已存好；false＝什麼都沒改（太近才更新過、沒定位、沒網路…）
    const today = ymd(new Date()), migrate = st.nv !== NAME_V   // migrate＝存下來的地名是舊規則查的：這一次一定重新查，不沿用
    if (!migrate && st.u && Date.now() - st.u < W.minGapMin * 60000 && st.last && st.last.d === today && st.days[today] && st.fc) return false
    const pos = await getPosition()
    if (pos === "denied") { await wxDeniedHint(); return false }
    if (!pos) return false
    const cur = { lat: w2(pos.latitude), lon: w2(pos.longitude) }
    const last = st.last, same = !!last && distKm(last, cur) <= W.sameKm
    let name, got = false
    if (!migrate && last && last.name && distKm(last, cur) < W.stickyKm) name = last.name
    else { name = await placeName(pos.latitude, pos.longitude); got = !!name; if (!name && same) name = last.name || "" }
    if (migrate && got) {   // 新查到地名了：把舊規則存下的地名（只限「還在同一個地方」的日子）換成新的，並記下已經換過
      const old = same ? (last.name || "") : ""
      if (old && old !== name) for (const r of Object.values(st.days).concat(Object.values(st.fc || {}))) if (r.p === old) r.p = name
      st.nv = NAME_V
    }
    // 要一起查的過去日子：還沒定案的、以及中間漏掉沒打開日誌的日子（只在「還在同一個地方」時才補）
    const need = new Set()
    if (same) {
      for (const d of Object.keys(st.days)) if (d < today && !st.days[d].f && dayGap(d, today) <= W.fillDays + 3) need.add(d)
      for (let d = shiftDay(last.d, 1); d < today; d = shiftDay(d, 1)) if (dayGap(d, today) <= W.fillDays && !st.days[d]) need.add(d)
    }
    const past = need.size ? Math.min(92, dayGap([...need].sort()[0], today)) : 0
    let dly
    try { dly = await fetchDaily(cur.lat, cur.lon, past) } catch (e) { return false }   // 沒網路：什麼都不改，下次再試
    if (!dly) return false
    const now = Date.now(), fc = {}
    for (let i = 0; i < dly.time.length; i++) {
      const d = dly.time[i], rec = wxRecord(dly, i)
      if (!rec) continue
      if (d === today) st.days[today] = Object.assign({ p: name }, rec, { f: 0, t: now })
      else if (need.has(d)) { const ex = st.days[d]; st.days[d] = Object.assign({ p: ex ? ex.p : (last.name || "") }, rec, { f: 1, t: now }) }
      else if (d > today) fc[d] = Object.assign({ p: name }, rec, { t: now })   // 未來的日子：預報另外存，不算「定案」
    }
    st.fc = fc
    for (const d of Object.keys(st.days)) if (d < today && !st.days[d].f && !need.has(d)) st.days[d].f = 1   // 換了地方、或太久以前：不再重查，維持原本的數字
    st.last = { lat: cur.lat, lon: cur.lon, name, d: today, t: now }
    st.u = now
    await saveWeather(st)
    return true
  }
  function weatherForPage(st) {   // 日期 → [地名, 最低, 最高, 雨, 雪, 風, 酷熱, (預報才有) 1]：頁面 window.WEATHER 的格式
    const o = {}, today = ymd(new Date())
    const row = (r, fc) => { const a = [r.p || "", r.lo, r.hi, r.r ? 1 : 0, r.s ? 1 : 0, r.w ? 1 : 0, (typeof r.hi === "number" && r.hi >= W.hotC) ? 1 : 0]; if (fc) a.push(1); return a }
    for (const [d, r] of Object.entries(st.days || {})) o[d] = row(r, false)
    for (const [d, r] of Object.entries(st.fc || {})) if (d > today && dayGap(today, d) <= W.fcDays && !o[d]) o[d] = row(r, true)   // 預報：第 8 欄＝1，日誌用斜體顯示
    return o
  }
  function pushWeather(st, msg) {   // 把天氣和設定交給頁面（頁面的 __wxUpdate 會重畫；正在編輯卡片時只更新資料，不打斷打字）
    if (typeof root.__wxUpdate === "function") root.__wxUpdate(weatherForPage(st), { fcDays: W.fcDays, hotC: W.hotC }, msg || "")
  }
  // 天氣的工作一個接一個做（背景更新和「天氣設定」不會互相蓋掉）；不放進訊息的處理佇列，免得等定位時卡住備份、照片
  let wxChain = Promise.resolve()
  function wxTask(fn) { const p = wxChain.then(fn); wxChain = p.then(() => {}, () => {}); return p }
  async function wxRefresh() { const st = await readWeather(); if (await weatherUpdate(st)) pushWeather(st) }
  function startWeather() {   // 頁面載入後呼叫：背景更新天氣。之後每次回到這個頁面（切回來、從背景叫回來）也更新一次，同一天內 minGapMin 分鐘內不重複聯網
    const d = root.document
    if (d && d.addEventListener) {   // 組頁（document.write）會清掉舊的監聽，所以每次都「先拿掉舊的、再加新的」
      const onVis = () => { if (d.visibilityState === "visible") wxTask(wxRefresh).catch(() => {}) }
      if (root.__wxOnVis) d.removeEventListener("visibilitychange", root.__wxOnVis)
      root.__wxOnVis = onVis; d.addEventListener("visibilitychange", onVis)
    }
    return wxTask(wxRefresh).catch(() => {})
  }
  function doWxCfg(raw) {   // 日誌頁「天氣設定」按了確定：存設定、馬上把新設定套到現有的天氣、再背景重查預報
    let c
    try { c = JSON.parse(raw) } catch (e) { say("天氣設定讀不了"); return }
    wxTask(async () => {
      const st = await readWeather()
      if (!applyWxCfg(c)) { say("天氣設定的數字不合理"); return }
      st.cfg = { fcDays: W.fcDays, hotC: W.hotC }; st.u = 0   // u＝0：強制重查預報
      await saveWeather(st)
      pushWeather(st, "已儲存天氣設定")
      if (await weatherUpdate(st)) pushWeather(st)
    }).catch(e => say("天氣設定失敗：" + (e && e.message || e)))
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
  const UNSUPPORTED = { loadphotos: "整年照片頁", remsave: "提醒" }
  function actionOf(p) {   // 這個訊息要做什麼：同步（沒有任何動作參數）、打開連結、備份、還原，或還沒開放的動作名
    if (p.openurl) return "open"
    if (p.backup !== undefined) return "backup"
    if (p.restore !== undefined) return "restore"
    if (p.addphoto) return "addphoto"
    if (p.delphoto) return "delphoto"
    if (p.movephoto) return "movephoto"
    if (p.wxcfg !== undefined) return "wxcfg"
    for (const k of Object.keys(UNSUPPORTED)) if (p[k] !== undefined) return k
    return "sync"
  }
  const say = (m, ms) => { try { root.toast(m, ms || 3500) } catch (e) {} }
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
    else if (act === "wxcfg") doWxCfg(p.wxcfg)   // 不等它做完：定位和查天氣可能要幾秒，結果做完會自己推回頁面
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
    let wx = {}, cfg
    try { const wst = await readWeather(); wx = weatherForPage(wst); cfg = { fcDays: W.fcDays, hotC: W.hotC } } catch (e) {}   // 天氣讀不到也照樣打開日誌
    const html = assemble(await r.text(), rows, edits, { weather: wx, wxcfg: cfg })
    root.document.open(); root.document.write(html); root.document.close()
  }
  async function importFiles(files) {   // 讀 dataXXXX.json（可一次選好幾個）；回傳摘要
    const s = getStore(), found = []
    for (const f of files) {
      let list
      try { list = JSON.parse(await f.text()) } catch (e) { throw new Error("「" + f.name + "」不是有效的 JSON") }
      if (list && okKind(list.kind) && Array.isArray(list.days)) {   // 備份檔也可以直接當資料來源（例如搬到新手機）
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

  const api = { boot, launch, handle, prePickPhotos, loadCardPhotos, startWeather, weatherForPage, wxRecord, applyWxCfg, readWeather, weatherUpdate, okName, dateOf, assemble, parse, mergeEdits, mergeRows, sortRows, importFiles, validRow, effectiveDays, makeBackupBody, planRestore,
    get store() { return getStore() }, get W() { return W }, useStore(s) { store = s }, memStore }
  root.PwaHost = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof window !== "undefined" ? window : globalThis)

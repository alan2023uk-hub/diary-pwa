/* 日誌 PWA 宿主（第二個宿主）
   頁面（diary_template.html）只負責介面，所有「要宿主幫忙」的事都用 hostSend 發訊息；這個檔案就是 PWA 這一邊的宿主：
     · 儲存：日誌資料（rows）和修改（edits）存在這部裝置的瀏覽器裏（IndexedDB），不上傳到任何地方
     · 組頁：把模板、日誌資料、修改組成頁面，寫進目前的視窗
     · 訊息：頁面的 hostSend 不再導向網址，改由 window.HOST_DELIVER 直接交給 PwaHost.handle
   目前支援：同步（修改存進宿主）、打開連結、全年備份與還原（內容格式和 Scriptable 版相同，兩邊的備份檔可以互相還原；還原可選「合併」——每一天比修改時間，新的留下，只在一邊有的日子都保留——或「完全還原」——整年改成備份的樣子）、卡片照片（加入、顯示、刪除、換日期）。天氣（每張卡片標題欄的「地名 溫度 有雨／下雪 大風 酷熱」、未來預報、日誌頁選單裏的「天氣」設定，規則和 Scriptable 版相同；見下面「天氣」一節）。天氣歷史可以用「⋯」選單的「匯入資料檔」把 Scriptable 版的 weather.json 補進來（可以和日誌資料檔、備份檔一起選，程式依內容自己分；只收已經發生的日子，不覆蓋這裡已定案的）。日誌頁「⋯」選單的「匯入照片」可以先選照片、再選日子（iOS 的網頁沒辦法出現在分享選單裏，所以用這個代替「分享 → Run Script」）。日誌頁「⋯」選單的「匯入資料檔」可以把缺的年份或日子補進來（只加目前沒有的日子，已有的一律不動；見下面 planDataAdd）。提醒（設定、完成、取消、到期通知、備份與還原；規則和 Scriptable 版相同，見下面「提醒」一節）。整年照片頁還沒開放（會在頁面上提示）。
   自動備份（存在這部裝置）：到期（距這一年上次存超過設定的天數、而且之後有修改）時，打開日誌後悄悄把這一年的完整備份存在這部裝置的瀏覽器裏，不彈提示、不要使用者存檔；數量不限，要刪在「還原」視窗的「整理備份…」自己勾選。間隔在「⋯」→「備份與還原」裏的「自動備份」切換。它防的是改錯、還原錯，防不了瀏覽器資料被清掉或換手機：要防那個，用「文字」那排的「備份」把備份檔存進 iCloud。
   注意：照片存在這部裝置的瀏覽器裏；備份檔（.json）只含日誌文字和提醒，不含照片（和 Scriptable 版的備份檔相同）。照片另外備份：選單「照片」那排的「備份」把照片存成一張張 .jpg（經分享選單或下載存成檔案），「還原…」依檔名放回原來的卡片（日誌文字的還原做完就結束，不再追問照片）；網頁版讀不到資料夾，照片檔要自己選取。按卡片上的「加入照片」會直接打開相簿選單（宿主組頁時在按鈕處理函式裏插一行；模板改過、找不到那一行時，會退回先顯示對話框）。 */
(function (root) {
  "use strict"
  const DATERE = /^\d{4}-\d{2}-\d{2}$/
  const DB_NAME = "diary-host", KV = "kv"

  // ---------- 平台判斷：iCloud、Scriptable 的說明只有 iPhone／iPad 的使用者用得到，其他裝置不顯示 ----------
  function isIOS() {
    try {
      const n = root.navigator || {}, ua = n.userAgent || ""
      return /iPhone|iPad|iPod/.test(ua) || (n.platform === "MacIntel" && n.maxTouchPoints > 1)   // iPadOS 的 Safari 預設自稱 Mac，靠觸控點數分辨
    } catch (e) { return false }
  }

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

  // ---------- 提醒資料：一天最多一個（以日期為鍵），格式和 Scriptable 版的 reminders.json 的 items 相同 ----------
  // { id＝日期, date, due（提醒時間，毫秒）, repeat（連續幾天，0＝一次）, done, t（最後修改時間）, txt（設提醒時那天的文字，日子被刪掉時備用）}；取消＝{ id, date, del:true, t }
  const validRem = r => !!r && typeof r === "object" && DATERE.test(r.date || "")
  const mergeRems = mergeEdits   // 規則相同：同一天，時間較新（或一樣）的留下
  function cleanRem(rec) {   // 頁面送來的提醒：只留已知欄位；不合理的回傳 null
    if (!validRem(rec)) return null
    const t = Number(rec.t) || Date.now()
    if (rec.del) return { id: rec.date, date: rec.date, del: true, t }
    const due = Number(rec.due)
    if (!isFinite(due) || due <= 0) return null
    const rp = Math.round(Number(rec.repeat) || 0)
    return { id: rec.date, date: rec.date, due, repeat: rp > 1 ? Math.min(60, rp) : 0, done: !!rec.done, t, txt: typeof rec.txt === "string" ? rec.txt.slice(0, 2000) : "" }
  }
  const yearRems = (year, rems) => new Map((rems || []).filter(r => validRem(r) && !r.del && r.due && r.date.startsWith(year + "-")).map(r => [r.date, r]))
  const sameRem = (a, b) => a.due === b.due && (a.repeat || 0) === (b.repeat || 0) && !!a.done === !!b.done
  const REM_KEEP_MS = 90 * 864e5   // 取消的紀錄（墓碑）留 90 天，讓其他裝置也能同步到「已取消」

  // ---------- 預先打開相簿（省掉「加入照片」中間那個對話框）----------
  // 瀏覽器只准許在「剛按下按鈕」的當下打開選照片的選單；但頁面按下「加入照片」後要先存檔，才把訊息交給宿主，到那時已經過了「剛按下」，所以以前宿主得先顯示一個對話框，請使用者再按一次。
  // 現在的做法：組頁時，在頁面「加入照片」按鈕的處理函式裏，於存檔之前插入一行，按下的當下就呼叫 HOST_PICK_PHOTOS 打開選單；之後宿主收到訊息，只要等使用者選完。
  // 如果模板裏找不到這一行（模板改過），就不插，宿主照舊顯示對話框，功能不受影響。
  const PICK_ANCHOR = "再加入照片');return}await saveEdit(d,ta.value,null,true);"
  const PICK_PATCH = "再加入照片');return}window.HOST_PICK_PHOTOS&&window.HOST_PICK_PHOTOS();await saveEdit(d,ta.value,null,true);"

  // ---------- PDF 入口：卡片編輯列加一顆「加入 PDF」；卡片相片區塊的後面接 PDF 區塊 ----------
  // 和上面一樣，組頁時從宿主這邊改模板（母版和模板檔都不動）；找不到那一行（模板改過）就不改，其他功能不受影響。
  // 編者按 / Editor's note：這兩處是「改字串」，不是改模板檔：模板檔和 Scriptable 母版共用，PDF 只有網頁版有。
  //   These two are string patches applied at assembly time, not edits to the template file: the template is shared with the Scriptable master and only the web version has PDFs.
  const PDF_BTN_ANCHOR = "hostSend({addphoto:d},{go:d,pend:'skip'})};rb.appendChild(pb);"
  const PDF_BTN_PATCH = PDF_BTN_ANCHOR + `if(!IP.filePlus)IP.filePlus='<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>';const pf=ib('filePlus','加入 PDF');pf.onclick=async()=>{if(changed){toast('請先按「儲存」保存提醒設定，再加入 PDF');return}window.HOST_PICK_PDF&&window.HOST_PICK_PDF();await saveEdit(d,ta.value,null,true);hostSend({addpdf:d},{go:d,pend:'skip'})};rb.appendChild(pf);`
  const PDF_ACT_ANCHOR = `function actHtml(d){return '<div class="act">'+remLinks(d)+phHtml(d)+'</div>'}`
  const PDF_ACT_PATCH = `function actHtml(d){return '<div class="act">'+remLinks(d)+phHtml(d)+(window.PwaHost&&window.PwaHost.pdfHtml?window.PwaHost.pdfHtml(d):'')+'</div>'}`
  const PDF_CSS = ".pdfs{display:flex;flex-direction:column;gap:8px;flex-basis:100%;min-width:0}.pdfc{border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent}.pdfc img{display:block;max-width:100%;max-height:78vh;width:auto;height:auto;margin:0 auto}.pdfc.open>img{display:none}" +
    ".pdfm{display:flex;align-items:center;gap:10px;padding:8px 12px;font-size:14px;color:var(--sub);border-top:1px solid var(--line)}.pdfn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.pdfp{flex:none}" +
    ".pdfx{flex:none;font:inherit;font-size:13px;color:inherit;background:none;border:1px solid var(--line);border-radius:8px;padding:2px 10px;cursor:pointer}" +
    ".pdfpgs{display:flex;flex-direction:column;gap:6px;background:var(--line)}.pdfpg{position:relative;width:100%;background:#fff;overflow:hidden}.pdfpg canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}.pdfpn{position:absolute;right:8px;bottom:6px;font-size:12px;padding:1px 8px;border-radius:10px;background:rgba(0,0,0,.45);color:#fff;pointer-events:none}" +
    ".pdfv{position:fixed;left:0;top:0;right:0;bottom:0;z-index:99990;background:#1c1c1e;display:flex;flex-direction:column}.pdfvb{display:flex;align-items:center;gap:8px;padding:calc(8px + env(safe-area-inset-top,0px)) 10px 8px;color:#fff;background:#2a2a2c;flex:none}" +
    ".pdfvb button{font:inherit;font-size:18px;color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:10px;min-width:44px;height:40px;cursor:pointer}.pdfvt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.pdfvn{flex:none;font-size:14px;opacity:.8}" +
    ".pdfvs{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;overscroll-behavior:contain}.pdfvi{width:100%;display:flex;flex-direction:column;gap:8px;padding:8px 0 8px;box-sizing:border-box}" +
    ".pdfvf{flex:none;display:flex;justify-content:center;padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px));background:#2a2a2c}.pdfvd{font:inherit;font-size:15px;color:#ff8a80;background:rgba(255,255,255,.1);border:0;border-radius:10px;height:40px;padding:0 18px;cursor:pointer}.pdfvd.arm{background:#c62828;color:#fff}" +
    ".pdfv [hidden]{display:none!important}.pdfvs{position:relative}" +
    ".pdfvb{background:#000;gap:2px;padding:calc(6px + env(safe-area-inset-top,0px)) 8px 6px}.pdfvb button{background:none;color:#409cff;font-size:17px;min-width:40px;height:40px;padding:0 6px;border-radius:10px;display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}.pdfvb button.on,.pdfvq button.on{background:rgba(64,156,255,.22)}" +
    ".pdfvc{flex:1;min-width:0;justify-content:flex-start!important;gap:6px;color:#fff!important;font-weight:600}.pdfvc .pdfvt{flex:0 1 auto}.pdfvb .pdfvk{font-weight:700}.pdfvn{color:#fff;margin-right:4px}@media (max-width:520px){.pdfvn{display:none}}" +
    ".pdfvq{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1c1c1e;border-bottom:1px solid rgba(255,255,255,.12);flex:none}.pdfvq input{flex:1;min-width:0;font:inherit;font-size:16px;color:#fff;background:rgba(255,255,255,.12);border:0;border-radius:10px;height:36px;padding:0 10px;outline:none}.pdfqn{flex:none;font-size:13px;color:#ccc;min-width:3.5em;text-align:center}.pdfvq button{background:none;color:#409cff;border:0;font:inherit;font-size:17px;min-width:36px;height:36px;cursor:pointer}" +
    ".pdfsb{position:absolute;left:50%;top:calc(58px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:6;display:flex;gap:2px;background:#2c2c2e;border-radius:12px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.5)}.pdfsb button{font:inherit;font-size:15px;color:#fff;background:none;border:0;border-radius:8px;height:36px;padding:0 12px;cursor:pointer}" +
    ".pdfmn{position:absolute;left:8px;top:calc(56px + env(safe-area-inset-top,0px));z-index:7;min-width:200px;background:#2c2c2e;color:#fff;border-radius:12px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.55);display:flex;flex-direction:column}.pdfmn button{font:inherit;font-size:16px;color:#fff;background:none;border:0;border-radius:8px;text-align:left;padding:10px 12px;cursor:pointer}.pdfmz{display:flex;align-items:center;justify-content:space-between;padding:2px 4px}.pdfmz button{text-align:center;min-width:44px;font-size:20px}.pdfmz span{font-size:15px}" +
    ".pdfo{position:absolute;left:0;top:0;transform-origin:0 0}.pdft{position:absolute;left:0;top:0;right:0;bottom:0;line-height:1;-webkit-user-select:text;user-select:text}.pdft span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0}.pdft span::selection,.pdft mark::selection{background:rgba(0,110,255,.35);color:transparent}" +
    ".pdft mark{background:rgba(255,200,0,.5);color:transparent;border-radius:2px}.pdft mark.cur{background:rgba(255,110,0,.7)}.pdfa{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}.pdfa svg{display:block;width:100%;height:100%}" +
    ".pdfv.dr .pdfpg{touch-action:none}.pdfv.dr .pdft{pointer-events:none;-webkit-user-select:none;user-select:none}" +
    ".pdfvm{flex:none;display:flex;align-items:center;gap:2px;overflow-x:auto;padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px));background:#2a2a2c;color:#fff}.pdfmt{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;min-width:52px;height:48px;font:inherit;color:#fff;background:none;border:0;border-radius:10px;cursor:pointer}" +
    ".pdfmt b{font-size:18px;font-weight:600;line-height:1.1}.pdfmt i{font-style:normal;font-size:11px;opacity:.75}.pdfmt.on{background:rgba(64,156,255,.3)}.pdfmt[disabled]{opacity:.3}.pdfmt.pri{color:#409cff;margin-left:auto}" +
    ".pdfcs{flex:none;display:flex;gap:8px;padding:0 8px;align-items:center}.pdfcd{width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.35);padding:0;cursor:pointer}.pdfcd.on{border-color:#fff;box-shadow:0 0 0 2px #409cff}" +
    ".pdfta{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:8px;border:1px solid rgba(128,128,128,.5);border-radius:8px;margin:0 0 .6rem;background:transparent;color:inherit}.pdfsg{display:block;width:100%;height:auto;box-sizing:border-box;touch-action:none;background:#fff;border:1px solid rgba(128,128,128,.5);border-radius:10px;margin:0 0 .5rem}"

  // ---------- 提示文字：母版寫的是「同步到 iCloud」，網頁版的資料其實只存在這部裝置的瀏覽器裏，不會到 iCloud ----------
  // 組頁時把這幾句換成符合事實的字（母版和模板檔都不動）。每一句：在模板裏找得到才換；找不到（模板改過）就照舊顯示原字，功能不受影響。
  // 沒換的：「連不上 iCloud」的離線提示（網頁版不會出現，OFFLINE 固定是 0）；「請用『日誌』腳本打開日誌」的提示（網頁版一定帶提醒資料，REMOK 恆為真，不會出現）。
  // 換過之後，網頁版畫面上不會再有 iCloud／Scriptable 字樣；這兩個詞只出現在 iPhone／iPad 才顯示的宿主對話框（見 isIOS）。
  const TEXT_PATCHES = [
    ["已全部同步到 iCloud", "已全部存到本機"],
    ["已同步到 iCloud", "已存到本機"],
    ["請先按「同步到 iCloud」，再試一次", "請先點一下待同步的標記，再試一次"],
    ["只存在這部裝置，沒有同步到 iCloud", "只存在這部裝置的舊儲存裏"],
    ["自動（跟隨手機）", "自動（跟隨裝置）"]   // 顯示模式選單：「手機」統一說「裝置」
  ]

  // ---------- 組頁：模板 + 日誌資料 + 修改 ----------
  function assemble(tpl, rows, edits, opts) {
    opts = opts || {}
    if (!tpl.includes("__DATA__")) throw new Error("模板裏找不到 __DATA__")
    const esc = o => JSON.stringify(o).replace(/</g, "\\u003c")
    if (tpl.includes(PICK_ANCHOR)) tpl = tpl.replace(PICK_ANCHOR, () => PICK_PATCH)   // 找不到那一行（模板改過）就不插，照舊顯示對話框
    if (tpl.includes(PDF_BTN_ANCHOR)) tpl = tpl.replace(PDF_BTN_ANCHOR, () => PDF_BTN_PATCH)   // 「加入 PDF」按鈕（找不到就沒有這顆按鈕）
    if (tpl.includes(PDF_ACT_ANCHOR)) tpl = tpl.replace(PDF_ACT_ANCHOR, () => PDF_ACT_PATCH)   // 卡片裏的 PDF 區塊（找不到就不顯示）
    for (const [a, b] of TEXT_PATCHES) if (tpl.includes(a)) tpl = tpl.split(a).join(b)   // 提示文字改寫（見上面的 TEXT_PATCHES）
    const html = tpl.replace("__DATA__", () => JSON.stringify(sortRows(rows)).replace(/<\//g, "<\\/"))
    const head = '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png">' +
      '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="日誌">'
    const inject = "<script>window.ICLOUD_EDITS=" + esc(edits) + ";window.UNDATED=0;window.PHOTOS_LOADED=false;window.OFFLINE=0;window.LIVE=true;window.LIVE_PH=true;window.LIVE_BK=true;window.LIVE_RS=true;window.LIVE_ACT=true;window.ICLOUD_REMINDERS=" + esc(opts.rems || []) + ";window.GOTAB=" + esc(opts.tab || "") + ";window.WEATHER=" + esc(opts.weather || {}) + ";window.WXCFG=" + esc(opts.wxcfg || { fcDays: W.fcDays, hotC: W.hotC }) + (opts.bkcfg ? ";window.BKCFG=" + esc(opts.bkcfg) : "") + ";window.SYNC_NAME='本機';window.HOST_NO_LIMIT=true;window.PWA_PHOTOBK=true;window.PWA_PDFBK=true;window.PWA_AUTOCP=true;window.GOTO=" + esc(opts.go || "") + "</script>" +
      '<script src="host-pwa.js"></script><script>window.HOST_DELIVER=function(u){PwaHost.handle(u)};window.HOST_PICK_PHOTOS=function(){PwaHost.prePickPhotos()};window.HOST_PICK_PDF=function(){PwaHost.prePickPdf()};document.addEventListener("DOMContentLoaded",function(){PwaHost.installPhotoImport();PwaHost.loadCardPhotos();PwaHost.installPdf();PwaHost.loadCardPdfs();PwaHost.startWeather();PwaHost.installRemMenu();PwaHost.installDataImport();PwaHost.startReminders();PwaHost.startAutoBackup()})</script>'
    return html.replace("</head>", () => head + "<style>" + PDF_CSS + "</style>" + inject + "</head>")
  }

  // ---------- 備份與還原 ----------
  // 內容的格式和 Scriptable 版一樣（v、year、created、pre、preT、days:[{date,text,t}]、gone:[{date,t}]、reminders、remGone）。
  // v2（現在的格式）：每一天帶修改時間 t（0＝原稿沒改過）；刪除的日子記在 gone；提醒也帶 t，取消的提醒記在 remGone。還原時靠這些時間做「合併」。
  // 兩邊的備份檔互通（都是日誌的備份，兩邊都認得）；檔名和類型（kind）仍然不同，只是用來分辨是哪一邊備份的：
  //   網頁版的備份：pwa_yymmdd_hhmm.json（建立日期；例：pwa_261109_1901.json），kind＝"diary-pwa-backup"
  //   Scriptable 的備份：bk_yymmdd_hhmm.json，kind＝"diary-backup"（放在 iCloud 的 manual_backup 資料夾；以前叫 diary_backups）
  //   日誌年份預設＝建立年份；不同年才在後面加 _y25（例：pwa_270105_2230_y26.json）；還原前自動備份加 _pre（放在 _y 之前）
  //   天數和提醒數不再寫進檔名（檔名太長，檔案App顯示不完整）；Scriptable 的還原選單會讀檔案內容補上
  //   （舊格式 pwa_2026_1109_1901_120d3r.json、diary-pwa_backup_…、backup_… 兩邊都還認得；網頁版靠檔案內容的 kind 判斷，不看檔名）
  //   網頁版備份出來的照片：日期_時間碼_序號.jpg（時間碼＝原檔名裡的 13 位毫秒數轉成 8 位 36 進位，還原時換回來；舊的 diary-pwa_… 前綴照樣認得）
  // 想在 Scriptable 版還原網頁版的日誌備份：把 .json 存進 iCloud 的 manual_backup 資料夾（Scriptable 版認 pwa_ 開頭的檔名）。
  // 舊格式（v1，沒有 gone）的備份也認得：每一天的時間一律當作備份建立的時間，也不含刪除記錄。
  const BK_KIND = "diary-pwa-backup", SCRIPTABLE_KIND = "diary-backup", PWA_PHOTO_PREFIX = "diary-pwa_"
  const okKind = k => k === BK_KIND || k === SCRIPTABLE_KIND
  const p2 = n => String(n).padStart(2, "0")
  const stampOf = t => String(t.getFullYear()).slice(2) + p2(t.getMonth() + 1) + p2(t.getDate()) + "_" + p2(t.getHours()) + p2(t.getMinutes())   // 檔名用：yymmdd_hhmm（建立日期）
  const fmtShort = ms => { const t = new Date(ms); return p2(t.getDate()) + "/" + p2(t.getMonth() + 1) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes()) }   // 按鈕上用的短格式（英式 日/月 時:分，例：十一月九日 19:01＝09/11 19:01）
  const fmtTime = ms => { const t = new Date(ms); return p2(t.getDate()) + "/" + p2(t.getMonth() + 1) + (t.getFullYear() === new Date().getFullYear() ? "" : "/" + String(t.getFullYear()).slice(2)) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes()) }   // 短格式「09/11 19:01」；不是今年的日/月後面加兩位數年份「09/11/25 19:01」
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
  function makeBackupBody(year, rows, edits, now, isPre, rems, photoNames, isAuto) {   // photoNames＝這一年的照片檔名清單（只有手動備份才附上；還原時用來檢查照片齊不齊）
    const { days, pre } = effectiveDays(year, rows, edits)
    const tOf = new Map((edits || []).map(e => [e.date, Number(e.t) || 0]))   // 每一天最後修改的時間（沒有修改紀錄＝0＝原稿沒改過）
    const rl = [...yearRems(year, rems).values()].sort((a, b) => a.date < b.date ? -1 : 1).map(r => ({ id: r.date, date: r.date, due: r.due, repeat: r.repeat || 0, done: !!r.done, t: r.t || 0, txt: r.txt || "" }))
    const remGone = (rems || []).filter(r => validRem(r) && r.del && r.date.startsWith(year + "-")).map(r => ({ date: r.date, t: r.t || 0 }))   // 取消的提醒：合併時讓另一邊也取消
    const gone = (edits || []).filter(e => e && typeof e.date === "string" && e.date.startsWith(year + "-") && !isPreKey(e.date) && !days.has(e.date)).map(e => ({ date: e.date, t: Number(e.t) || 0 }))   // 已刪除（或清空）的日子
    const made = new Date(now), name = "pwa_" + stampOf(made) + (isPre ? "_pre" : "") + (isAuto ? "_auto" : "") + (made.getFullYear() === year ? "" : "_y" + String(year).slice(2)) + ".json"   // 例：pwa_261109_1901.json；日誌年份和建立年份不同才加 _y25
    const body = { v: 2, kind: BK_KIND, app: "pwa", year, created: now, pre, preT: tOf.get(preKey(year)) || 0, days: [...days].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, text]) => ({ date, text, t: tOf.get(date) || 0 })), gone, reminders: rl, remGone }
    if (Array.isArray(photoNames)) body.photos = photoNames
    return { name, body, days: days.size, rems: rl.length }
  }
  function planRestore(year, rows, edits, b, now, rems) {   // 算出還原要做的修改（還沒寫入）；和 Scriptable 版 restoreYear 同一套算法（日誌＋提醒）
    if (!b || !okKind(b.kind) || !Array.isArray(b.days)) return { ok: false, error: "這不是日誌的備份檔" }
    if (b.year !== year) return { ok: false, error: "這份備份是 " + b.year + " 年的，不能還原到 " + year + " 年。請先切換到 " + b.year + " 年再還原。" }
    rems = rems || []
    const inYear = d => DATERE.test(d || "") && d.startsWith(year + "-")
    const target = new Map(b.days.filter(x => x && inYear(x.date) && typeof x.text === "string" && x.text.trim() !== "").map(x => [x.date, x.text]))
    const { raw, rawPre, pre: curPre, days: cur } = effectiveDays(year, rows, edits)
    const preChange = typeof b.pre === "string" && b.pre !== curPre   // 舊備份沒有前言欄位，就不動前言
    const remTouch = Array.isArray(b.reminders)   // 舊備份沒有提醒欄位，就不動提醒
    const bRems = new Map(remTouch ? b.reminders.filter(r => validRem(r) && inYear(r.date) && r.due && target.has(r.date)).map(r => [r.date, r]) : [])
    const curRems = yearRems(year, rems)
    let add = 0, chg = 0, del = 0, remDiff = 0
    for (const [d, t] of target) { if (!cur.has(d)) add++; else if (cur.get(d) !== t) chg++ }
    for (const d of cur.keys()) if (!target.has(d)) del++
    if (remTouch) for (const d of new Set([...curRems.keys(), ...bRems.keys()])) { const x = curRems.get(d), y = bRems.get(d); if (!x || !y || !sameRem(x, y)) remDiff++ }
    const out = { ok: true, target, cur, add, chg, del, preChange, remTouch, remDiff, remCur: curRems.size, remTarget: bRems.size, same: !add && !chg && !del && !preChange && !remDiff, reminders: bRems.size }
    const by = new Map(edits.map(r => [r.date, r]))
    for (const [d, text] of target) {   // 日誌：只改和備份不同的日子
      if (cur.get(d) === text) continue
      if (raw.has(d) && raw.get(d) === text) by.set(d, { date: d, del: true, t: now })   // 回到原稿＝清掉修改
      else by.set(d, { date: d, text, orig: raw.has(d) ? raw.get(d) : null, isNew: !raw.has(d), t: now })
    }
    for (const [d, text] of cur) {
      if (target.has(d)) continue
      if (raw.has(d)) {
        const rec = { date: d, deleted: true, text, orig: raw.get(d), isNew: false, t: now }
        const r = curRems.get(d)
        if (r) rec.rem = { due: r.due, repeat: r.repeat || 0, done: !!r.done }   // 在「已刪除的日子」還原時，提醒一起回來
        by.set(d, rec)
      } else by.set(d, { date: d, del: true, t: now })
    }
    if (preChange) {
      if (b.pre === rawPre) by.set(preKey(year), { date: preKey(year), del: true, t: now })   // 和原稿相同＝清掉修改
      else by.set(preKey(year), { date: preKey(year), text: b.pre, orig: rawPre, pre: true, t: now })
    }
    out.edits = [...by.values()]
    if (remTouch) {   // 提醒：以備份為準
      const remBy = new Map(rems.filter(validRem).map(r => [r.date, r]))
      for (const [d, r] of bRems) {
        const c = curRems.get(d)
        if (c && sameRem(c, r)) continue
        remBy.set(d, { id: d, date: d, due: r.due, repeat: Math.max(0, Math.min(60, Math.round(Number(r.repeat) || 0))), done: !!r.done, t: now, txt: target.get(d) })
      }
      for (const d of curRems.keys()) if (!bRems.has(d)) remBy.set(d, { id: d, date: d, del: true, t: now })
      out.rems = [...remBy.values()]
    }
    return out
  }

  // ---- 備份格式 v2 與「合併還原」（網頁版和 Scriptable 版用同一套規則）----
  // 備份檔：每一天帶修改時間 t（0＝原稿沒改過）；已刪除的日子記在 gone（刪除時間）；提醒也帶 t，取消的提醒記在 remGone。
  // 舊格式的備份（沒有 gone）：每一天的時間一律當作備份建立的時間，也沒有「已刪除」的資料（所以合併時不會刪掉任何日子）。
  function readBackupBody(b, year) {
    const inYear = d => DATERE.test(d || "") && String(d).startsWith(year + "-")
    const v2 = Array.isArray(b.gone), created = Number(b.created) || 0
    const days = new Map(), gone = new Map(), rems = new Map(), remGone = new Map()
    for (const x of b.days || []) if (x && inYear(x.date) && typeof x.text === "string" && x.text.trim() !== "") days.set(x.date, { text: x.text, t: v2 ? (Number(x.t) || 0) : created })
    if (v2) for (const x of b.gone) if (x && inYear(x.date) && !days.has(x.date)) gone.set(x.date, Number(x.t) || 0)
    const remTouch = Array.isArray(b.reminders)
    if (remTouch) for (const r of b.reminders) if (r && inYear(r.date) && r.due) rems.set(r.date, { date: r.date, due: Number(r.due), repeat: Math.max(0, Math.min(60, Math.round(Number(r.repeat) || 0))), done: !!r.done, t: Number(r.t) || created })
    if (Array.isArray(b.remGone)) for (const x of b.remGone) if (x && inYear(x.date)) remGone.set(x.date, Number(x.t) || 0)
    return { v2, created, days, gone, rems, remGone, remTouch, pre: typeof b.pre === "string" ? b.pre : null, preT: v2 ? (Number(b.preT) || 0) : created }
  }
  // 合併：逐日比修改時間，備份「嚴格較新」才蓋掉本機；一樣新或本機較新就留本機。只在一邊有的日子都保留（備份裏沒出現的日子完全不動）。
  // 備份記了刪除、而且比本機的修改新，才刪；本機沒有這一天、也沒有刪除紀錄，就直接加進來。保留備份原本的時間 t，不蓋成「現在」。
  // eff＝effectiveDays() 的結果；edits＝修改列；remItems＝提醒列（含取消的紀錄）；回傳新的 edits／提醒（還沒寫入）和摘要。
  function planMerge(year, eff, edits, remItems, nb, now) {
    const { raw, rawPre, pre: curPre, days: cur } = eff
    const by = new Map((edits || []).map(r => [r.date, r]))
    const lt = d => { const e = by.get(d); return e ? (Number(e.t) || 0) : 0 }   // 本機這一天最後修改的時間
    const curRem = new Map((remItems || []).map(r => [r.date, r]))
    const final = new Map(cur), deletedNow = new Set()
    let add = 0, chg = 0, del = 0, keep = 0
    for (const [d, x] of nb.days) {
      if (cur.get(d) === x.text) continue
      const local = cur.has(d)
      if ((local || by.has(d)) && !(x.t > lt(d))) { keep++; continue }
      const t = x.t || now
      if (raw.has(d) && raw.get(d) === x.text) by.set(d, { date: d, del: true, t })   // 回到原稿＝清掉修改
      else by.set(d, { date: d, text: x.text, orig: raw.has(d) ? raw.get(d) : null, isNew: !raw.has(d), t })
      final.set(d, x.text)
      if (local) chg++; else add++
    }
    for (const [d, t] of nb.gone) {
      if (!cur.has(d)) continue
      if (!(t > lt(d))) { keep++; continue }
      const r = curRem.get(d)
      if (raw.has(d)) {
        const rec = { date: d, deleted: true, text: cur.get(d), orig: raw.get(d), isNew: false, t }
        if (r && !r.del && r.due) rec.rem = { due: r.due, repeat: r.repeat || 0, done: !!r.done }   // 在「已刪除的日子」還原時，提醒一起回來
        by.set(d, rec)
      } else by.set(d, { date: d, del: true, t })
      final.delete(d); deletedNow.add(d); del++
    }
    let preChange = false
    if (nb.pre !== null && nb.pre !== curPre && nb.preT > lt(preKey(year))) {
      const t = nb.preT || now
      if (nb.pre === rawPre) by.set(preKey(year), { date: preKey(year), del: true, t })
      else by.set(preKey(year), { date: preKey(year), text: nb.pre, orig: rawPre, pre: true, t })
      preChange = true
    }
    const remBy = new Map((remItems || []).map(r => [r.date, r])), remChanged = []
    const setRem = rec => { remBy.set(rec.date, rec); remChanged.push(rec) }
    if (nb.remTouch) {
      for (const [d, br] of nb.rems) {
        if (!final.has(d)) continue   // 這一天合併後不存在，提醒也不收
        const c = curRem.get(d)
        if (c && !c.del && sameRem(c, br)) continue
        if (c && !(br.t > (Number(c.t) || 0))) continue
        setRem({ id: d, date: d, due: br.due, repeat: br.repeat, done: br.done, t: br.t || now, txt: final.get(d) })
      }
      for (const [d, t] of nb.remGone) {
        const c = curRem.get(d)
        if (c && !c.del && t > (Number(c.t) || 0)) setRem({ id: d, date: d, del: true, t })
      }
    }
    for (const d of deletedNow) { const c = remBy.get(d); if (c && !c.del) setRem({ id: d, date: d, del: true, t: now }) }   // 這次合併刪掉的日子，提醒一起取消
    const remCount = [...remBy.values()].filter(r => !r.del && r.due && String(r.date).startsWith(year + "-")).length
    return { add, chg, del, keep, preChange, remChanged, remDiff: remChanged.length, remCount, days: final.size, same: !add && !chg && !del && !preChange && !remChanged.length, edits: [...by.values()], rems: [...remBy.values()] }
  }
  const mergeSummary = mp => [mp.add && "新增 " + mp.add + " 天", mp.chg && "更新 " + mp.chg + " 天", mp.del && "刪除 " + mp.del + " 天", mp.preChange && "前言更新", mp.remDiff && "提醒 " + mp.remDiff + " 則有變動", mp.keep && "留本機較新 " + mp.keep + " 天"].filter(Boolean).join("、")

  // ---------- 對話框（備份、還原要用）----------
  const CSS = ".hu-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}" +
    ".hu-box{width:min(26rem,100%);max-height:100%;overflow:auto;box-sizing:border-box;background:#fff;color:#222;border-radius:14px;padding:18px 18px 12px;font:15px/1.6 -apple-system,'PingFang TC','Noto Sans TC',sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.3)}" +
    ".hu-box h3{margin:0 0 .5rem;font-size:1.05rem}.hu-box p{margin:0 0 .9rem;white-space:pre-wrap;color:#555}" +
    ".hu-btn{display:block;width:100%;margin:.4rem 0;padding:.7rem;border:1px solid #2f5d8a;border-radius:10px;background:none;color:#2f5d8a;font:inherit;line-height:1.4;white-space:normal;overflow-wrap:anywhere}.hu-btn.pri{background:#2f5d8a;color:#fff}.hu-btn.dng{border-color:#b3261e;color:#b3261e}" +
    ".hu-list{margin:0 0 .5rem;border:1px solid rgba(128,128,128,.35);border-radius:10px;max-height:50vh;overflow:auto}" +
    ".hu-row{display:flex;align-items:center;gap:.75rem;padding:.7rem .8rem;border-bottom:1px solid rgba(128,128,128,.25);cursor:pointer}.hu-row:last-child{border-bottom:0}.hu-row input{flex:none;width:1.3rem;height:1.3rem;margin:0}.hu-row small{display:block;color:#888;font-size:.8rem;line-height:1.3}" +
    ".hu-btn[disabled]{opacity:.4}" +
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
  async function deliverFile(name, text) {   // 支援分享選單的裝置：開分享選單（可存成檔案）；其他：直接下載。回傳 "shared" | "downloaded" | "cancelled" | "failed"
    const nav = root.navigator, file = new root.File([text], name, { type: "application/json" })
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file] }); return "shared" } catch (e) {   // 不帶 title／text：iOS 存到「檔案」時會把標題另存成「文字.txt」
        if (e && e.name === "AbortError") return "cancelled"
        if (e && e.name !== "NotAllowedError") { download(name, text); return "downloaded" }   // 分享本身失敗（例如這部裝置的分享選單收不了這種檔案）：直接改用下載，不再報失敗
        // 分享選單要在「剛按下」時才能打開；時間過了就請使用者再按一次
        return await modal("備份已準備好", name, [
          { label: "儲存備份檔", kind: "pri", onclick: done => nav.share({ files: [file] }).then(() => done("shared"), err => { if (err && err.name === "AbortError") done("cancelled"); else { download(name, text); done("downloaded") } }) },   // 分享失敗就改用下載
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
    const r = makeBackupBody(year, await s.get("rows") || [], await s.get("edits") || [], Date.now(), false, await readRems(), yearPhotoNames(await photoIndex(), year))
    // 編者按 / Editor's note：文字備份和照片、PDF 備份一致：每次都先彈出一個訊息視窗（有「備份」和「不用了」），按了「備份」才開分享選單；「存到哪裏」的說明只在第一次出現、而且併在這個視窗裡（不要另外再彈一個視窗）。
    //   English: text backup now matches photo and PDF backup: a message window first (備份 / 不用了), the share sheet opens only after 備份; the "where to save" explanation appears only the first time and lives inside this same window (no second window).
    const seen = !!await s.get("hint:backup")
    const msg = year + " 年有 " + r.days + " 天日誌、" + r.rems + " 則提醒。" + (seen ? "" : "\n\n備份會存到你接著選的位置。" + (isIOS()
      ? "\n\n日誌（.json）：兩邊通用，請存進 iCloud Drive › Scriptable › manual_backup（Scriptable 版的還原選單認得），第一次選好之後 iOS 會記住這個位置。\n照片（.jpg）：請存進 iCloud Drive › Scriptable › pwa_photos（和 Scriptable 版的 diary_photos 分開，不要混在一起）。\nPDF：請存進 iCloud Drive › Scriptable › pwa_pdfs。"
      : "\n\n照片（.jpg）和 PDF 建議另建專用資料夾（例如「日誌網頁版備份」），之後比較好找。"))
    const go = await modal("備份 " + year + " 年文字", msg, [{ label: "備份（" + r.days + " 天）", kind: "pri", value: true }, { label: "不用了", value: false }])
    if (!go) return false
    if (!seen) await s.set("hint:backup", 1)
    const how = await deliverFile(r.name, JSON.stringify(r.body))
    say(how === "cancelled" ? "已取消備份" : how === "failed" ? "備份失敗，請再試一次" : "已備份 " + year + " 年：" + r.days + " 天、" + r.rems + " 則提醒" + (how === "downloaded" ? "（已下載 " + r.name + "）" : ""))
    const saved = how === "shared" || how === "downloaded"
    return saved   // 照片不在這裏問了：用選單的「備份照片」按鈕另外備份
  }
  // ---------- 自動備份（存在這部裝置）----------
  // 編者按 / Editor's note：網頁版的「自動備份」＝悄悄把每一年的完整備份存在這部裝置裏（IndexedDB）：不彈提示、不叫使用者存檔；數量不設上限，要刪由使用者在「還原」視窗的「整理備份…」自己勾選。
  //   不要改回「提示使用者儲存」，也不要加張數上限或自動刪舊的（使用者明確要求不限、自己刪）。它防的是改錯、還原錯，防不了瀏覽器資料被清掉或換手機——那要靠「備份」按鈕存進 iCloud 的檔案；面板上的說明要照實寫「存在這部裝置」。
  //   English: the web version's "auto backup" silently keeps full per-year copies on this device (IndexedDB): no prompts, no cap, nothing auto-pruned; the user deletes copies by hand via "整理備份…" in the restore window. Do not go back to prompt-to-save and do not add a cap or auto-delete (explicitly requested).
  //   It guards against bad edits/restores, NOT against cleared browser data or a lost device; only the manual 備份 file saved to iCloud does that, so the panel text must say "存在這部裝置" honestly.
  // 儲存方式：每一份獨立一個鍵（autocp:<id>，內容＝{ created, body }），另有一份清單（autocp:index：[{ id, year, created, days, rems, bytes }]，新到舊），列清單、算空間不用把整份備份讀出來。id＝年份-建立時間（毫秒）。
  // 什麼時候存：設定的間隔（autobk:cfg，天數，0＝關閉）過了、而且這一年上次存完之後有修改（或這一年還沒有任何一份）→ 存一份。「上次」以清單裏這一年最新一份為準（刪掉了就不算），所以刪光之後下次檢查會再存一份。
  // 以前的「提示式」自動備份（autobk:last、autobk:snooze、autobackup 資料夾的檔案）不再使用；舊的記錄留在原處不動，Scriptable 版的還原選單仍然認得那些舊檔案。
  const AUTO_BK_DAYS = 7
  const okBkDays = n => Number.isInteger(n) && n >= 0 && n <= 365
  const bkDaysLabel = n => n === 0 ? "關閉" : n === 7 ? "每週" : n === 30 ? "每月" : "每 " + n + " 天"
  async function readBkDays() { const v = await getStore().get("autobk:cfg"); return v && okBkDays(v.days) ? v.days : AUTO_BK_DAYS }
  const AC_INDEX = "autocp:index", acKey = id => "autocp:" + id
  let acChain = Promise.resolve()   // 清單的讀改寫排成一條隊：自動存和整理刪除同時進行時，不會互相蓋掉
  function acTask(fn) { const p = acChain.then(fn); acChain = p.then(() => {}, () => {}); return p }
  async function readAcIndex() {   // [{ id, year, created, days, rems, bytes }]，新到舊
    const v = await getStore().get(AC_INDEX)
    return (Array.isArray(v) ? v : []).filter(x => x && typeof x.id === "string" && Number.isInteger(x.year) && Number.isFinite(x.created)).sort((a, b) => b.created - a.created || b.year - a.year)
  }
  async function readAcBody(id) { const v = await getStore().get(acKey(id)); return v && v.body && typeof v.body === "object" ? v.body : null }
  async function deleteAutoCopies(ids) {   // 回傳刪完後的清單。先改清單、再刪內容：中途出錯，最多留下看不到的舊內容，不會留下「點了卻讀不到」的項目
    return acTask(async () => {
      const s = getStore(), gone = new Set(ids), idx = (await readAcIndex()).filter(x => !gone.has(x.id))
      await s.set(AC_INDEX, idx)
      for (const id of gone) { try { await s.del(acKey(id)) } catch (e) {} }
      return idx
    })
  }
  async function bkCfgForPage() {   // 給頁面「自動備份」那一行：間隔天數＋上次存的時間（日/月 時:分，沒有就空字串）
    const last = (await readAcIndex()).reduce((a, x) => Math.max(a, x.created), 0)
    return { days: await readBkDays(), last: last ? fmtTime(last) : "" }
  }
  async function doBkCfg(raw) {   // 頁面「自動備份」那顆按鈕切換了間隔
    let days
    try { days = JSON.parse(raw).days } catch (e) { return }
    if (!okBkDays(days)) return
    await getStore().set("autobk:cfg", { v: 1, days })
    say("自動備份：" + bkDaysLabel(days))
    if (days > 0) autoBackupCheck().catch(() => {})   // 剛開啟（或改短）：不用等下次打開，現在就看有沒有該存的
  }
  async function autoBackupItems(now) {   // 現在該存的年份（沒開啟、或都還不到期，回傳空陣列）
    const days = await readBkDays()
    if (days <= 0) return []
    const s = getStore(), rows = await s.get("rows") || [], edits = await s.get("edits") || [], rems = await readRems(), idx = await readAcIndex()
    const years = new Set(rows.map(r => +String(r[0]).slice(0, 4)).filter(y => y > 1999))
    for (const e of edits) { const m = /^(\d{4})-/.exec(e && e.date || ""); if (m) years.add(+m[1]) }
    const out = []
    for (const y of [...years].sort()) {
      const lastMs = idx.filter(x => x.year === y).reduce((a, x) => Math.max(a, x.created), 0)
      if (lastMs && now - lastMs < days * 864e5) continue
      if (lastMs && ![...edits, ...rems].some(r => r && String(r.date || "").startsWith(y + "-") && (Number(r.t) || 0) > lastMs)) continue   // 上次存完之後沒有修改
      if (!effectiveDays(y, rows, edits).days.size) continue   // 這一年沒有內容
      const r = makeBackupBody(y, rows, edits, now, false, rems, undefined, true)
      out.push({ year: y, name: r.name, body: r.body, text: JSON.stringify(r.body), days: r.days, rems: r.rems })
    }
    return out
  }
  let autoBusy = false
  async function autoBackupCheck() {   // 回傳 true＝這次有存新的（悄悄存，沒有任何提示；存失敗才提醒，而且一天最多一次）
    if (autoBusy) return false
    autoBusy = true
    try {
      const now = Date.now(), items = await autoBackupItems(now)
      if (!items.length) return false
      await acTask(async () => {
        const s = getStore(), idx = await readAcIndex()
        for (const it of items) {
          const id = it.year + "-" + now
          await s.set(acKey(id), { created: now, body: it.body })
          idx.push({ id, year: it.year, created: now, days: it.days, rems: it.rems, bytes: it.text.length })
          await s.set(AC_INDEX, idx)   // 每存好一份就更新清單：中途出錯，已存好的也都在清單裏
        }
      })
      try { if (root.BKCFG) root.BKCFG.last = fmtTime(now) } catch (e) {}   // 頁面「自動備份」那一行的「上次」換成現在
      return true
    } catch (e) {
      try { await wxHintOnce("hint:acfail", "自動備份沒有存成功（可能是這部裝置的儲存空間滿了）：請到「⋯」→「備份與還原」→「還原…」→「整理備份…」刪掉不要的備份，或用「備份」按鈕存成檔案") } catch (e2) {}
      return false
    } finally { autoBusy = false }
  }
  const fmtMB = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB"
  const acLabel = x => fmtShort(x.created) + " · " + x.days + "天" + (typeof x.rems === "number" ? " · " + x.rems + "提醒" : "")   // 還原視窗按鈕上用的（和「還原前…」同一個格式）
  async function manageAutoCopies() {   // 「還原」視窗的「整理備份…」：勾選要刪的自動備份（所有年份），按「刪除」再按一次確認才真的刪；刪完留在清單裏，可以接著整理
    const d = root.document
    if (!d.getElementById("hu-css")) { const st = d.createElement("style"); st.id = "hu-css"; st.textContent = CSS; d.head.appendChild(st) }
    let idx = await readAcIndex()
    return new Promise(res => {
      const sel = new Set()
      let armed = false
      const o = d.createElement("div"), b = d.createElement("div"), h = d.createElement("h3"), m = d.createElement("p"), list = d.createElement("div")
      const bAll = d.createElement("button"), bDel = d.createElement("button"), bOk = d.createElement("button")
      o.className = "hu-ov"; b.className = "hu-box"; b.setAttribute("role", "dialog"); h.textContent = "整理自動備份"; list.className = "hu-list"
      for (const x of [bAll, bDel, bOk]) { x.type = "button"; x.className = "hu-btn" }
      bDel.classList.add("dng"); bOk.textContent = "完成"
      const sync = () => {
        bAll.style.display = bDel.style.display = idx.length ? "" : "none"
        bAll.textContent = sel.size && sel.size === idx.length ? "取消全選" : "全選"
        bDel.disabled = !sel.size
        bDel.textContent = armed ? "再按一次：永久刪除 " + sel.size + " 份（無法還原）" : "刪除（已選 " + sel.size + " 份）"
      }
      const render = () => {
        m.textContent = idx.length ? "共 " + idx.length + " 份，約 " + fmtMB(idx.reduce((a, x) => a + (x.bytes || 0), 0)) + "。勾選要刪除的備份。" : "目前沒有自動備份。"
        list.style.display = idx.length ? "" : "none"
        list.replaceChildren(...idx.map(x => {
          const lb = d.createElement("label"), cb = d.createElement("input"), tx = d.createElement("span"), sm = d.createElement("small")
          lb.className = "hu-row"; cb.type = "checkbox"; cb.checked = sel.has(x.id)
          cb.onchange = () => { if (cb.checked) sel.add(x.id); else sel.delete(x.id); armed = false; sync() }
          tx.textContent = x.year + " 年　" + fmtTime(x.created) + " · " + x.days + " 天" + (typeof x.rems === "number" ? " · " + x.rems + " 提醒" : ""); sm.textContent = fmtMB(x.bytes || 0); tx.appendChild(sm)
          lb.append(cb, tx); return lb
        }))
        sync()
      }
      bAll.onclick = () => { if (sel.size === idx.length) sel.clear(); else idx.forEach(x => sel.add(x.id)); armed = false; render() }
      bDel.onclick = async () => {
        if (!sel.size) return
        if (!armed) { armed = true; sync(); return }
        bDel.disabled = true
        const n = sel.size
        try { idx = await deleteAutoCopies([...sel]); say("已刪除 " + n + " 份自動備份") } catch (e) { say("刪除失敗：" + (e && e.message || e)) }
        sel.clear(); armed = false; render()
      }
      bOk.onclick = () => { o.remove(); res(true) }
      b.append(h, m, list, bAll, bDel, bOk); o.appendChild(b); d.body.appendChild(o)
      render()
    })
  }
  function startAutoBackup() {   // 頁面載入後呼叫：稍等一下檢查一次；之後每次回到日誌（隔了六小時以上）再檢查
    const d = root.document
    let lastCheck = 0
    const go = () => { if (d.visibilityState && d.visibilityState !== "visible") return; lastCheck = Date.now(); autoBackupCheck().catch(() => {}) }
    root.setTimeout(go, 4000)
    if (d.addEventListener) d.addEventListener("visibilitychange", () => { if (d.visibilityState === "visible" && Date.now() - lastCheck > 6 * 3600e3) root.setTimeout(go, 1500) })
  }
  async function doRestore(yearStr) {   // 回傳 true＝有改動（呼叫端要把最新的修改推回頁面）
    if (!/^\d{4}$/.test(yearStr || "")) { say("還原失敗：年份不對"); return false }
    const year = +yearStr, s = getStore(), pres = await s.get("pre:" + year) || []
    // 編者按 / Editor's note：還原視窗只做「還原」：選備份檔、這一年的自動備份、還原前自動留下的備份，加上「整理備份…」。不要把「還原照片」「匯入天氣」放回來（照片在選單「照片」那排、天氣和資料檔在「匯入資料檔」），
    //   也不要在日誌還原完之後自動追問要不要還原照片（使用者要求拿掉）。還原前自動留下的備份（固定 5 份）和自動備份分開，不放進「整理備份…」。
    //   English: this window only restores (file / this year's auto copies / pre-restore copies) plus "整理備份…". Do not put photo restore or weather import back here, and do not re-add the automatic "restore photos too?" prompt after a restore (removed on request). The 5 pre-restore copies stay separate from the auto copies.
    const AC_SHOW = 5   // 視窗裏先列最近幾份自動備份；更多的放進「更多自動備份…」
    let pick
    for (;;) {
      const all = await readAcIndex(), acs = all.filter(x => x.year === year)
      const buttons = [{ label: "從檔案…", kind: "pri", onclick: pickFile }]
      acs.slice(0, AC_SHOW).forEach(x => buttons.push({ label: "自動 " + acLabel(x), value: { auto: x.id } }))
      if (acs.length > AC_SHOW) buttons.push({ label: "更多自動備份（共 " + acs.length + " 份）…", value: "more" })
      pres.forEach((x, i) => buttons.push({ label: "還原前 " + fmtShort(x.created) + " · " + x.body.days.length + "天" + (Array.isArray(x.body.reminders) ? " · " + x.body.reminders.length + "提醒" : ""), value: { pre: i } }))
      if (all.length) buttons.push({ label: "整理備份…", value: "manage" })
      buttons.push({ label: "取消", value: null })
      const got = await modal("還原 " + year + " 年日誌", "選一份備份檔（.json）" + (acs.length || pres.length ? "，或下面自動留存、還原前自動留下的備份" : ""), buttons)
      if (got === "manage") { await manageAutoCopies(); continue }   // 整理完回到這個視窗（清單已經更新）
      if (got === "more") {
        const m = await modal("選一份自動備份", year + " 年的自動備份，新到舊", [...acs.map(x => ({ label: acLabel(x), value: { auto: x.id } })), { label: "返回", value: null }])
        if (m) { pick = m; break }
        continue
      }
      pick = got; break
    }
    if (!pick) return false
    let b
    try {
      b = pick.file ? JSON.parse(await pick.file.text()) : pick.auto ? await readAcBody(pick.auto) : pres[pick.pre].body
      if (!b) throw new Error("這份自動備份讀不到（可能已經刪除了）")
    } catch (e) { await modal("備份檔讀取失敗", String(e && e.message || e), [{ label: "好", value: 1 }]); return false }
    const rows = await s.get("rows") || [], edits = await s.get("edits") || [], rems = await readRems(), now = Date.now()
    const plan = planRestore(year, rows, edits, b, now, rems)
    if (!plan.ok) { await modal("沒辦法還原", plan.error, [{ label: "好", value: 1 }]); return false }
    if (plan.same) { await modal("不需要還原", "目前的日誌，與這份備份完全相同。", [{ label: "好", value: 1 }]); return false }
    const parts = []
    if (plan.add) parts.push("新增 " + plan.add + " 天")
    if (plan.chg) parts.push("改回備份內容 " + plan.chg + " 天")
    if (plan.del) parts.push("刪除 " + plan.del + " 天")
    if (plan.preChange) parts.push("前言改回備份內容")
    const nb = readBackupBody(b, year)
    const mp = planMerge(year, effectiveDays(year, rows, edits), edits, rems, nb, now), ms = mergeSummary(mp)
    const choice = await modal("還原 " + year + " 年？", "備份 " + fmtTime(b.created || now) + (b.kind === BK_KIND ? "（網頁版）" : "") + (nb.v2 ? "" : "\n舊格式備份，不含刪除記錄") +
      "\n\n合併：" + plan.cur.size + " → " + mp.days + " 天" + (ms ? "（" + ms + "）" : "（沒有變動）") +
      "\n完全還原：" + plan.cur.size + " → " + plan.target.size + " 天" + (parts.length ? "（" + parts.join("、") + "）" : "（內容相同）") +
      (plan.remTouch ? "\n提醒：" + plan.remCur + " → " + plan.remTarget + " 則" + (plan.remDiff ? "（" + plan.remDiff + " 則有變動）" : "") : "") + "\n\n還原前會自動備份目前內容。",
      [{ label: "合併（留較新的）", kind: "pri", value: "merge" }, { label: "完全還原（以備份為準）", kind: "dng", value: "full" }, { label: "取消", value: null }])
    if (!choice) return false
    if (choice === "merge") {
      if (mp.same) { await modal("不需要合併", "本機的日誌和提醒都不比這份備份舊，沒有需要更新的。", [{ label: "好", value: 1 }]); return false }
      await savePre(year, { created: now, body: makeBackupBody(year, rows, edits, now, true, rems).body })   // 合併前先存一份
      await s.set("edits", mp.edits)
      if (mp.remDiff) { await saveRems(mp.rems); await markFired(mp.remChanged, now) }   // 備份裏已經過去的提醒時間，不要合併完馬上又響
      say("已合併 " + year + " 年：" + mp.days + " 天、" + mp.remCount + " 則提醒（合併前已自動備份）")
      return true
    }
    await savePre(year, { created: now, body: makeBackupBody(year, rows, edits, now, true, rems).body })   // 還原前先存一份
    await s.set("edits", plan.edits)
    if (plan.remTouch) { await saveRems(plan.rems); await markFired(plan.rems, now) }   // 備份裏已經過去的提醒時間，不要還原完馬上又響
    say("已還原 " + year + " 年：" + plan.target.size + " 天" + (plan.remTouch ? "、" + plan.remTarget + " 則提醒" : "") + "（還原前已自動備份）")
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
  function pickImages(done) {   // 在按鈕被按下的當下呼叫（相片圖庫／拍照／檔案，依裝置而定）
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
    const pick = await modal("加入照片到 " + date, "選取一張或好幾張相片，會縮小後存在這部裝置。", [{ label: "相片…", kind: "pri", onclick: pickImages }, { label: "取消", value: null }])
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
  // ---------- 先選照片、再選日子（和 Scriptable 版「分享 → Run Script → 選日子」同一個順序）----------
  // iOS 上的網頁（PWA）沒辦法出現在分享選單裏，所以改在日誌頁「⋯」選單加一個「匯入照片」：先選照片，再選日子，照片就放進那一天的卡片。
  // 照片的處理和卡片上的「加入照片」完全一樣（縮小後存在這部裝置）。按鈕由宿主在頁面載入後自己加到選單（installPhotoImport），模板不用改；找不到選單就不加，其他功能不受影響。
  async function dayHasText(date) {   // 這一天現在有沒有日誌文字（沒有文字就沒有卡片，照片放進去也看不到）
    try { const s = getStore(); return effectiveDays(date.slice(0, 4), await s.get("rows") || [], await s.get("edits") || []).days.has(date) } catch (e) { return true }   // 查不到就不亂提醒
  }
  const okImportDate = v => DATERE.test(v || "") && ymd(noon(v)) === v && +v.slice(0, 4) >= 2000 && +v.slice(0, 4) <= 2100   // 年份範圍和頁面新增日子的規則一樣
  function askDate(count, def) {   // 問要放到哪一天；回傳 "YYYY-MM-DD"，取消回傳 null
    return new Promise(res => {
      const d = root.document
      if (!d.getElementById("hu-css")) { const st = d.createElement("style"); st.id = "hu-css"; st.textContent = CSS; d.head.appendChild(st) }
      const o = d.createElement("div"), b = d.createElement("div"), h = d.createElement("h3"), m = d.createElement("p"), inp = d.createElement("input"), hint = d.createElement("p"), go = d.createElement("button"), no = d.createElement("button")
      o.className = "hu-ov"; b.className = "hu-box"; b.setAttribute("role", "dialog")
      h.textContent = "把 " + count + " 張照片放到哪一天？"; m.textContent = "選好日期，按「放進這一天」。"
      inp.type = "date"; inp.value = def; inp.min = "2000-01-01"; inp.max = "2100-12-31"
      inp.style.cssText = "display:block;width:100%;box-sizing:border-box;margin:0 0 .6rem;padding:.6rem;font:inherit;border:1px solid #888;border-radius:10px;background:transparent;color:inherit"
      hint.style.cssText = "min-height:1.3em;margin:0 0 .6rem;font-size:.92em"
      go.type = "button"; go.className = "hu-btn pri"; go.textContent = "放進這一天"
      no.type = "button"; no.className = "hu-btn"; no.textContent = "取消"
      let tok = 0
      const check = async () => {   // 日期不對就不能按；這一天沒有文字就提醒（照片還是會存起來）
        const v = inp.value, my = ++tok
        go.disabled = !okImportDate(v)
        if (go.disabled) { hint.textContent = "請選一個日期（2000–2100 年）"; return }
        const has = await dayHasText(v)
        if (my === tok) hint.textContent = has ? "" : "這一天還沒有日誌文字：照片會先存起來，等你寫了文字，才會在卡片裏出現。"
      }
      const done = v => { o.remove(); res(v) }
      inp.addEventListener("input", check); inp.addEventListener("change", check)
      go.onclick = () => { if (okImportDate(inp.value)) done(inp.value) }
      no.onclick = () => done(null)
      b.append(h, m, inp, hint, go, no); o.appendChild(b); d.body.appendChild(o)
      check()
    })
  }
  function startPhotoImport() {   // 「匯入照片」按鈕按下的當下呼叫：先打開相簿（瀏覽器只准許在剛按下時打開），選完再問日期
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.hidden = true
    inp.onchange = async () => {
      const fs = [...(inp.files || [])]; inp.remove()
      if (!fs.length) return
      try {
        const date = await askDate(fs.length, ymd(new Date()))   // 問日期不放進訊息佇列：對話框開著的時候，頁面的同步、備份照常進行
        if (!date) { say("已取消，照片沒有加入"); return }
        queue = queue.then(() => addPhotoFiles(date, fs)).then(() => {   // 加完跳到那一天（那一天沒有卡片就不跳）
          const el = typeof root.goDay === "function" ? root.goDay(date) : null
          if (el && el.classList) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2500) }
        }).catch(e => say("出錯了：" + (e && e.message || e)))
      } catch (e) { say("出錯了：" + (e && e.message || e)) }
    }
    inp.addEventListener("cancel", () => inp.remove())
    d.body.appendChild(inp); inp.click()
  }
  function installPhotoImport() {   // 頁面載入後呼叫：在「⋯」選單裏加一個「匯入照片」按鈕（找不到選單，或已經加過，就什麼都不做）
    try {
      const d = root.document, menu = d && d.querySelector && d.querySelector("#pd .menu")
      if (!menu || d.getElementById("phx")) return
      const b = d.createElement("button")
      b.className = "mi"; b.id = "phx"; b.type = "button"; b.setAttribute("data-lb", "匯入照片"); b.setAttribute("aria-label", "匯入照片：先選照片，再選日子"); b.title = "先選照片，再選日子"
      if (typeof root.ico === "function") b.insertAdjacentHTML("afterbegin", root.ico("imagePlus"))
      b.onclick = () => { startPhotoImport(); if (typeof root.pdClose === "function") root.pdClose() }   // 先打開相簿（要在按下的當下），再收起選單
      menu.appendChild(b)
    } catch (e) {}
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

  // ---------- 卡片 PDF：原檔存在這部裝置（IndexedDB），卡片裏顯示第一頁的縮圖 ----------
  // 編者按 / Editor's note：使用者要看的是「原本的 PDF」（銀行結單、電子機票），所以存的是原檔；縮圖只是卡片上的預覽。不要改成抽文字或 OCR。
  //   The user wants to see the ORIGINAL PDF (statements, e-tickets): the original file is stored and the thumbnail is only a card preview. Do not switch to text extraction or OCR.
  // 儲存鍵：pdfIndex（清單）、pdf:<內部檔名>（原檔）、pdfthumb:<內部檔名>（第一頁縮圖 JPEG）。內部檔名＝「日期_毫秒_序號.pdf」，原來的檔名記在清單的 n。
  // 內部檔名以 .pdf 結尾，照片那一套（okName、dateOf 只認 .jpg）碰不到它們；備份、還原、刪除、改日期是後面的步驟。
  const PDF_THUMB_W = 900, PDF_WARN = 20 * 1048576   // 縮圖寬度（像素）；超過這個大小（20 MB）加入前先問
  const pdfDateOf = n => /^\d{4}-\d{2}-\d{2}_[\w.-]+\.pdf$/.test(n || "") ? n.slice(0, 10) : ""
  const escH = v => String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  let pdfjsP = null
  function loadPdfjs() {   // 第一次要用才載入（pdf.min.mjs 和 pdf.worker.min.mjs 放在網頁同一個資料夾）；載入失敗下次會再試
    if (!pdfjsP) {
      pdfjsP = import(new root.URL("pdf.min.mjs", root.location.href).href).then(m => { m.GlobalWorkerOptions.workerSrc = new root.URL("pdf.worker.min.mjs", root.location.href).href; return m })
      pdfjsP.catch(() => { pdfjsP = null })
    }
    return pdfjsP
  }
  async function readPdf(file) {   // 回傳 { pages, thumb（第一頁的 JPEG Blob）}；有密碼回傳 { pw: true }；讀不了就丟錯
    const lib = await loadPdfjs()
    let doc
    try { doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise } catch (e) { if (e && e.name === "PasswordException") return { pw: true }; throw e }
    try {
      const pg = await doc.getPage(1), v1 = pg.getViewport({ scale: 1 })
      const vp = pg.getViewport({ scale: Math.min(3, PDF_THUMB_W / v1.width) })
      const c = root.document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height)
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height)
      await pg.render({ canvasContext: x, viewport: vp }).promise
      const thumb = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82))
      c.width = c.height = 0   // iPad 的 canvas 記憶體要主動放掉
      if (!thumb) throw new Error("縮圖失敗")
      return { pages: doc.numPages, thumb }
    } finally { try { await doc.destroy() } catch (e) {} }
  }
  const pdfThumbUrls = new Map()   // 內部檔名 → blob 網址（顯示用）
  async function pdfIndex() { return await getStore().get("pdfIndex") || [] }
  async function pdfThumbUrl(f) {
    if (pdfThumbUrls.has(f)) return pdfThumbUrls.get(f)
    const blob = await getStore().get("pdfthumb:" + f)
    if (!blob) return ""
    const u = root.URL.createObjectURL(blob); pdfThumbUrls.set(f, u); return u
  }
  async function pdfCardMap(dates) {   // 日期 → [{ f（內部檔名）, n（原檔名）, p（頁數）, s（縮圖網址）}]
    const idx = await pdfIndex(), map = {}
    for (const d of dates) map[d] = await Promise.all(idx.filter(x => pdfDateOf(x.f) === d).sort((a, b) => a.f < b.f ? -1 : 1).map(async x => ({ f: x.f, n: x.n, p: x.pages, s: await pdfThumbUrl(x.f) })))
    return map
  }
  function pdfHtml(d) {   // 卡片裏的 PDF 區塊（由模板的 actHtml 呼叫，見 PDF_ACT_PATCH）
    const a = (root.CARD_PDFS || {})[d]
    if (!a || !a.length) return ""
    return '<div class="pdfs">' + a.map(p => '<div class="pdfc" data-pdf="' + escH(p.f) + '" data-n="' + escH(p.n) + '" data-d="' + d + '" role="button" aria-label="PDF：' + escH(p.n) + '">' + (p.s ? '<img src="' + p.s + '" alt="" decoding="async">' : "") +
      '<div class="pdfm"><span class="pdfn">📄 ' + escH(p.n) + '</span><span class="pdfp">共 ' + (p.p || "?") + ' 頁</span>' + (p.p > 1 ? '<button type="button" class="pdfx">展開全部</button>' : "") + "</div></div>").join("") + "</div>"
  }
  function pushPdfs(map, msg) {   // 只換「那幾天」卡片裏的區塊，不重畫整個列表（和 pushPhotos 同一個做法）
    try {
      root.CARD_PDFS = root.CARD_PDFS || {}
      for (const d of Object.keys(map || {})) {
        if (map[d].length) root.CARD_PDFS[d] = map[d]; else delete root.CARD_PDFS[d]
        const el = root.document.getElementById("d" + d), act = el && el.querySelector(".act")
        if (act && typeof root.actHtml === "function") act.outerHTML = root.actHtml(d)
      }
      if (msg) say(msg, 2500)
    } catch (e) {}
  }
  async function loadCardPdfs() {   // 頁面載入後，把所有卡片的 PDF 補上去
    try {
      const idx = await pdfIndex(), dates = [...new Set(idx.map(x => pdfDateOf(x.f)).filter(Boolean))]
      if (dates.length) pushPdfs(await pdfCardMap(dates), "")
    } catch (e) { say("載入 PDF 失敗：" + (e && e.message || e)) }
  }
  // ---------- PDF 閱讀：卡片裏「展開全部」、全螢幕閱讀（雙指放大）----------
  // 編者按 / Editor's note：一律「只畫看得到（和附近）的幾頁，離開畫面就放掉」，不要改成一次畫完所有頁。iPad 的 canvas 記憶體有限（單張大約 1600 萬像素上限），十幾頁一起畫，系統會把頁面砍掉重載。
  //   Always render only the pages near the viewport and release them when they leave; never render all pages at once. iPad canvas memory is limited (about 16M pixels per canvas), and drawing a long document in one go gets the page killed and reloaded.
  // 展開和全螢幕畫的是 PDF 原檔（pdf:<檔名>），不是卡片上的縮圖；縮圖只在沒展開時顯示。
  const PDF_MAX_PX = 2600, PDF_MAX_AREA = 12e6   // 單張 canvas 的寬度上限、面積上限（像素）
  async function openPdfDoc(f) {
    const blob = await getStore().get("pdf:" + f)
    if (!blob) throw new Error("找不到這個 PDF 的原檔")
    const lib = await loadPdfjs()
    return await lib.getDocument({ data: await blob.arrayBuffer() }).promise
  }
  async function makePdfPages(doc, box, opts) {   // 在 box 裏排好每一頁的空白框；框進入畫面（上下各多算一個畫面高）才畫，離開就放掉。opts.root＝負責捲動的容器（null＝整個視窗）
    const n = doc.numPages, dpr = Math.min(2, root.devicePixelRatio || 1), pages = [], byEl = new Map(), queue = []
    let ratio = 1 / 1.414, dead = false, busy = false
    for (let i = 1; i <= n; i++) {
      if (i === 1 || n <= 80) { try { const v = (await doc.getPage(i)).getViewport({ scale: 1 }); ratio = v.width / v.height } catch (e) {} }   // 很長的文件（80 頁以上）只量第一頁，其他頁借用
      const el = root.document.createElement("div"); el.className = "pdfpg"; el.style.aspectRatio = String(ratio)
      const lb = root.document.createElement("span"); lb.className = "pdfpn"; lb.textContent = i + " / " + n; el.appendChild(lb)
      box.appendChild(el)
      const pg = { i, el, cv: null, rw: 0, task: null, want: false }; pages.push(pg); byEl.set(el, pg)
    }
    async function draw(p) {
      if (dead || !p.want) return
      const cssW = p.el.clientWidth
      if (!cssW) return
      const wantW = Math.round(cssW * dpr)
      if (p.cv && Math.abs(p.rw - wantW) < 8) return   // 已經畫好，而且大小夠用
      const pg = await doc.getPage(p.i), v1 = pg.getViewport({ scale: 1 })
      let w = Math.min(wantW, PDF_MAX_PX), h = w * v1.height / v1.width
      if (w * h > PDF_MAX_AREA) { w = Math.floor(Math.sqrt(PDF_MAX_AREA * v1.width / v1.height)); h = w * v1.height / v1.width }
      const vp = pg.getViewport({ scale: w / v1.width })
      const cv = root.document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height)
      const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height)
      const task = pg.render({ canvasContext: x, viewport: vp }); p.task = task
      try { await task.promise } catch (e) { cv.width = cv.height = 0; return } finally { if (p.task === task) p.task = null }   // 被取消（離開畫面）或失敗
      if (dead || !p.want) { cv.width = cv.height = 0; return }
      if (p.cv) { p.cv.width = p.cv.height = 0; p.cv.remove() }   // 換新的畫好了才放掉舊的，放大縮小時不會閃一下空白
      p.cv = cv; p.rw = wantW; p.el.insertBefore(cv, p.el.firstChild)
      if (opts.decorate && !p.dec) { p.dec = true; try { const r = opts.decorate(p, pg); if (r && r.catch) r.catch(() => {}) } catch (e) {} }   // 全螢幕閱讀：疊上文字層和批註層（不等它做完，免得拖慢畫頁面）
    }
    async function pump() {   // 一次只畫一頁，免得同時吃太多記憶體和運算
      if (busy) return
      busy = true
      try { while (queue.length && !dead) { const p = queue.shift(); try { await draw(p) } catch (e) {} } } finally { busy = false }
    }
    const want = p => { p.want = true; if (!queue.includes(p)) queue.push(p); pump() }
    function release(p) {
      p.want = false
      if (p.dec) { p.dec = false; if (opts.undecorate) try { opts.undecorate(p) } catch (e) {} }
      const k = queue.indexOf(p); if (k >= 0) queue.splice(k, 1)
      if (p.task) { try { p.task.cancel() } catch (e) {} }
      if (p.cv) { p.cv.width = p.cv.height = 0; p.cv.remove(); p.cv = null; p.rw = 0 }
    }
    const io = new root.IntersectionObserver(es => { for (const e of es) { const p = byEl.get(e.target); if (p) { if (e.isIntersecting) want(p); else release(p) } } }, { root: opts.root || null, rootMargin: "100% 0px 100% 0px" })
    pages.forEach(p => io.observe(p.el))
    return {
      n, pages,
      refresh() { for (const p of pages) if (p.want) want(p) },   // 寬度變了（放大縮小）：目前在畫面附近的頁，大小不夠就重畫
      destroy() { dead = true; io.disconnect(); pages.forEach(release); try { doc.destroy() } catch (e) {} }
    }
  }
  const pdfOpen = new Map()   // 內部檔名 → { box, ctl }：卡片裏已經展開的
  async function togglePdfCard(c) {   // c＝卡片裏的 .pdfc；展開／收起全部頁
    for (const [k, v] of pdfOpen) if (!v.box.isConnected) { v.ctl.destroy(); pdfOpen.delete(k) }   // 卡片被重畫掉的，順便放掉
    const f = c.dataset.pdf, btn = c.querySelector(".pdfx"), cur = pdfOpen.get(f)
    if (cur) { cur.ctl.destroy(); cur.box.remove(); pdfOpen.delete(f); c.classList.remove("open"); if (btn) btn.textContent = "展開全部"; return }
    if (btn) { btn.disabled = true; btn.textContent = "載入中…" }
    try {
      const doc = await openPdfDoc(f), box = root.document.createElement("div"); box.className = "pdfpgs"
      c.insertBefore(box, c.querySelector(".pdfm")); c.classList.add("open")
      pdfOpen.set(f, { box, ctl: await makePdfPages(doc, box, { root: null }) })
      if (btn) btn.textContent = "收起"
    } catch (e) { say("展開失敗：" + (e && e.message || e), 4000); if (btn) btn.textContent = "展開全部" } finally { if (btn) btn.disabled = false }
  }
  // ---------- PDF 批註：資料格式、繪圖、命中判斷、輸出 ----------
  // 編者按 / Editor's note：批註另存在 pdfann:<內部檔名>，PDF 原檔不動（使用者要看的是「原本的 PDF」）。要寄出去或留底時，才用「分享」或「另存含批註的新 PDF」把批註畫進去；輸出的那份是圖片頁（文字不能選取），原檔照舊還在。不要改成直接改寫原檔。
  //   English: annotations are kept in pdfann:<name>, the original file is never modified. Exporting (share / save-as-new) draws them into image pages, so the exported copy has no selectable text; the original stays as it was.
  // 資料格式：{ pages: { "頁碼": [批註…] } }；座標一律是「PDF 點（pt），左上角為原點」，和畫面縮放無關：
  //   { t:"ink", c, w, p:[[x,y]…], o?（透明度）, m?（螢光筆：乘色混合）}
  //   { t:"hl", k:"h|u|s"（螢光／底線／刪除線）, c, r:[[x,y,w,h]…] }
  //   { t:"txt", x, y, s（字級）, c, v }    { t:"sig", x, y, w, a（高寬比）, c, st:[[[x,y]…]…]（筆畫，座標 0~1）}
  const AFONT = "-apple-system,'PingFang TC','Noto Sans TC',sans-serif"
  const r1 = n => Math.round(n * 10) / 10
  function inkPath(p) {   // 點連成平滑的線（二次曲線經過各點的中點）
    if (!p.length) return ""
    const f = q => r1(q[0]) + " " + r1(q[1])
    if (p.length === 1) return "M" + f(p[0]) + "l0.01 0"
    if (p.length === 2) return "M" + f(p[0]) + "L" + f(p[1])
    let d = "M" + f(p[0])
    for (let i = 1; i < p.length - 1; i++) d += "Q" + f(p[i]) + " " + r1((p[i][0] + p[i + 1][0]) / 2) + " " + r1((p[i][1] + p[i + 1][1]) / 2)
    return d + "L" + f(p[p.length - 1])
  }
  const txtLines = a => String(a.v == null ? "" : a.v).split("\n")
  function txtBox(a) {   // 文字框大小（估算：中日韓字＝一個字級寬，其他約半個）
    let w = 0
    for (const l of txtLines(a)) { let x = 0; for (const ch of l) x += ch.charCodeAt(0) > 0x2e7f ? a.s : a.s * 0.56; w = Math.max(w, x) }
    return { x: a.x, y: a.y, w: Math.max(w, a.s * 0.6), h: txtLines(a).length * a.s * 1.25 }
  }
  function annBox(a) {
    if (a.t === "ink") {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const q of a.p) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]) }
      return { x: x0 - a.w / 2, y: y0 - a.w / 2, w: x1 - x0 + a.w, h: y1 - y0 + a.w }
    }
    if (a.t === "hl") {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const q of a.r) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0] + q[2]); y1 = Math.max(y1, q[1] + q[3]) }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    if (a.t === "txt") return txtBox(a)
    if (a.t === "sig") return { x: a.x, y: a.y, w: a.w, h: a.w * a.a }
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  const inBox = (b, x, y, t) => x >= b.x - t && x <= b.x + b.w + t && y >= b.y - t && y <= b.y + b.h + t
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
    const u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
    return Math.hypot(px - (ax + u * dx), py - (ay + u * dy))
  }
  function annHit(a, x, y, t) {   // (x, y) 是否點到這個批註；t＝容許的誤差（pt，手指不會很準）
    if (a.t === "ink") {
      if (!inBox(annBox(a), x, y, t)) return false
      const r = a.w / 2 + t
      if (a.p.length === 1) return Math.hypot(x - a.p[0][0], y - a.p[0][1]) <= r
      for (let i = 1; i < a.p.length; i++) if (segDist(x, y, a.p[i - 1][0], a.p[i - 1][1], a.p[i][0], a.p[i][1]) <= r) return true
      return false
    }
    if (a.t === "hl") return a.r.some(q => inBox({ x: q[0], y: q[1], w: q[2], h: q[3] }, x, y, t))
    return inBox(annBox(a), x, y, t)
  }
  function annMove(a, dx, dy) {
    if (a.t === "ink") for (const q of a.p) { q[0] += dx; q[1] += dy }
    else if (a.t === "hl") for (const q of a.r) { q[0] += dx; q[1] += dy }
    else { a.x += dx; a.y += dy }
  }
  // list＝這一頁的批註；W、H＝頁面大小（pt）；o：{ k（畫面每 pt 幾像素，畫選取框用）, sel（被選的批註）, flat（輸出用：不用混色）, pw/ph（輸出的像素大小）}
  function annSvg(list, W, H, o) {
    o = o || {}
    const g = [], rect = (x, y, w, h, c, extra) => '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(w) + '" height="' + r1(h) + '" fill="' + c + '"' + (extra || "") + "/>"
    for (const a of list) {
      if (a.t === "ink") g.push('<path d="' + inkPath(a.p) + '" fill="none" stroke="' + a.c + '" stroke-width="' + a.w + '" stroke-linecap="round" stroke-linejoin="round"' + (a.o ? ' opacity="' + a.o + '"' : "") + (a.m && !o.flat ? ' style="mix-blend-mode:multiply"' : "") + "/>")
      else if (a.t === "hl") for (const q of a.r) {
        if (a.k === "u") g.push(rect(q[0], q[1] + q[3] - 1.4, q[2], 1.4, a.c))
        else if (a.k === "s") g.push(rect(q[0], q[1] + q[3] / 2 - 0.7, q[2], 1.4, a.c))
        else g.push(rect(q[0], q[1], q[2], q[3], a.c, ' opacity=".4"' + (o.flat ? "" : ' style="mix-blend-mode:multiply"')))
      }
      else if (a.t === "txt") txtLines(a).forEach((l, j) => g.push('<text x="' + r1(a.x) + '" y="' + r1(a.y + a.s * (0.95 + 1.25 * j)) + '" font-size="' + r1(a.s) + '" fill="' + a.c + '" font-family="' + AFONT + '" xml:space="preserve">' + escH(l) + "</text>"))
      else if (a.t === "sig") { let d = ""; for (const st of a.st) d += inkPath(st.map(q => [a.x + q[0] * a.w, a.y + q[1] * a.w])); g.push('<path d="' + d + '" fill="none" stroke="' + a.c + '" stroke-width="' + Math.max(1, a.w * 0.012).toFixed(2) + '" stroke-linecap="round" stroke-linejoin="round"/>') }
    }
    if (o.sel >= 0 && list[o.sel]) { const b = annBox(list[o.sel]), k = o.k || 1, p = 3 / k; g.push('<rect x="' + r1(b.x - p) + '" y="' + r1(b.y - p) + '" width="' + r1(b.w + 2 * p) + '" height="' + r1(b.h + 2 * p) + '" fill="none" stroke="#2f80ff" stroke-width="' + (1.5 / k).toFixed(2) + '" stroke-dasharray="' + (5 / k).toFixed(1) + " " + (3 / k).toFixed(1) + '"/>') }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r1(W) + " " + r1(H) + '" width="' + (o.pw || "100%") + '" height="' + (o.ph || "100%") + '" preserveAspectRatio="none">' + g.join("") + "</svg>"
  }
  // 搜尋：把一頁的文字項目接成一個字串（項目之間不加字、換行補一個空格），map＝每個項目在字串裏的起訖，這樣跨項目的詞也找得到
  function pageText(c) {
    let s = "", map = []
    c.items.forEach((it, k) => { if (typeof it.str !== "string") return; const a = s.length; s += it.str; map.push({ k, a, b: s.length }); if (it.hasEOL) s += " " })
    return { s, l: s.toLowerCase(), map }
  }
  function findIn(pt, q) {
    const out = []; if (!q) return out
    let i = 0
    while ((i = pt.l.indexOf(q, i)) >= 0) { out.push([i, i + q.length]); i += q.length }
    return out
  }
  // 輸出：每頁一張 JPEG，組成最簡單的 PDF（不靠任何外部程式庫）。pages＝[{ w, h（頁面 pt）, pw, ph（圖片像素）, jpg（Uint8Array）}]
  function buildPdf(pages) {
    const enc = new root.TextEncoder(), parts = [], offs = []; let len = 0
    const push = u8 => { parts.push(u8); len += u8.length }, str = s => push(enc.encode(s)), f = n => String(Math.round(n * 100) / 100)
    const obj = (num, fn) => { offs[num] = len; str(num + " 0 obj\n"); fn(); str("endobj\n") }
    const n = pages.length
    str("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")
    obj(1, () => str("<</Type/Catalog/Pages 2 0 R>>\n"))
    obj(2, () => str("<</Type/Pages/Count " + n + "/Kids[" + pages.map((_, k) => (3 + 3 * k) + " 0 R").join(" ") + "]>>\n"))
    pages.forEach((p, k) => {
      const po = 3 + 3 * k, co = po + 1, io = po + 2, cs = "q " + f(p.w) + " 0 0 " + f(p.h) + " 0 0 cm /Im0 Do Q"
      obj(po, () => str("<</Type/Page/Parent 2 0 R/MediaBox[0 0 " + f(p.w) + " " + f(p.h) + "]/Resources<</XObject<</Im0 " + io + " 0 R>>>>/Contents " + co + " 0 R>>\n"))
      obj(co, () => str("<</Length " + cs.length + ">>\nstream\n" + cs + "\nendstream\n"))
      obj(io, () => { str("<</Type/XObject/Subtype/Image/Width " + p.pw + "/Height " + p.ph + "/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length " + p.jpg.length + ">>\nstream\n"); push(p.jpg); str("\nendstream\n") })
    })
    const xo = len, total = 3 + 3 * n
    let x = "xref\n0 " + total + "\n0000000000 65535 f \n"
    for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n"
    str(x + "trailer\n<</Size " + total + "/Root 1 0 R>>\nstartxref\n" + xo + "\n%%EOF\n")
    return new root.Blob(parts, { type: "application/pdf" })
  }
  async function flattenPdf(doc, A, prog) {   // 每一頁畫成圖（含批註）再組成 PDF
    const out = [], n = doc.numPages, d = root.document
    for (let i = 1; i <= n; i++) {
      if (prog) prog(i, n)
      const pg = await doc.getPage(i), v1 = pg.getViewport({ scale: 1 })
      let sc = Math.max(1, Math.min(2.5, 2400 / Math.max(v1.width, v1.height)))
      if (v1.width * v1.height * sc * sc > PDF_MAX_AREA) sc = Math.sqrt(PDF_MAX_AREA / (v1.width * v1.height))
      const vp = pg.getViewport({ scale: sc }), cv = d.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height)
      const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height)
      await pg.render({ canvasContext: x, viewport: vp }).promise
      const l = A.pages && A.pages[i]
      if (l && l.length) {
        const img = new root.Image(), svg = annSvg(l, v1.width, v1.height, { flat: true, pw: cv.width, ph: cv.height })
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("批註畫不出來")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) })
        x.drawImage(img, 0, 0, cv.width, cv.height)
      }
      const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.88))
      if (!blob) throw new Error("產生圖片失敗（記憶體不足？）")
      out.push({ w: v1.width, h: v1.height, pw: cv.width, ph: cv.height, jpg: new Uint8Array(await blob.arrayBuffer()) })
      cv.width = cv.height = 0
    }
    return buildPdf(out)
  }
  // ---------- 小對話框：輸入文字、簽名、分享檔案 ----------
  function huCss() { const d = root.document; if (!d.getElementById("hu-css")) { const st = d.createElement("style"); st.id = "hu-css"; st.textContent = CSS; d.head.appendChild(st) } }
  function dlgBtn(lb, kind, fn) { const x = root.document.createElement("button"); x.type = "button"; x.className = "hu-btn" + (kind ? " " + kind : ""); x.textContent = lb; x.onclick = fn; return x }
  function askText(init, title) {   // 回傳輸入的文字；取消回傳 null
    return new Promise(res => {
      huCss()
      const d = root.document, o = d.createElement("div"), b = d.createElement("div"), h = d.createElement("h3"), ta = d.createElement("textarea")
      o.className = "hu-ov"; b.className = "hu-box"; b.setAttribute("role", "dialog"); h.textContent = title || "輸入文字"; ta.className = "pdfta"; ta.rows = 3; ta.value = init || ""
      const done = v => { o.remove(); res(v) }
      b.append(h, ta, dlgBtn("完成", "pri", () => done(ta.value.replace(/\s+$/, ""))), dlgBtn("取消", "", () => done(null)))
      o.appendChild(b); d.body.appendChild(o); setTimeout(() => ta.focus(), 60)
    })
  }
  function signPad() {   // 手寫簽名板：回傳 { a（高寬比）, st（筆畫，座標 0~1）}；取消回傳 null
    return new Promise(res => {
      huCss()
      const d = root.document, o = d.createElement("div"), b = d.createElement("div"), h = d.createElement("h3"), p = d.createElement("p"), cv = d.createElement("canvas")
      o.className = "hu-ov"; b.className = "hu-box"; b.setAttribute("role", "dialog"); h.textContent = "簽名"; p.textContent = "用手指或 Apple Pencil 在下面簽名。"
      cv.className = "pdfsg"; cv.width = 720; cv.height = 320
      const x = cv.getContext("2d"); x.lineWidth = 5; x.lineCap = "round"; x.lineJoin = "round"; x.strokeStyle = "#111"
      let strokes = [], cur = null
      const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height] }
      cv.addEventListener("pointerdown", e => { if (!e.isPrimary) return; e.preventDefault(); try { cv.setPointerCapture(e.pointerId) } catch (er) {} cur = [pos(e)]; strokes.push(cur); x.beginPath(); x.moveTo(cur[0][0], cur[0][1]); x.lineTo(cur[0][0] + 0.01, cur[0][1]); x.stroke() })
      cv.addEventListener("pointermove", e => { if (!cur) return; const q = pos(e), l = cur[cur.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) < 1.5) return; cur.push(q); x.beginPath(); x.moveTo(l[0], l[1]); x.lineTo(q[0], q[1]); x.stroke() })
      const up = () => { cur = null }; cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up)
      const done = v => { o.remove(); res(v) }
      const ok = dlgBtn("完成", "pri", () => {
        if (!strokes.length) { say("還沒有簽名", 2000); return }
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
        for (const s of strokes) for (const q of s) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]) }
        const bw = Math.max(x1 - x0, 1), n4 = v => Math.round(v * 1e4) / 1e4
        done({ a: n4((y1 - y0) / bw), st: strokes.map(s => s.map(q => [n4((q[0] - x0) / bw), n4((q[1] - y0) / bw)])) })
      })
      b.append(h, p, cv, dlgBtn("清除", "", () => { strokes = []; x.clearRect(0, 0, cv.width, cv.height) }), ok, dlgBtn("取消", "", () => done(null)))
      o.appendChild(b); d.body.appendChild(o)
    })
  }
  async function sharePdf(file) {   // 有分享選單就開分享選單（可存到「檔案」、寄信）；否則下載。不帶 title／text：iOS 存到「檔案」時會多出「文字.txt」
    const nav = root.navigator
    const dl = () => { const u = root.URL.createObjectURL(file), a = root.document.createElement("a"); a.href = u; a.download = file.name; root.document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => root.URL.revokeObjectURL(u), 10000) }
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file] }); return } catch (e) {
        if (e && e.name === "AbortError") return
        if (e && e.name === "NotAllowedError") {   // 分享選單要「剛按下」才能開；時間過了（例如產生檔案花了一點時間）就再請使用者按一次
          await modal("PDF 已準備好", file.name, [{ label: "分享／儲存", kind: "pri", onclick: done => nav.share({ files: [file] }).then(() => done(1), err => { if (!(err && err.name === "AbortError")) dl(); done(0) }) }, { label: "取消", value: 0 }])
          return
        }
      }
    }
    dl()
  }
  const safeName = n => String(n || "PDF").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "PDF"

  let pdfViewing = false
  // ---------- PDF 全螢幕閱讀器：頂欄對應 iOS「快速查看」（QuickLook）的功能 ----------
  // 編者按 / Editor's note：頂欄由左到右和母版（Scriptable 的 QuickLook）一樣：「標題 ⌄」選單、分享、填寫、標記、搜尋、完成。
  //   標題選單＝放大縮小、跳到頁碼、重新命名、另存含批註的新 PDF；填寫＝文字／勾／叉／日期／簽名；標記＝畫筆／螢光筆／橡皮擦／移動，都有復原、重做。
  //   平常（沒開填寫或標記）可以長按選取文字，選了之後上方會出現「螢光／底線／刪除線／複製」。
  //   English: the top bar mirrors the QuickLook one on the master: title ⌄ menu, share, fill, markup, search, done. Text selection works in reading mode; annotations are stored apart from the original (see annSvg above).
  // 文字層和批註層都用「PDF 點」為單位排好，再整層縮放到頁面寬度（transform: scale），所以放大縮小不用重排；canvas 只管畫 PDF 本身。
  const PEN_C = ["#111111", "#1565c0", "#d32f2f", "#2e7d32"], HL_C = ["#ffeb3b", "#69f0ae", "#ff80ab", "#80d8ff"], PEN_W = [1.5, 3, 5.5]
  const ICO = p => '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>"
  const PI = {
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    share: ICO('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 10H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'),
    fill: ICO('<rect x="2" y="6" width="15" height="10" rx="2"/><path d="M6 11h.01M9.5 11h.01M13 11h.01"/><path d="M13 21l1-3.5 6.5-6.5 2.5 2.5L16.5 20z"/>'),
    mark: ICO('<circle cx="12" cy="12" r="9.5"/><path d="M8 16.5l.7-3L14.5 7.5l2 2-5.8 5.8z"/>'),
    find: ICO('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>')
  }
  async function openPdfViewer(f, name, start) {
    if (pdfViewing) return
    pdfViewing = true
    let doc
    try { doc = await openPdfDoc(f) } catch (e) { pdfViewing = false; say("打開失敗：" + (e && e.message || e), 4000); return }
    const d = root.document, s = getStore()
    let A = null
    try { A = await s.get("pdfann:" + f) } catch (e) {}
    if (!A || typeof A !== "object" || !A.pages) A = { pages: {} }
    let nameNow = name
    const ov = d.createElement("div"); ov.className = "pdfv"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "PDF：" + name)
    const ib = (a, lb, ic) => '<button type="button" class="pdfi" data-a="' + a + '" aria-label="' + lb + '">' + ic + "</button>"
    ov.innerHTML = '<div class="pdfvb"><button type="button" class="pdfvc" data-a="menu" aria-label="選單"><span class="pdfvt"></span>' + PI.chev + '</button><span class="pdfvn"></span>' +
      ib("share", "分享", PI.share) + ib("fill", "填寫", PI.fill) + ib("mark", "標記", PI.mark) + ib("find", "搜尋", PI.find) + '<button type="button" class="pdfvk" data-a="close" aria-label="完成">完成</button></div>' +
      '<div class="pdfvq" hidden><input type="search" enterkeyhint="search" placeholder="搜尋文字" aria-label="搜尋"><span class="pdfqn"></span><button type="button" class="pdfi" data-a="q-" aria-label="上一個">▲</button><button type="button" class="pdfi" data-a="q+" aria-label="下一個">▼</button><button type="button" class="pdfvk" data-a="qx">完成</button></div>' +
      '<div class="pdfsb" hidden><button type="button" data-a="h:h">螢光</button><button type="button" data-a="h:u">底線</button><button type="button" data-a="h:s">刪除線</button><button type="button" data-a="h:c">複製</button></div>' +
      '<div class="pdfmn" hidden></div><div class="pdfvs"><div class="pdfvi"></div></div><div class="pdfvm" hidden></div>' +
      '<div class="pdfvf"><button type="button" class="pdfvd">🗑 刪除這個 PDF</button></div>'
    const q1 = c => ov.querySelector(c)
    const sc = q1(".pdfvs"), inner = q1(".pdfvi"), num = q1(".pdfvn"), titleEl = q1(".pdfvt"), tr = q1(".pdfvm"), foot = q1(".pdfvf"), fb = q1(".pdfvq"), sb = q1(".pdfsb"), mn = q1(".pdfmn"), qin = fb.querySelector("input"), qn = q1(".pdfqn")
    titleEl.textContent = name
    const oldHtml = d.documentElement.style.overflow, oldBody = d.body.style.overflow
    d.body.appendChild(ov); d.documentElement.style.overflow = "hidden"; d.body.style.overflow = "hidden"   // 鎖住後面日誌的捲動
    let ctl = null, z = 1, tmr = 0, raf = 0, pin = null, armT = 0, curPage = 1
    let mode = null, tool = null, penC = 0, hlC = 0, penW = 1, selA = null   // mode：null＝閱讀、"mark"、"fill"；tool：pen／hl／er／sel／txt／chk／crs／dat／sig（null＝閱讀）；selA＝{ pi, i } 被選的批註
    let hist = [], redo = [], saveT = 0, dirty = false, g = null, lastR = null, lastT = "", selT = 0, qT = 0
    const lay = new Map(), tc = new Map(), S = { q: "", m: [], cur: -1, pts: new Map(), run: 0 }
    const list = i => A.pages[i] || (A.pages[i] = [])
    const hasAnn = () => Object.keys(A.pages).some(k => A.pages[k] && A.pages[k].length)

    // ----- 批註的儲存、復原、重做 -----
    const save = async () => { clearTimeout(saveT); saveT = 0; if (!dirty) return; dirty = false; try { if (hasAnn()) await s.set("pdfann:" + f, A); else await s.del("pdfann:" + f) } catch (e) {} }
    const touch = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 500) }
    const snap = () => { hist.push(JSON.stringify(A.pages)); if (hist.length > 60) hist.shift(); redo = [] }
    const paint = i => { const L = lay.get(i); if (L) L.sv.innerHTML = annSvg(list(i), L.W, L.H, { k: L.k, sel: selA && selA.pi === i ? selA.i : -1 }) }
    const paintAll = () => { for (const i of lay.keys()) paint(i) }
    const restore = js => { A.pages = JSON.parse(js); selA = null; paintAll(); touch(); tray() }
    const undo = () => { if (hist.length) { redo.push(JSON.stringify(A.pages)); restore(hist.pop()) } }
    const redoIt = () => { if (redo.length) { hist.push(JSON.stringify(A.pages)); restore(redo.pop()) } }
    const selItem = () => selA ? list(selA.pi)[selA.i] : null

    // ----- 文字層（可選取）和搜尋標記 -----
    const mctx = d.createElement("canvas").getContext("2d")
    const getTC = i => { if (!tc.has(i)) tc.set(i, doc.getPage(i).then(pg => pg.getTextContent())); return tc.get(i) }
    function marksFor(i) {   // 這一頁的搜尋結果 → Map(項目序號 → [[起, 訖, 是否目前這個]])
      const cm = new Map(), pt = S.pts.get(i)
      if (!S.m.length || !pt) return cm
      S.m.forEach((m, mi) => {
        if (m.p !== i) return
        for (const e of pt.map) {
          if (e.b <= m.a || e.a >= m.b) continue
          const a = Math.max(m.a, e.a) - e.a, b = Math.min(m.b, e.b) - e.a
          if (b <= a) continue
          if (!cm.has(e.k)) cm.set(e.k, [])
          cm.get(e.k).push([a, b, mi === S.cur])
        }
      })
      return cm
    }
    function markPage(i) {
      const L = lay.get(i); if (!L || !L.items.length) return
      const cm = marksFor(i)
      L.items.forEach((o, k) => {
        if (!o) return
        const m = cm.get(k)
        if (!m && !o.m) return
        o.m = !!m; const sp = o.sp; sp.textContent = ""
        if (!m) { sp.textContent = o.str; return }
        let at = 0
        for (const [a, b, cur] of m.sort((x, y) => x[0] - y[0])) {
          if (a > at) sp.appendChild(d.createTextNode(o.str.slice(at, a)))
          const mk = d.createElement("mark"); if (cur) mk.className = "cur"; mk.textContent = o.str.slice(a, b); sp.appendChild(mk); at = b
        }
        if (at < o.str.length) sp.appendChild(d.createTextNode(o.str.slice(at)))
      })
    }
    async function decorate(p, pg) {   // 這一頁畫好 canvas 之後呼叫：疊上文字層和批註層
      const lib = await loadPdfjs(), v1 = pg.getViewport({ scale: 1 }), W = v1.width, H = v1.height
      const o = d.createElement("div"); o.className = "pdfo"; o.style.width = W + "px"; o.style.height = H + "px"
      const tl = d.createElement("div"), sv = d.createElement("div"); tl.className = "pdft"; sv.className = "pdfa"; o.append(tl, sv); p.el.appendChild(o)
      const L = { p, o, tl, sv, W, H, k: 1, items: [], ro: null }
      const fit = () => { const k = p.el.clientWidth / W; if (k > 0) { L.k = k; o.style.transform = "scale(" + k + ")" } }
      fit()
      if (root.ResizeObserver) { L.ro = new root.ResizeObserver(() => { fit(); if (selA && selA.pi === p.i) paint(p.i) }); L.ro.observe(p.el) }
      lay.set(p.i, L); paint(p.i)
      let c
      try { c = await getTC(p.i) } catch (e) { return }
      if (lay.get(p.i) !== L) return   // 等的時候這頁已經被放掉了
      const st = c.styles || {}, frag = d.createDocumentFragment()
      c.items.forEach((it, k) => {
        L.items[k] = null
        if (typeof it.str !== "string" || it.str === "") return
        const tx = lib.Util.transform(v1.transform, it.transform), fh = Math.hypot(tx[2], tx[3])
        if (!(fh > 0)) return
        const sty = st[it.fontName] || {}
        let asc = fh; if (sty.ascent) asc = sty.ascent * fh; else if (sty.descent) asc = (1 + sty.descent) * fh
        const ang = Math.atan2(tx[1], tx[0]) + (sty.vertical ? Math.PI / 2 : 0)
        const left = ang ? tx[4] + asc * Math.sin(ang) : tx[4], top = ang ? tx[5] - asc * Math.cos(ang) : tx[5] - asc
        let sx = 1
        if (it.width > 0) { mctx.font = fh + "px " + (sty.fontFamily || "sans-serif"); const mw = mctx.measureText(it.str).width; if (mw > 0) sx = Math.max(0.2, Math.min(5, it.width / mw)) }
        const sp = d.createElement("span"); sp.textContent = it.str
        sp.style.cssText = "left:" + left.toFixed(2) + "px;top:" + top.toFixed(2) + "px;font-size:" + fh.toFixed(2) + "px;font-family:" + (sty.fontFamily || "sans-serif") + ";transform:" + (ang ? "rotate(" + ang.toFixed(4) + "rad) " : "") + "scaleX(" + sx.toFixed(4) + ")"
        frag.appendChild(sp); L.items[k] = { sp, str: it.str }
      })
      tl.appendChild(frag); markPage(p.i)
    }
    const undecorate = p => { const L = lay.get(p.i); if (!L) return; lay.delete(p.i); if (L.ro) L.ro.disconnect(); L.o.remove() }

    // ----- 選取文字 → 螢光／底線／刪除線／複製 -----
    function rectsOf(rg) {   // 選取範圍 → { 頁碼: [[x,y,w,h]…] }（PDF 點）
      const out = {}
      for (const [i, L] of lay) {
        if (!rg.intersectsNode(L.tl)) continue
        const pr = L.p.el.getBoundingClientRect(); if (!pr.width || !pr.height) continue
        const rs = []
        for (const o of L.items) {
          if (!o || !rg.intersectsNode(o.sp)) continue
          const sub = d.createRange(); sub.selectNodeContents(o.sp)
          if (rg.compareBoundaryPoints(root.Range.START_TO_START, sub) > 0) sub.setStart(rg.startContainer, rg.startOffset)
          if (rg.compareBoundaryPoints(root.Range.END_TO_END, sub) < 0) sub.setEnd(rg.endContainer, rg.endOffset)
          const r = sub.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue
          rs.push([(r.left - pr.left) / pr.width * L.W, (r.top - pr.top) / pr.height * L.H, r.width / pr.width * L.W, r.height / pr.height * L.H])
        }
        if (rs.length) out[i] = rs
      }
      return out
    }
    const onSel = () => {
      if (tool) return
      const sel = d.getSelection && d.getSelection(), n = sel && sel.anchorNode, el = n && (n.nodeType === 1 ? n : n.parentElement)
      if (sel && !sel.isCollapsed && sel.rangeCount && el && el.closest && el.closest(".pdft")) { clearTimeout(selT); lastR = sel.getRangeAt(0).cloneRange(); lastT = sel.toString(); sb.hidden = false }
      else { clearTimeout(selT); selT = setTimeout(() => { lastR = null; sb.hidden = true }, 400) }   // 按「螢光」那一下選取可能先被清掉，所以多留一會兒
    }
    d.addEventListener("selectionchange", onSel)
    async function selAct(k) {
      if (!lastR) return
      if (k === "c") { try { await root.navigator.clipboard.writeText(lastT); say("已複製", 1500) } catch (e) { say("複製失敗：請用長按選取後的「拷貝」", 3000) } return }
      const rs = rectsOf(lastR), pis = Object.keys(rs)
      if (!pis.length) { say("沒有選到文字", 2000); return }
      snap()
      for (const i of pis) list(+i).push({ t: "hl", k, c: k === "h" ? HL_C[hlC] : PEN_C[penC === 0 ? 2 : penC], r: rs[i].map(q => q.map(r1)) })
      paintAll(); touch(); lastR = null; sb.hidden = true
      try { d.getSelection().removeAllRanges() } catch (e) {}
      tray()
    }

    // ----- 頁面與手勢 -----
    const pageAt = e => { const el = e.target && e.target.closest && e.target.closest(".pdfpg"); if (!el) return null; for (const L of lay.values()) if (L.p.el === el) return L; return null }
    const ptOf = (L, e) => { const r = L.p.el.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * L.W, (e.clientY - r.top) / r.height * L.H] }
    const hitIdx = (L, x, y, t) => { const l = list(L.p.i); for (let k = l.length - 1; k >= 0; k--) if (annHit(l[k], x, y, t)) return k; return -1 }
    function add(pi, a) { snap(); const l = list(pi); l.push(a); selA = { pi, i: l.length - 1 }; tool = "sel"; paintAll(); touch(); tray() }
    async function place(L, x, y) {
      const pi = L.p.i, base = L.W / 595, c = PEN_C[penC]
      if (tool === "txt" || tool === "sig") await new Promise(r => setTimeout(r, 300))   // 手指剛放開的那一下還會補一個 click：晚一點才彈出對話框，免得誤按到裏面的按鈕
      if (tool === "txt") { const v = await askText(""); if (v) add(pi, { t: "txt", x: r1(x), y: r1(y - 8 * base), s: r1(13 * base), c, v }) }
      else if (tool === "chk" || tool === "crs") { const sz = 18 * base; add(pi, { t: "txt", x: r1(x - sz * 0.4), y: r1(y - sz * 0.6), s: r1(sz), c, v: tool === "chk" ? "✓" : "✗" }) }
      else if (tool === "dat") add(pi, { t: "txt", x: r1(x), y: r1(y - 8 * base), s: r1(13 * base), c, v: new Date().toLocaleDateString("en-GB") })
      else if (tool === "sig") {
        let sg = null; try { sg = await s.get("pdfsig") } catch (e) {}
        if (sg && sg.st) { const v = await modal("簽名", "", [{ label: "使用已存的簽名", kind: "pri", value: "use" }, { label: "重新簽名", value: "new" }, { label: "取消", value: null }]); if (!v) return; if (v === "new") sg = null }
        if (!sg || !sg.st) { sg = await signPad(); if (!sg) return; try { await s.set("pdfsig", sg) } catch (e) {} }
        const w = L.W * 0.3; add(pi, { t: "sig", x: r1(x - w / 2), y: r1(y - w * sg.a / 2), w: r1(w), a: sg.a, c: "#111111", st: sg.st })
      }
    }
    function eraseAt(L, x, y) { const l = list(L.p.i), k = hitIdx(L, x, y, 10 / L.k); if (k >= 0) { if (!g.snapped) { snap(); g.snapped = true } l.splice(k, 1); selA = null; g.n++; paint(L.p.i) } }
    const endG = () => { if (!g) return; if (g.k === "pl") g = null; else pUp(null) }   // 第二根手指放下：目前這一筆就此結束（放置類的手勢直接取消）
    sc.addEventListener("pointerdown", e => {
      if (!tool) return
      if (!e.isPrimary) { endG(); return }   // 第二根手指：交給雙指縮放／平移，不畫
      if (e.pointerType === "mouse" && e.button !== 0) return
      const L = pageAt(e); if (!L) return
      const [x, y] = ptOf(L, e), base = L.W / 595, pi = L.p.i
      if (tool === "pen" || tool === "hl") {
        snap()
        const a = tool === "pen" ? { t: "ink", c: PEN_C[penC], w: r1(PEN_W[penW] * base), p: [[x, y]] } : { t: "ink", c: HL_C[hlC], w: r1(14 * base), p: [[x, y]], o: 0.4, m: 1 }
        list(pi).push(a); selA = null; g = { k: "ink", L, a, raf: 0 }; paint(pi)
      } else if (tool === "er") { g = { k: "er", L, n: 0, snapped: false }; eraseAt(L, x, y) }
      else if (tool === "sel") {
        const i = hitIdx(L, x, y, 14 / L.k)
        if (i < 0) { selA = null; paintAll(); tray(); return }
        const was = !!selA && selA.pi === pi && selA.i === i
        selA = { pi, i }; g = { k: "mv", L, x, y, moved: false, was, a: list(pi)[i] }; paintAll(); tray()
      } else g = { k: "pl", L, x, y, cx: e.clientX, cy: e.clientY }   // 放置類：手指放開時才放（中途拖動或加了第二根手指就取消）
    })
    sc.addEventListener("pointermove", e => {
      if (!g || !g.L || !e.isPrimary) return
      if (g.k === "pl") { if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > 10) g = null; return }
      const [x, y] = ptOf(g.L, e)
      if (g.k === "ink") {
        const l = g.a.p[g.a.p.length - 1]
        if (Math.hypot(x - l[0], y - l[1]) < 0.4) return
        g.a.p.push([x, y]); const h = g; if (!h.raf) h.raf = root.requestAnimationFrame(() => { h.raf = 0; paint(h.L.p.i) })   // 放開手指後 g 會變 null，所以先留一份
      } else if (g.k === "er") eraseAt(g.L, x, y)
      else if (g.k === "mv") {
        if (!g.moved) { if (Math.hypot(x - g.x, y - g.y) < 3 / g.L.k) return; snap(); g.moved = true }
        annMove(g.a, x - g.x, y - g.y); g.x = x; g.y = y; paint(g.L.p.i)
      }
    })
    const pUp = async e => {
      if (!g || (e && !e.isPrimary)) return
      const h = g; g = null
      if (h.k === "ink") { h.a.p = h.a.p.map(q => [r1(q[0]), r1(q[1])]); paint(h.L.p.i); touch(); tray() }
      else if (h.k === "er") { if (h.n) touch(); tray() }
      else if (h.k === "pl") place(h.L, h.x, h.y)
      else if (h.k === "mv") {
        if (h.moved) touch()
        else if (h.was && h.a.t === "txt") { await new Promise(r => setTimeout(r, 300)); const v = await askText(h.a.v, "修改文字"); if (v != null && v !== "") { snap(); h.a.v = v; paintAll(); touch() } }
      }
    }
    sc.addEventListener("pointerup", pUp); sc.addEventListener("pointercancel", pUp)

    // ----- 工具列（標記、填寫）-----
    function tray() {
      ov.classList.toggle("dr", !!tool)
      ov.querySelectorAll('.pdfvb [data-a="fill"],.pdfvb [data-a="mark"]').forEach(b => b.classList.toggle("on", b.dataset.a === mode))
      tr.hidden = !mode; foot.hidden = !!mode
      if (!mode) return
      const T = (id, ic, lb) => '<button type="button" class="pdfmt' + (tool === id ? " on" : "") + '" data-a="t:' + id + '"><b>' + ic + "</b><i>" + lb + "</i></button>"
      let h = mode === "mark" ? T("pen", "✏️", "畫筆") + T("hl", "🖍", "螢光筆") + T("er", "⌫", "橡皮擦") + T("sel", "↖", "移動") : T("txt", "Aa", "文字") + T("chk", "✓", "勾") + T("crs", "✗", "叉") + T("dat", "📅", "日期") + T("sig", "✍", "簽名") + T("sel", "↖", "移動")
      const pal = tool === "hl" ? HL_C : PEN_C, ci = tool === "hl" ? hlC : penC
      if (tool === "pen" || tool === "hl" || tool === "txt" || tool === "chk" || tool === "crs" || tool === "dat" || (selA && selItem() && selItem().t !== "sig")) h += '<span class="pdfcs">' + pal.map((c, k) => '<button type="button" class="pdfcd' + (k === ci ? " on" : "") + '" style="background:' + c + '" data-a="c:' + k + '" aria-label="顏色"></button>').join("") + "</span>"
      if (tool === "pen") h += '<button type="button" class="pdfmt" data-a="w"><b>' + ["細", "中", "粗"][penW] + "</b><i>粗細</i></button>"
      const it = selItem()
      if (it && (it.t === "txt" || it.t === "sig")) h += '<button type="button" class="pdfmt" data-a="s-"><b>－</b><i>縮小</i></button><button type="button" class="pdfmt" data-a="s+"><b>＋</b><i>放大</i></button>'
      if (it) h += '<button type="button" class="pdfmt" data-a="del"><b>🗑</b><i>刪除</i></button>'
      h += '<button type="button" class="pdfmt" data-a="u"' + (hist.length ? "" : " disabled") + "><b>↶</b><i>復原</i></button>" + '<button type="button" class="pdfmt" data-a="r"' + (redo.length ? "" : " disabled") + "><b>↷</b><i>重做</i></button>" + '<button type="button" class="pdfmt pri" data-a="mode"><b>完成</b></button>'
      tr.innerHTML = h
    }
    function setMode(m) {
      mode = m; tool = m === "mark" ? "pen" : null; selA = null
      if (tool) { try { d.getSelection().removeAllRanges() } catch (e) {} sb.hidden = true; lastR = null }
      mn.hidden = true; if (m && !fb.hidden) toggleFind()
      paintAll(); tray()
      if (m === "fill") say("選一個工具，再點一下頁面要放的位置", 3000)
    }
    function toolPick(v) {
      selA = null; tool = v; paintAll(); tray()
      if (["txt", "chk", "crs", "dat", "sig"].includes(v)) say("點一下頁面要放的位置", 2500)
      else if (v === "sel") say("點批註選取，拖曳移動；兩指捲動或縮放", 3000)
    }

    // ----- 搜尋 -----
    function toggleFind() {
      fb.hidden = !fb.hidden; mn.hidden = true
      ov.querySelector('.pdfvb [data-a="find"]').classList.toggle("on", !fb.hidden)
      if (!fb.hidden) { if (mode) setMode(null); setTimeout(() => qin.focus(), 50) }
      else { qin.blur(); S.run++; S.q = ""; S.m = []; S.cur = -1; qn.textContent = ""; qin.value = ""; for (const i of lay.keys()) markPage(i) }
    }
    async function runSearch(raw) {
      const my = ++S.run; S.q = raw.toLowerCase().trim(); S.m = []; S.cur = -1
      for (const i of lay.keys()) markPage(i)
      if (!S.q) { qn.textContent = ""; return }
      qn.textContent = "搜尋中…"
      for (let i = 1; i <= doc.numPages; i++) {
        let pt = S.pts.get(i)
        if (!pt) { try { pt = pageText(await getTC(i)) } catch (e) { continue } S.pts.set(i, pt) }
        if (my !== S.run) return
        for (const [a, b] of findIn(pt, S.q)) S.m.push({ p: i, a, b })
      }
      if (my !== S.run) return
      if (!S.m.length) { qn.textContent = "找不到"; return }
      let k = S.m.findIndex(m => m.p >= curPage); if (k < 0) k = 0
      goMatch(k)
    }
    function goMatch(mi) {
      S.cur = mi; qn.textContent = (mi + 1) + " / " + S.m.length
      for (const i of lay.keys()) markPage(i)
      const m = S.m[mi], p = ctl.pages[m.p - 1]
      const place2 = () => {
        const L = lay.get(m.p), mk = L && L.tl.querySelector("mark.cur")
        if (!mk) return false
        const r = mk.getBoundingClientRect(), b = sc.getBoundingClientRect()
        sc.scrollTop += r.top - b.top - sc.clientHeight / 3; sc.scrollLeft += r.left - b.left - sc.clientWidth / 2
        return true
      }
      if (place2()) return
      sc.scrollTop = p.el.offsetTop - 8   // 先捲到那一頁，等文字層出現再對準
      let n = 0; const tick = () => { if (S.cur !== mi || place2() || ++n > 60) return; setTimeout(tick, 50) }; tick()
    }
    const step = dir => { if (S.m.length) goMatch((S.cur + dir + S.m.length) % S.m.length) }
    qin.addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(() => runSearch(qin.value), 350) })
    qin.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if (S.m.length && S.q === qin.value.toLowerCase().trim()) step(e.shiftKey ? -1 : 1); else { clearTimeout(qT); runSearch(qin.value) } } })

    // ----- 標題選單、分享、另存 -----
    const setZ = (nz, cx, cy) => {   // 縮放：改內層寬度，並讓 (cx, cy) 那一點留在原處；放開後（或停下來 0.2 秒）才重畫清楚
      nz = Math.max(1, Math.min(5, nz)); if (Math.abs(nz - z) < 0.001) return
      const fx = (sc.scrollLeft + cx) / sc.scrollWidth, fy = (sc.scrollTop + cy) / sc.scrollHeight
      z = nz; inner.style.width = (z * 100) + "%"
      sc.scrollLeft = fx * sc.scrollWidth - cx; sc.scrollTop = fy * sc.scrollHeight - cy
      clearTimeout(tmr); tmr = setTimeout(() => ctl.refresh(), 200)
    }
    function toggleMenu() {
      if (!mn.hidden) { mn.hidden = true; return }
      mn.innerHTML = '<div class="pdfmz"><button type="button" data-a="z-" aria-label="縮小">－</button><span>' + Math.round(z * 100) + '%</span><button type="button" data-a="z+" aria-label="放大">＋</button></div>' +
        '<button type="button" data-a="goto">跳到頁碼…</button><button type="button" data-a="rename">重新命名…</button>' + (hasAnn() ? '<button type="button" data-a="saveas">另存含批註的新 PDF</button>' : "")
      mn.hidden = false
    }
    async function renameIt() {
      mn.hidden = true
      const v = root.prompt("重新命名（只改顯示的名稱）", nameNow); if (v == null) return
      const nn = safeName(v.replace(/\.pdf$/i, "")); if (!nn || nn === nameNow) return
      try {
        const idx = await pdfIndex(); await s.set("pdfIndex", idx.map(x => x.f === f ? Object.assign({}, x, { n: nn }) : x))
        nameNow = nn; titleEl.textContent = nn; pushPdfs(await pdfCardMap([pdfDateOf(f)]), "已重新命名")
      } catch (e) { say("重新命名失敗：" + (e && e.message || e), 4000) }
    }
    async function exportAnn() {   // 回傳含批註的 PDF（File）；失敗回傳 null
      await save()
      try { return new root.File([await flattenPdf(doc, A, (i, n) => say("產生含批註的 PDF… " + i + " / " + n, 5000))], safeName(nameNow) + "（批註）.pdf", { type: "application/pdf" }) } catch (e) { say("產生失敗：" + (e && e.message || e), 5000); return null }
    }
    async function shareFlow() {
      mn.hidden = true
      let ann = false
      if (hasAnn()) { const v = await modal("分享", "這份 PDF 有批註。", [{ label: "分享含批註的版本（轉成圖片頁）", kind: "pri", value: "ann" }, { label: "分享原檔（不含批註）", value: "orig" }, { label: "取消", value: null }]); if (!v) return; ann = v === "ann" }
      let file
      if (ann) { file = await exportAnn(); if (!file) return }
      else { const b = await s.get("pdf:" + f); if (!b) { say("找不到原檔", 3000); return } file = new root.File([b], safeName(nameNow) + ".pdf", { type: "application/pdf" }) }
      await sharePdf(file)
    }
    async function saveAs() {
      mn.hidden = true
      const file = await exportAnn(); if (!file) return
      await addPdfFiles(pdfDateOf(f), [file])   // 加到同一天的卡片，成為一份新的 PDF（原檔和批註都留著）；它是普通 PDF，會跟著 PDF 備份走
    }

    // ----- 關閉、動作分派 -----
    const close = () => { save(); clearTimeout(tmr); clearTimeout(armT); clearTimeout(saveT); clearTimeout(selT); clearTimeout(qT); d.removeEventListener("selectionchange", onSel); if (ctl) ctl.destroy(); else try { doc.destroy() } catch (e) {}; ov.remove(); d.documentElement.style.overflow = oldHtml; d.body.style.overflow = oldBody; d.removeEventListener("keydown", onKey, true); pdfViewing = false }
    const onKey = e => { if (e.key === "Escape") { if (!mn.hidden) mn.hidden = true; else if (!fb.hidden) toggleFind(); else close() } }
    d.addEventListener("keydown", onKey, true)
    const act = code => {
      const k = code.indexOf(":"), c = k < 0 ? code : code.slice(0, k), v = k < 0 ? "" : code.slice(k + 1)
      if (c !== "menu" && c !== "z-" && c !== "z+" && !mn.hidden) mn.hidden = true
      switch (c) {
        case "close": close(); break
        case "menu": toggleMenu(); break
        case "share": shareFlow(); break
        case "fill": case "mark": setMode(mode === c ? null : c); break
        case "find": toggleFind(); break
        case "qx": toggleFind(); break
        case "q-": step(-1); break
        case "q+": step(1); break
        case "h": selAct(v); break
        case "t": toolPick(v); break
        case "c": { const i = +v; if (tool === "hl") hlC = i; else penC = i; const it = selItem(); if (it && it.t !== "sig") { snap(); it.c = (tool === "hl" || it.m ? HL_C : PEN_C)[i]; paintAll(); touch() } tray(); break }
        case "w": penW = (penW + 1) % PEN_W.length; tray(); break
        case "u": undo(); break
        case "r": redoIt(); break
        case "s-": case "s+": { const it = selItem(); if (!it) break; snap(); const m = c === "s+" ? 1.15 : 1 / 1.15; if (it.t === "txt") it.s = r1(Math.max(5, Math.min(200, it.s * m))); else if (it.t === "sig") { const b = annBox(it), nw = Math.max(20, Math.min(2000, it.w * m)); it.x = r1(it.x + (it.w - nw) / 2); it.y = r1(it.y + (b.h - nw * it.a) / 2); it.w = r1(nw) } paintAll(); touch(); break }
        case "del": { if (!selA) break; snap(); list(selA.pi).splice(selA.i, 1); selA = null; paintAll(); touch(); tray(); break }
        case "mode": setMode(null); break
        case "z-": setZ(z - 0.5, sc.clientWidth / 2, sc.clientHeight / 2); mn.querySelector("span").textContent = Math.round(z * 100) + "%"; break
        case "z+": setZ(z + 0.5, sc.clientWidth / 2, sc.clientHeight / 2); mn.querySelector("span").textContent = Math.round(z * 100) + "%"; break
        case "goto": { mn.hidden = true; const v2 = root.prompt("跳到第幾頁（1–" + ctl.n + "）", String(curPage)); const n = parseInt(v2, 10); if (n >= 1 && n <= ctl.n) sc.scrollTop = ctl.pages[n - 1].el.offsetTop - 8; break }
        case "rename": renameIt(); break
        case "saveas": saveAs(); break
      }
    }
    ov.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-a]"); if (b && ov.contains(b) && !b.disabled) act(b.dataset.a) })
    sb.addEventListener("mousedown", e => e.preventDefault())   // 按「螢光」不要讓選取消失
    const delB = ov.querySelector(".pdfvd")   // 刪除：要按兩次（第一次變紅，3.5 秒內再按一次才刪）
    delB.onclick = async () => {
      if (!delB.classList.contains("arm")) { delB.classList.add("arm"); delB.textContent = "再按一次，確定刪除"; armT = setTimeout(() => { delB.classList.remove("arm"); delB.textContent = "🗑 刪除這個 PDF" }, 3500); return }
      delB.disabled = true; dirty = false; close(); await doDelPdf(f)
    }
    try { ctl = await makePdfPages(doc, inner, { root: sc, decorate, undecorate }) } catch (e) { close(); say("打開失敗：" + (e && e.message || e), 4000); return }
    const target = ctl.pages[Math.max(1, Math.min(ctl.n, start || 1)) - 1]
    if (target) sc.scrollTop = target.el.offsetTop - 8
    const setNum = () => {   // 頁碼：畫面上半部看到的那一頁
      raf = 0
      const y = sc.scrollTop + sc.clientHeight / 2; let cur = 1
      for (const p of ctl.pages) { if (p.el.offsetTop <= y) cur = p.i; else break }
      curPage = cur; num.textContent = cur + " / " + ctl.n
    }
    setNum()
    sc.addEventListener("scroll", () => { if (!raf) raf = root.requestAnimationFrame(setNum) }, { passive: true })
    const mid = t => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2]
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    sc.addEventListener("touchstart", e => { if (e.touches.length === 2) { endG(); pin = { d: dist(e.touches), z, m: mid(e.touches) } } else pin = null }, { passive: true })
    sc.addEventListener("touchmove", e => {   // 雙指：縮放，同時跟著手指平移（畫筆、移動模式下，單指不捲動，靠雙指捲動）
      if (!pin || e.touches.length !== 2) return
      e.preventDefault()
      const r = sc.getBoundingClientRect(), m = mid(e.touches)
      sc.scrollLeft += pin.m[0] - m[0]; sc.scrollTop += pin.m[1] - m[1]; pin.m = m
      setZ(pin.z * dist(e.touches) / pin.d, m[0] - r.left, m[1] - r.top)
    }, { passive: false })
    sc.addEventListener("touchend", e => { if (e.touches.length < 2) pin = null }, { passive: true })
    tray()
  }
  let pdfClickFn = null
  function installPdf() {   // 點卡片裏的 PDF：「展開全部」按鈕＝展開／收起；點頁面或標題列＝全螢幕閱讀
    const d = root.document
    if (!d || !d.addEventListener) return
    if (pdfClickFn) d.removeEventListener("click", pdfClickFn, true)   // 組頁（document.write）會清掉舊的監聽，所以每次都「先拿掉舊的、再加新的」
    pdfClickFn = e => {
      const t = e.target, c = t && t.closest && t.closest(".pdfc")
      if (!c) return
      e.preventDefault(); e.stopPropagation()
      if (t.closest(".pdfx")) { togglePdfCard(c); return }
      const pg = t.closest(".pdfpg")
      openPdfViewer(c.dataset.pdf, c.dataset.n || "PDF", pg ? [...pg.parentNode.children].indexOf(pg) + 1 : 1)
    }
    d.addEventListener("click", pdfClickFn, true)
  }
  let prePickP = null   // 按下「加入 PDF」當下已經打開的選檔視窗（和照片的 prePick 同一個做法）
  function prePickPdf() {
    if (prePickP) prePickP.cancel()
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "application/pdf,.pdf"; inp.multiple = true; inp.hidden = true
    let finish
    const promise = new Promise(res => { finish = res })
    prePickP = { promise, at: Date.now(), cancel: () => { inp.remove(); finish(null) } }
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); finish(fs) }
    inp.addEventListener("cancel", () => { inp.remove(); finish(null) })
    d.body.appendChild(inp); inp.click()
  }
  function pickPdfs(done) {
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "application/pdf,.pdf"; inp.multiple = true; inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  async function askBigPdfs(files) {   // 超過 PDF_WARN 的檔案，逐個問「仍要加入／略過」；回傳要加入的
    const keep = []
    for (const f of files) {
      if (f.size <= PDF_WARN) { keep.push(f); continue }
      const go = await modal("這個 PDF 很大", "「" + f.name + "」有 " + fmtMB(f.size) + "，存在這部裝置會佔不少空間。要加入嗎？", [{ label: "仍要加入", kind: "pri", value: true }, { label: "略過這個", value: false }])
      if (go) keep.push(f)
    }
    return keep
  }
  async function doAddPdf(date) {
    if (!DATERE.test(date || "")) { say("加入 PDF 失敗：日期不對"); return }
    const pre = prePickP; prePickP = null
    if (pre && Date.now() - pre.at < 10000) {   // 按下按鈕時選檔視窗已經打開了：選完再處理；這裏不等，沒選檔案也不會卡住後面的動作
      pre.promise.then(async fs => {
        if (!fs || !fs.length) return
        const keep = await askBigPdfs(fs)   // 問大小的對話框不放進訊息佇列：對話框開著的時候，頁面的同步、備份照常進行
        if (keep.length) queue = queue.then(() => addPdfFiles(date, keep)).catch(e => say("出錯了：" + (e && e.message || e)))
      }).catch(e => say("出錯了：" + (e && e.message || e)))
      return
    }
    if (pre) pre.cancel()
    const pick = await modal("加入 PDF 到 " + date, "選取一個或好幾個 PDF，原檔會存在這部裝置。", [{ label: "PDF…", kind: "pri", onclick: pickPdfs }, { label: "取消", value: null }])
    if (!pick) return
    const keep = await askBigPdfs(pick.files)
    if (keep.length) await addPdfFiles(date, keep)
  }
  async function addPdfFiles(date, files) {
    try { await loadPdfjs() } catch (e) { say("PDF 閱讀工具載入失敗：請確認 pdf.min.mjs 和 pdf.worker.min.mjs 已放進網頁資料夾", 6000); return }
    const s = getStore(); let idx = await pdfIndex(), ok = 0, bad = 0, i = 0; const pw = []
    say("處理 " + files.length + " 個 PDF…")
    for (const f of files) {
      try {
        const r = await readPdf(f)
        if (r.pw) { pw.push(f.name); continue }
        let name = date + "_" + Date.now() + "_" + (i++) + ".pdf"
        while (idx.some(x => x.f === name)) name = date + "_" + Date.now() + "_" + (i++) + ".pdf"
        await s.set("pdf:" + name, f.slice(0, f.size, "application/pdf"))
        await s.set("pdfthumb:" + name, r.thumb)
        idx = [...idx, { f: name, n: (f.name || "PDF").replace(/\.pdf$/i, ""), pages: r.pages, size: f.size, created: Date.now() }]
        await s.set("pdfIndex", idx); ok++
      } catch (e) { bad++ }
    }
    let msg = ok ? "已加入 " + ok + " 個 PDF" : ""
    if (pw.length) msg += (msg ? "；" : "") + "「" + pw[0] + "」" + (pw.length > 1 ? "等 " + pw.length + " 個" : "") + "有密碼保護，目前不能加入"
    if (bad) msg += (msg ? "；" : "") + bad + " 個讀不了（可能不是 PDF，或檔案損壞）"
    if (ok && !root.document.getElementById("d" + date)) msg += "。這一天還沒有日誌文字：PDF 已存起來，等你寫了文字，才會在卡片裏出現"
    pushPdfs(await pdfCardMap([date]), msg || "沒有加入任何 PDF")
  }

  // ---------- 照片備份與還原：備份檔（.json）不含照片，所以照片另外存成一張張 .jpg（檔名不變），還原時依檔名放回原來的卡片 ----------
  const PHOTO_BATCH = 40   // 一次分享的張數上限（太多張時分享選單可能開不起來，所以分批）
  // 備份出來的照片檔名：「日期_毫秒數_序號.jpg」的 13 位毫秒數轉成 8 位 36 進位（例：2026-11-05_mhjk3f2x_6.jpg），檔案App才顯示得完整；還原時換回原名，所以和已有的照片比對不會重複
  const PH_LONG = /^(\d{4}(?:-\d{2}-\d{2})?)_(\d{13})_(\d+)\.jpg$/, PH_SHORT = /^(\d{4}(?:-\d{2}-\d{2})?)_([0-9a-z]{8})_(\d+)\.jpg$/
  const photoExportName = f => { const m = PH_LONG.exec(f); return m ? m[1] + "_" + Number(m[2]).toString(36).padStart(8, "0") + "_" + m[3] + ".jpg" : f }
  const photoInternalName = nm => { const m = PH_SHORT.exec(nm); if (!m) return nm; const ms = parseInt(m[2], 36); return String(ms).length === 13 && ms.toString(36).padStart(8, "0") === m[2] ? m[1] + "_" + ms + "_" + m[3] + ".jpg" : nm }
  const yearPhotoNames = (idx, year) => idx.filter(x => okName(x.f) && x.f.slice(0, 4) === String(year)).map(x => x.f).sort()
  // 已經備份過的照片記錄：{ 內部檔名: 備份時間 }，存在這部裝置的 IndexedDB（photobk:done）。只記「分享成功」的；從備份資料夾還原回來的照片也算已備份。
  // 記錄清掉了（或換了備份資料夾）也沒關係：下次會當成都沒備份過，或在提示裏選「全部重新備份」。
  const PHOTO_DONE_KEY = "photobk:done"
  async function readPhotoDone() { const v = await getStore().get(PHOTO_DONE_KEY); return v && typeof v === "object" && !Array.isArray(v) ? v : {} }
  async function markPhotoDone(names) {
    if (!names.length) return
    const cur = await readPhotoDone(), now = Date.now()
    for (const n of names) cur[n] = now
    await getStore().set(PHOTO_DONE_KEY, cur)
  }
  async function photoFilesOf(year, only) {   // only＝只要這些內部檔名（Set）；不給＝全部
    const s = getStore(), out = []
    for (const f of yearPhotoNames(await photoIndex(), year)) {
      if (only && !only.has(f)) continue
      const blob = await s.get("photo:" + f)
      if (blob) out.push(new root.File([blob], photoExportName(f), { type: "image/jpeg" }))
    }
    return out
  }
  function downloadBlob(name, blob) {
    const d = root.document, a = d.createElement("a"), u = root.URL.createObjectURL(blob)
    a.href = u; a.download = name; d.body.appendChild(a); a.click(); a.remove(); setTimeout(() => root.URL.revokeObjectURL(u), 10000)
  }
  // 編者按 / Editor's note：「存到哪個資料夾」的說明只在第一次出現（文字備份用 hint:backup、照片備份用 hint:photobk），之後的對話框只留最簡單的一句；不要把每一批都附上資料夾說明（使用者嫌煩，要求只提第一次）。
  //   網頁版沒辦法記住資料夾，只有 iOS 自己會記住上次存的位置；那一步程式碰不到。
  //   English: the "which folder to save to" text appears only the first time (hint:backup for text, hint:photobk for photos); later dialogs keep just one short line. Do not re-add the folder text to every batch (the user asked for first-time-only). A web page cannot remember a folder; only iOS remembers the last location.
  //   更新：「看過說明」的條件改成——這部裝置只要已經有任何照片備份記錄（photobk:done 裡有東西），就直接當成看過，不必等用新版成功存完一批照片；舊的 hint:photobk 標記仍然算看過。
  //   English update: "seen the instructions" is now true as soon as this device has any photo-backup record (photobk:done is non-empty); the old hint:photobk flag still counts.
  const photoFolderEg = () => isIOS() ? "，例如，iCloud Drive › Scriptable › pwa_photos" : ""   // 範例路徑只給 iPhone／iPad 看（見 isIOS），其他裝置不顯示
  async function photoHintSeen() { if (await getStore().get("hint:photobk")) return true; return Object.keys(await readPhotoDone()).length > 0 }
  async function backupPhotos(year, files) {   // 一批一批存；每一批都要使用者按一下（分享選單只能在按下的當下打開）。回傳實際存出幾張
    const nav = root.navigator, batches = []
    let seen = await photoHintSeen()
    const markSeen = async () => { if (!seen) { seen = true; try { await getStore().set("hint:photobk", 1) } catch (e) {} } }
    for (let i = 0; i < files.length; i += PHOTO_BATCH) batches.push(files.slice(i, i + PHOTO_BATCH))
    let saved = 0
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i], title = "備份 " + year + " 年照片" + (batches.length > 1 ? "（第 " + (i + 1) + "／" + batches.length + " 批）" : "")
      let note = ""
      for (;;) {
        const buttons = []
        if (nav && nav.share) buttons.push({ label: "儲存照片", kind: "pri", onclick: done => nav.share({ files: batch }).then(() => done("shared"), err => done(err && err.name === "AbortError" ? "again" : "failed")) })
        buttons.push({ label: "改用下載", value: "download" }, { label: "停止", value: "stop" })
        const r = await modal(title, "這一批 " + batch.length + " 張。" + (seen ? "按「儲存照片」。" : "按「儲存照片」後，選擇儲存成檔案，再選你指定的資料夾" + photoFolderEg() + (batches.length > 1 ? "（每一批都選同一個）" : "") + "。") + note, buttons)
        if (r === "shared") { saved += batch.length; await markPhotoDone(batch.map(f => photoInternalName(f.name))); await markSeen(); break }
        if (r === "download") { for (const f of batch) { downloadBlob(f.name, f); await new Promise(res => setTimeout(res, 300)) } saved += batch.length; await markPhotoDone(batch.map(f => photoInternalName(f.name))); await markSeen(); break }
        if (r === "stop") return saved
        note = r === "failed" ? "\n\n剛才分享失敗了，請再按一次，或改用下載。" : ""
      }
    }
    return saved
  }
  // 編者按 / Editor's note：這個視窗原本第一顆是「核對備份資料夾再備份」（選資料夾、比對裡面實際有的檔案），使用者要求拿掉；不要加回來。現在「已備份」只看這部裝置上的記錄（photobk:done）；換了備份資料夾、或資料夾裡的檔案被刪了，要自己選「全部重新備份」。
  //   English: the first button used to be "核對備份資料夾再備份" (pick the folder and compare what is really in it); the user asked for it to be removed, so do not add it back. "Already backed up" now relies only on this device's record (photobk:done); after changing folders or deleting files there, choose 全部重新備份.
  // 編者按 / Editor's note：這個視窗在這一步就檢查有沒有重複：已備份過的明說「不會重複存」，預設只備份新增的；全部都備份過時只給「好」，「仍要全部重新備份（會重複存）」放在後面當作退路（換了資料夾、或資料夾裡的檔案被刪了才用得到）。使用者按過「全部重新備份」而重複存了，所以不要再把「全部重新備份」放成主要選項。
  //   English: the duplicate check happens right here: already-backed-up items are stated as "won't be stored again" and only the new ones are backed up by default; when everything is already backed up the primary button is just 好 and "仍要全部重新備份（會重複存）" stays as a labelled escape hatch (changed folder / files deleted there). The user once pressed 全部重新備份 and got duplicates, so never make it the main choice again.
  async function doBackupPhotos(yearStr) {   // 選單的「照片 → 備份 → 執行」。這一步就先檢查哪些已經備份過，視窗直接告訴使用者，預設只備份新增的
    if (!/^\d{4}$/.test(yearStr || "")) { say("備份失敗：年份不對"); return }
    const year = +yearStr
    const names = yearPhotoNames(await photoIndex(), year)
    if (!names.length) { say(year + " 年沒有照片可備份"); return }
    const done = await readPhotoDone(), fresh = names.filter(n => !done[n]), had = names.length - fresh.length
    let msg, buttons
    if (!had) { msg = year + " 年有 " + names.length + " 張照片，都還沒備份過。"; buttons = [{ label: "全部備份（" + names.length + " 張）", kind: "pri", value: "new" }, { label: "不用了", value: "" }] }
    else if (fresh.length) { msg = year + " 年有 " + names.length + " 張照片：\n\n• 已備份過 " + had + " 張（不會重複存）\n• 新增 " + fresh.length + " 張"; buttons = [{ label: "只備份新增的（" + fresh.length + " 張）", kind: "pri", value: "new" }, { label: "不用了", value: "" }] }
    else { msg = year + " 年的 " + names.length + " 張照片都已經備份過了，沒有新增的。"; buttons = [{ label: "好", kind: "pri", value: "" }, { label: "仍要全部重新備份（" + names.length + " 張，會重複存）", value: "all" }] }
    const pick = await modal("備份 " + year + " 年照片", msg, buttons)
    if (!pick) return
    const files = await photoFilesOf(year, pick === "new" ? new Set(fresh) : null), saved = files.length ? await backupPhotos(year, files) : 0
    say(saved ? "已備份 " + saved + " 張照片" : "沒有備份照片")
    if (saved && isIOS()) await offerMasterImport()   // 編者按／Editor's note：這一批（所有批次）都存進 pwa_photos 之後才問，不要在「加入照片」那一刻問——那時候可能還要繼續加，問了很煩。只有 iOS 才有 Scriptable，其他裝置不問。
  }
  // 編者按／Editor's note：按「要」之後一定會短暫切到 Scriptable（母版沒辦法在背景被偷偷叫起，iOS 不允許），這裡只負責問一次、按下去才切過去；不要改成自動切過去不問。
  //   English: tapping "要" always switches to Scriptable for a moment (iOS has no way to call the master silently in the background) — this just asks once and only switches on confirmation; don't make it jump automatically without asking.
  async function offerMasterImport() {
    const ok = await modal("存入母版？", "要不要現在把剛才備份的照片存進 Scriptable 母版？按「要」畫面會切到 Scriptable 一下，匯入完母版會顯示「已存入母版」。", [{ label: "要", kind: "pri", value: true }, { label: "不用", value: false }])
    if (!ok) return
    try { root.location.href = "scriptable:///run?scriptName=" + encodeURIComponent("日誌") + "&pwaimport=1" } catch (e) {}
  }
  function pickPhotoFiles(done) {   // 在按鈕被按下的當下呼叫
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "image/jpeg,.jpg,.jpeg"; inp.multiple = true; inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  function pickPhotoFolder(done) {   // 在按鈕被按下的當下呼叫：直接選一個資料夾，裡面的 .jpg 全部收進來（其他檔案不管）。iOS 18.4 以上的 Safari 才有這個功能；舊的系統會變成選單一個檔案，所以另外留「改選照片檔」
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.setAttribute("webkitdirectory", ""); inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])].filter(f => /\.jpe?g$/i.test(f.name)); inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  async function importPhotoFiles(files, year) {   // 把選到的 .jpg 放回來：檔名要是「日期_….jpg」，依日期放回對應的卡片；已經有的略過；原檔直接存，不再壓縮。year＝只收這一年的，其他年份略過；不給＝各年份都收。回傳張數
    const s = getStore(), dates = new Set()
    let idx = await photoIndex(), ok = 0, dup = 0, skip = 0, other = 0
    const onDisk = []   // 這次從備份資料夾選到的、檔名正確的照片：都算「已備份」
    say("處理 " + files.length + " 張照片…")
    for (const f of files) {
      try {
        const nm = photoInternalName(f.name.startsWith(PWA_PHOTO_PREFIX) ? f.name.slice(PWA_PHOTO_PREFIX.length) : f.name)   // 舊版備份加的前綴要拿掉；新版的短檔名換回原來的長檔名
        if (!okName(nm)) { skip++; continue }
        if (year && nm.slice(0, 4) !== String(year)) { other++; continue }
        if (idx.some(x => x.f === nm)) { dup++; onDisk.push(nm); continue }
        const buf = await f.arrayBuffer(), head = new Uint8Array(buf.slice(0, 2))
        if (head[0] !== 0xFF || head[1] !== 0xD8) { skip++; continue }   // 不是 JPEG
        const blob = new root.Blob([buf], { type: "image/jpeg" })
        await s.set("photo:" + nm, blob)
        idx = [...idx, { f: nm, size: blob.size, created: Date.now() }]
        await s.set("photoIndex", idx); ok++; onDisk.push(nm)
        if (dateOf(nm)) dates.add(dateOf(nm))
      } catch (e) { skip++ }
    }
    try { await markPhotoDone(onDisk) } catch (e) {}
    const msg = "已還原 " + ok + " 張照片" + (dup ? "，略過 " + dup + " 張已有的" : "") + (other ? "，略過 " + other + " 張不是 " + year + " 年的" : "") + (skip ? "，" + skip + " 張不能用（檔名不對或不是 JPEG）" : "")
    pushPhotos(await cardMap([...dates]), ok ? msg : "")
    if (!ok) say(msg)
    return { ok, dup, skip, other, msg }
  }
  async function doRestorePhotos() {   // 面板「照片」那排的「還原」：不限年份，自己選
    const pick = await modal("還原照片", "依檔名日期（如 2026-03-05）自動將照片放回日誌：\n\n• 自動過濾：已存在的會略過。\n• 全部還原：選「照片資料夾」，再選有備份照片的資料夾" + (isIOS() ? "（如 iCloud/Scriptable/pwa_photos）" : "") + "。\n• 個別還原：按「改選照片檔」，選取照片以還原至指定日期的日誌卡片。\n• 注意：勿從「照片圖庫」選，否則檔名被改會無法對應日期。", [{ label: "照片資料夾…", kind: "pri", onclick: pickPhotoFolder }, { label: "改選照片檔…", onclick: pickPhotoFiles }, { label: "取消", value: null }])
    if (!pick) return
    await importPhotoFiles(pick.files, null)
  }


  async function doDelPdf(f) {   // 在全螢幕閱讀畫面按兩次「刪除」：原檔、縮圖、清單一起刪；卡片上的 PDF 區塊跟著更新
    const d = pdfDateOf(f)
    if (!d) { say("刪除失敗：檔名不對"); return }
    try {
      const s = getStore(), idx = await pdfIndex()
      await s.set("pdfIndex", idx.filter(x => x.f !== f)); await s.del("pdf:" + f); await s.del("pdfthumb:" + f); await s.del("pdfann:" + f)   // 批註一起刪
      if (pdfThumbUrls.has(f)) { root.URL.revokeObjectURL(pdfThumbUrls.get(f)); pdfThumbUrls.delete(f) }
      const o = pdfOpen.get(f); if (o) { o.ctl.destroy(); pdfOpen.delete(f) }   // 卡片裏已經展開的，順便放掉
      pushPdfs(await pdfCardMap([d]), "已刪除")
    } catch (e) { say("刪除失敗：" + (e && e.message || e)) }
  }

  // ---------- PDF 備份與還原：和照片一樣，備份檔（.json）不含 PDF，所以 PDF 另外存成一個個 .pdf；還原時依檔名放回原來的卡片 ----------
  // 編者按 / Editor's note：這一段是上面「照片備份與還原」的 PDF 版，故意分開寫、不和照片共用程式，免得動到已經測好的照片備份。
  //   English: this is the PDF twin of the photo backup above. It is written separately on purpose so the tested photo backup is not touched.
  // 備份檔名：「日期_8位36進位毫秒_序號_原檔名.pdf」。內部檔名是「日期_毫秒_序號.pdf」，原來的檔名記在清單的 n；還原時從檔名拆回來，卡片上才會顯示原來的名字。
  //   English: export name = date_ms-in-base36_seq_originalName.pdf; restore splits it back into the internal name and the display name.
  // 分享選單一次不要塞太多或太大：每一批最多 PDF_BATCH 個、PDF_BATCH_BYTES 位元組（先到的為準；單一檔案超過上限就自己一批）。
  const PDF_BATCH = 10, PDF_BATCH_BYTES = 80 * 1048576
  const PDF_EXP = /^(\d{4}-\d{2}-\d{2})_([0-9a-z]{8})_(\d+)_(.+)\.pdf$/i
  const safePdfName = n => String(n || "PDF").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "PDF"
  const pdfExportName = x => { const m = /^(\d{4}-\d{2}-\d{2})_(\d{13})_(\d+)\.pdf$/.exec(x.f); return m ? m[1] + "_" + Number(m[2]).toString(36).padStart(8, "0") + "_" + m[3] + "_" + safePdfName(x.n) + ".pdf" : "" }
  const pdfParseExport = nm => { const m = PDF_EXP.exec(nm || ""); if (!m) return null; const ms = parseInt(m[2].toLowerCase(), 36); return String(ms).length === 13 ? { f: m[1] + "_" + ms + "_" + m[3] + ".pdf", n: m[4] } : null }
  const yearPdfs = (idx, year) => idx.filter(x => pdfDateOf(x.f).slice(0, 4) === String(year)).sort((a, b) => a.f < b.f ? -1 : 1)
  const PDF_DONE_KEY = "pdfbk:done"   // 已經備份過的 PDF：{ 內部檔名: 備份時間 }，和 photobk:done 同一個做法
  async function readPdfDone() { const v = await getStore().get(PDF_DONE_KEY); return v && typeof v === "object" && !Array.isArray(v) ? v : {} }
  async function markPdfDone(names) {
    if (!names.length) return
    const cur = await readPdfDone(), now = Date.now()
    for (const n of names) cur[n] = now
    await getStore().set(PDF_DONE_KEY, cur)
  }
  async function pdfFilesOf(year, only) {   // only＝只要這些內部檔名（Set）；不給＝全部
    const s = getStore(), out = []
    for (const x of yearPdfs(await pdfIndex(), year)) {
      if (only && !only.has(x.f)) continue
      const blob = await s.get("pdf:" + x.f), nm = pdfExportName(x)
      if (blob && nm) out.push(new root.File([blob], nm, { type: "application/pdf" }))
    }
    return out
  }
  function pdfBatches(files) {
    const out = []; let cur = [], sz = 0
    for (const f of files) {
      if (cur.length && (cur.length >= PDF_BATCH || sz + f.size > PDF_BATCH_BYTES)) { out.push(cur); cur = []; sz = 0 }
      cur.push(f); sz += f.size
    }
    if (cur.length) out.push(cur)
    return out
  }
  const pdfFolderEg = () => isIOS() ? "，例如，iCloud Drive › Scriptable › pwa_pdfs" : ""
  async function pdfHintSeen() { if (await getStore().get("hint:pdfbk")) return true; return Object.keys(await readPdfDone()).length > 0 }   // 資料夾的說明只在第一次出現（見照片備份的編者按）
  async function backupPdfs(year, files) {   // 一批一批存，每一批都要使用者按一下（分享選單只能在按下的當下打開）。回傳實際存出幾個
    const nav = root.navigator, batches = pdfBatches(files)
    let seen = await pdfHintSeen(), saved = 0
    const markSeen = async () => { if (!seen) { seen = true; try { await getStore().set("hint:pdfbk", 1) } catch (e) {} } }
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i], title = "備份 " + year + " 年 PDF" + (batches.length > 1 ? "（第 " + (i + 1) + "／" + batches.length + " 批）" : "")
      let note = ""
      for (;;) {
        const buttons = []
        if (nav && nav.share) buttons.push({ label: "儲存 PDF", kind: "pri", onclick: done => nav.share({ files: batch }).then(() => done("shared"), err => done(err && err.name === "AbortError" ? "again" : "failed")) })
        buttons.push({ label: "改用下載", value: "download" }, { label: "停止", value: "stop" })
        const r = await modal(title, "這一批 " + batch.length + " 個（" + fmtMB(batch.reduce((n, f) => n + f.size, 0)) + "）。" + (seen ? "按「儲存 PDF」。" : "按「儲存 PDF」後，選擇儲存成檔案，再選你指定的資料夾" + pdfFolderEg() + (batches.length > 1 ? "（每一批都選同一個）" : "") + "。") + note, buttons)
        const names = () => batch.map(f => (pdfParseExport(f.name) || {}).f).filter(Boolean)
        if (r === "shared") { saved += batch.length; await markPdfDone(names()); await markSeen(); break }
        if (r === "download") { for (const f of batch) { downloadBlob(f.name, f); await new Promise(res => setTimeout(res, 300)) } saved += batch.length; await markPdfDone(names()); await markSeen(); break }
        if (r === "stop") return saved
        note = r === "failed" ? "\n\n剛才分享失敗了，請再按一次，或改用下載。" : ""
      }
    }
    return saved
  }
  function pickPdfFiles(done) {   // 在按鈕被按下的當下呼叫
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = "application/pdf,.pdf"; inp.multiple = true; inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  function pickPdfFolder(done) {   // 在按鈕被按下的當下呼叫：選一個資料夾，裡面的 .pdf 全部收進來（其他檔案不管）。iOS 18.4 以上的 Safari 才有這個功能；舊系統會變成選單一個檔案，所以另外留「改選 PDF 檔」
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.setAttribute("webkitdirectory", ""); inp.hidden = true
    inp.onchange = () => { const fs = [...(inp.files || [])].filter(f => /\.pdf$/i.test(f.name)); inp.remove(); if (fs.length) done({ files: fs }) }
    d.body.appendChild(inp); inp.click()
  }
  async function doBackupPdfs(yearStr) {   // 選單的「PDF → 備份 → 執行」。和照片一樣：這一步先檢查哪些已經備份過（只看這部裝置上的記錄 pdfbk:done），告訴使用者，預設只備份新增的（見照片備份的編者按）
    if (!/^\d{4}$/.test(yearStr || "")) { say("備份失敗：年份不對"); return }
    const year = +yearStr, names = yearPdfs(await pdfIndex(), year).map(x => x.f)
    if (!names.length) { say(year + " 年沒有 PDF 可備份"); return }
    const done = await readPdfDone(), fresh = names.filter(n => !done[n]), had = names.length - fresh.length
    let msg, buttons
    if (!had) { msg = year + " 年有 " + names.length + " 個 PDF，都還沒備份過。"; buttons = [{ label: "全部備份（" + names.length + " 個）", kind: "pri", value: "new" }, { label: "不用了", value: "" }] }
    else if (fresh.length) { msg = year + " 年有 " + names.length + " 個 PDF：\n\n• 已備份過 " + had + " 個（不會重複存）\n• 新增 " + fresh.length + " 個"; buttons = [{ label: "只備份新增的（" + fresh.length + " 個）", kind: "pri", value: "new" }, { label: "不用了", value: "" }] }
    else { msg = year + " 年的 " + names.length + " 個 PDF 都已經備份過了，沒有新增的。"; buttons = [{ label: "好", kind: "pri", value: "" }, { label: "仍要全部重新備份（" + names.length + " 個，會重複存）", value: "all" }] }
    const pick = await modal("備份 " + year + " 年 PDF", msg, buttons)
    if (!pick) return
    const files = await pdfFilesOf(year, pick === "new" ? new Set(fresh) : null), saved = files.length ? await backupPdfs(year, files) : 0
    say(saved ? "已備份 " + saved + " 個 PDF" : "沒有備份 PDF")
  }
  async function importPdfFiles(files) {   // 把選到的 .pdf 放回來：檔名要是備份出來的格式，依日期放回對應的卡片，名字也換回原來的；已經有的略過；原檔直接存
    try { await loadPdfjs() } catch (e) { say("PDF 閱讀工具載入失敗：請確認 pdf.min.mjs 和 pdf.worker.min.mjs 已放進網頁資料夾", 6000); return }
    const s = getStore(), dates = new Set(), onDisk = []
    let idx = await pdfIndex(), ok = 0, dup = 0, skip = 0, pw = 0
    say("處理 " + files.length + " 個 PDF…")
    for (const f of files) {
      try {
        const q = pdfParseExport(f.name)
        if (!q) { skip++; continue }
        if (idx.some(x => x.f === q.f)) { dup++; onDisk.push(q.f); continue }
        if (!(await f.slice(0, 1024).text()).includes("%PDF")) { skip++; continue }   // 不是 PDF
        const r = await readPdf(f)
        if (r.pw) { pw++; continue }
        await s.set("pdf:" + q.f, f.slice(0, f.size, "application/pdf"))
        await s.set("pdfthumb:" + q.f, r.thumb)
        idx = [...idx, { f: q.f, n: q.n, pages: r.pages, size: f.size, created: Date.now() }]
        await s.set("pdfIndex", idx); ok++; onDisk.push(q.f); dates.add(pdfDateOf(q.f))
      } catch (e) { skip++ }
    }
    try { await markPdfDone(onDisk) } catch (e) {}
    const msg = "已還原 " + ok + " 個 PDF" + (dup ? "，略過 " + dup + " 個已有的" : "") + (pw ? "，" + pw + " 個有密碼不能用" : "") + (skip ? "，" + skip + " 個不能用（檔名不對或不是 PDF）" : "")
    pushPdfs(await pdfCardMap([...dates]), ok ? msg : "")
    if (!ok) say(msg)
  }
  async function doRestorePdfs() {   // 選單的「PDF → 還原 → 執行」：不限年份，自己選
    const pick = await modal("還原 PDF", "依檔名日期（如 2026-03-05）自動將 PDF 放回日誌：\n\n• 自動過濾：已存在的會略過。\n• 全部還原：選「PDF 資料夾」，再選有備份 PDF 的資料夾" + (isIOS() ? "（如 iCloud/Scriptable/pwa_pdfs）" : "") + "。\n• 個別還原：按「改選 PDF 檔」，選取要還原的 PDF。\n• 注意：檔名要保持備份時的樣子（日期＋一串代碼＋原檔名），改過名字的無法對應日期。", [{ label: "PDF 資料夾…", kind: "pri", onclick: pickPdfFolder }, { label: "改選 PDF 檔…", onclick: pickPdfFiles }, { label: "取消", value: null }])
    if (!pick) return
    await importPdfFiles(pick.files)
  }

  // ---------- 天氣：每張日誌卡片的標題欄顯示「地名 溫度範圍 有雨／下雪 大風 酷熱」（判斷規則和 Scriptable 版相同）----------
  // 聯網：預報用 Open-Meteo（免費、不用金鑰）；位置用瀏覽器的定位（第一次要在瀏覽器裏允許「位置」）；地名用 OpenStreetMap 的 Nominatim 反查（Scriptable 版現在也用同一個反查和同一套挑選規則，兩邊同一個地點會得到同一個地名；不喜歡的可以用 alias 改寫）。
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
    netMs: 8000,        // 查天氣、查地名，每一步最多等多久（毫秒）
    posMs: 12000,       // 定位第一次（省電、用網路定位）最多等多久（毫秒）；Android 第一次定位常常要十幾秒
    posHighMs: 20000,   // 第一次拿不到時，改用 GPS（高精度）再試，最多等多久（毫秒）
    alias: {},          // 地名改寫，例如 { "New Malden": "新莫爾登" }
    moves: [{ date: "2026-11-01", from: "New Malden", also: ["Merton"], to: "West Barnes", until: "2026-11-07" }],   // 搬家修正：搬家日「以前」的日子用 from（舊家地名）、「當天起」用 to（新家地名）；also＝也要改成 to 的其他錯誤地名；until＝「當天起改成 to」只作用到這一天（含），之後的日子完全以定位結果為準，真的去了舊家那一區才不會被改掉。每次讀天氣檔都會把兩邊放回正確的地名，重複執行結果不變；搬家日期不對就改 date（格式 年-月-日）
    debugPlace: false,  // 改成 true：每次查地名時，在畫面上顯示反查回來的原始地址（欄位）和選出的地名，方便檢查為什麼選了這個名字
    bigCities: ["greater london", "london", "倫敦", "伦敦", "hong kong", "香港", "guangzhou", "廣州", "广州", "shenzhen", "深圳", "macau", "澳門", "澳门"]   // 這些城市（以及所有以「市」結尾的中文城市）改用更細的「區」；其他地方用「城鎮」
  }
  const w2 = n => Math.round(n * 100) / 100
  const NAME_V = 3   // 地名挑選規則的版本；改了規則就把這個數字加一，舊規則存下的地名會重新查一次
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
  let posErr = ""   // 最近一次取不到位置的原因：denied／timeout／unavailable／insecure／nosupport
  function getPosition() {   // 回傳 { latitude, longitude }；使用者不給定位回傳 "denied"；其他失敗回傳 null（原因記在 posErr）
    const g = root.navigator && root.navigator.geolocation
    posErr = ""
    if (!g) { posErr = root.isSecureContext === false ? "insecure" : "nosupport"; return Promise.resolve(null) }
    const once = (high, ms) => new Promise(res => {   // 試一次：成功回傳座標；失敗回傳 { code }（1＝不給定位、2＝拿不到、3＝逾時）
      let done = false
      function fin(v) { if (!done) { done = true; clearTimeout(guard); res(v) } }
      const guard = setTimeout(() => fin({ code: 3 }), ms + 7000)   // 「允許位置」的詢問框還沒按時，瀏覽器的 timeout 不計時；這裏另設一個上限，免得後面的天氣工作一直卡住
      try {
        g.getCurrentPosition(p => fin(p && p.coords ? { latitude: p.coords.latitude, longitude: p.coords.longitude } : { code: 2 }),
          e => fin({ code: (e && e.code) || 2 }), { enableHighAccuracy: high, timeout: ms, maximumAge: high ? 0 : 600000 })
      } catch (e) { fin({ code: 2 }) }
    })
    return (async () => {
      let r = await once(false, W.posMs)
      if (r.latitude == null && r.code !== 1) r = await once(true, W.posHighMs)   // Android：網路定位逾時或拿不到，再用 GPS 試一次
      if (r.latitude != null) return r
      if (r.code === 1) { posErr = "denied"; return "denied" }
      posErr = r.code === 3 ? "timeout" : "unavailable"
      return null
    })()
  }
  // 地名補強：Nominatim 是看「這一點落在哪個區域範圍內」，靠區界的地方可能歸給隔壁（Wimbledon 站旁邊會變成 Merton Park）。
  // 這裏改問 Photon（同樣是 OpenStreetMap 的資料，免金鑰）：找離這一點最近的「地名點」（suburb、town、neighbourhood…），最近的優先。
  // 只用在中文地名以外的地方（Photon 沒有中文）；查不到、逾時就回傳空字串，由 Nominatim 的結果墊底。同樣只送出約 100 米精度的位置。
  const NEAR_OK = ["suburb", "neighbourhood", "quarter", "town", "village", "hamlet", "city_district"]
  async function nearPlace(lat, lon) {
    const w3 = n => Math.round(n * 1000) / 1000
    try {
      const j = await fetchJson("https://photon.komoot.io/reverse?lat=" + w3(lat) + "&lon=" + w3(lon) + "&radius=2&limit=15&lang=en&layer=district&layer=locality&layer=city")
      let best = "", bd = 1e9
      for (const f of (j && j.features) || []) {
        const p = f.properties || {}, c = f.geometry && f.geometry.coordinates
        if (!NEAR_OK.includes(p.osm_value) || !p.name || !c) continue
        const d = distKm({ lat, lon }, { lat: c[1], lon: c[0] })
        if (d < bd) { bd = d; best = String(p.name).trim() }
      }
      return best
    } catch (e) { return "" }
  }
  // 地名：反查地址，取「最細」的一層——大城市（倫敦、香港、廣州…）用「區」（尖沙咀、荔灣區），其他用「城鎮」（New Malden）
  // 不指定 zoom（用預設的最細一級）才會拿到完整的一串（suburb、town、borough、city…）；指定太粗，只會回傳到「郡／大倫敦」一級。
  // 只送出約 100 米精度的位置（小數 3 位）；地名只要到區、城鎮，不需要更準。
  async function placeName(lat, lon) {
    const zh = inZh(lat, lon), w3 = n => Math.round(n * 1000) / 1000
    const nearP = zh ? Promise.resolve("") : nearPlace(lat, lon)   // 和 Nominatim 同時查，不增加等待
    let a = null
    try {
      const j = await fetchJson("https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=" + w3(lat) + "&lon=" + w3(lon) + "&accept-language=" + (zh ? "zh-HK,zh" : "en-GB,en"))
      a = j && j.address
    } catch (e) {}
    if (!a) { const nb = await nearP; return W.alias[nb] || nb }
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
    const nb = await nearP, out = nb || n
    return W.alias[out] || out
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
  function applyMoves(st) {   // 搬家修正：依 W.moves 把搬家日前後的地名放回正確的一邊（只改地名剛好等於 from／to 的日子，其他地方不動）
    for (const m of W.moves || []) {
      const fix = (cur, d) => (d >= m.date ? (d <= (m.until || "9999-12-31") && (cur === m.from || (m.also || []).includes(cur)) ? m.to : cur) : (cur === m.to ? m.from : cur))
      for (const [d, r] of Object.entries(st.days || {})) if (r) r.p = fix(r.p, d)
      for (const [d, r] of Object.entries(st.fc || {})) if (r) r.p = fix(r.p, d)
      if (st.last && st.last.d && st.last.name) st.last.name = fix(st.last.name, st.last.d)
    }
  }
  async function readWeather() {   // 天氣資料：{ v, days（已發生的日子）, fc（未來預報）, last（最後一次所在地）, u（上次更新時間）, cfg（日誌頁設定的預報天數、酷熱溫度） }
    let st = { v: 1, days: {} }
    try { const t = await getStore().get("weather"); if (t && typeof t === "object") st = Object.assign(st, t) } catch (e) {}
    if (!st.days || typeof st.days !== "object") st.days = {}
    applyMoves(st)
    applyWxCfg(st.cfg)   // 日誌頁設定過的數字，優先於上面的預設值
    return st
  }
  const saveWeather = st => getStore().set("weather", st)
  async function wxHintOnce(key, msg) {   // 同一個提示，每天最多出現一次，免得天天打擾；隔天還是不行會再提醒
    const s = getStore(), today = ymd(new Date())
    if (await s.get(key) === today) return
    await s.set(key, today)
    say(msg, 9000)
  }
  const wxDeniedHint = () => wxHintOnce("hint:wxdenied", "天氣需要「位置」權限：請在瀏覽器的網站設定裏把這個網站的位置改成「允許」，再重新打開日誌")
  const wxFailHint = () => wxHintOnce("hint:wxfail", "天氣：取不到位置（" + ({ timeout: "等太久沒有回應", unavailable: "裝置沒有提供位置", insecure: "這個網址不是 https", nosupport: "這個瀏覽器不支援定位" }[posErr] || "原因不明") + "）。請確認裝置的「位置」已開啟；之後在選單按「天氣」再按確定，可以重試")
  async function weatherUpdate(st) {   // 回傳 true＝有查到新資料並已存好；false＝什麼都沒改（太近才更新過、沒定位、沒網路…）
    const today = ymd(new Date()), migrate = st.nv !== NAME_V   // migrate＝存下來的地名是舊規則查的：這一次一定重新查，不沿用
    if (!migrate && st.u && Date.now() - st.u < W.minGapMin * 60000 && st.last && st.last.d === today && st.days[today] && st.fc) return false
    const pos = await getPosition()
    if (pos === "denied") { await wxDeniedHint(); return false }
    if (!pos) { await wxFailHint(); return false }
    const cur = { lat: w2(pos.latitude), lon: w2(pos.longitude) }
    const last = st.last, same = !!last && distKm(last, cur) <= W.sameKm
    let name, got = false
    if (!migrate && last && last.name && distKm(last, cur) < W.stickyKm) name = last.name
    else { name = await placeName(pos.latitude, pos.longitude); got = !!name; if (!name && same) name = last.name || "" }
    if (migrate && got) st.nv = NAME_V   // 只記下「已經照新規則查過」；過去日子的地名不再批次改寫（搬過家的話，舊家的日子不能跟著改）
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

  // ---------- 匯入 Scriptable 版的天氣檔（weather.json）：把已經發生的日子補進這裡 ----------
  // 只拿 days（已發生的日子）；預報（fc）、最後所在地（last）、設定（cfg）都不拿。同一天這裡已經有「定案」的就不動（以這部裝置自己查到的為準）。
  // 檔案只在這部裝置上讀（從「還原」視窗選取，或第一次使用時和日誌資料檔一起選），不上傳到任何地方。
  const isWxFile = o => !!o && typeof o === "object" && !Array.isArray(o) && !!o.days && typeof o.days === "object" && !Array.isArray(o.days)   // 備份檔的 days 是一列一列的陣列，天氣檔的 days 是「日期 → 紀錄」，靠這個分開
  const wxNum = x => (typeof x === "number" && isFinite(x)) ? x : null
  function cleanWxRec(d, r) {   // 一天的天氣紀錄：日期不是真的日期、欄位或型別不對的丟掉（回傳 null）；留下來的只有已知的欄位
    if (!DATERE.test(d) || ymd(noon(d)) !== d || !r || typeof r !== "object") return null
    const lo = wxNum(r.lo), hi = wxNum(r.hi)
    if (lo == null || hi == null) return null
    return { p: typeof r.p === "string" ? r.p.trim().slice(0, 60) : "", lo, hi, r: r.r ? 1 : 0, s: r.s ? 1 : 0, w: r.w ? 1 : 0, rv: wxNum(r.rv) || 2, f: r.f ? 1 : 0, t: wxNum(r.t) || 0 }
  }
  async function importWeatherData(imp) {   // 讀這裡的天氣、併入匯入檔的 days、存回去；回傳摘要（不碰畫面）。呼叫端要用 wxTask 包起來，才不會和背景更新互相蓋掉
    const st = await readWeather(), today = ymd(new Date()), res = { add: 0, upg: 0, keep: 0, skip: 0, from: "", to: "", st }
    for (const [d, raw] of Object.entries(imp.days)) {
      const r = cleanWxRec(d, raw)
      if (!r || d > today) { res.skip++; continue }   // 未來的日子不是「已發生的天氣」，不收
      const x = st.days[d]
      if (!x) { st.days[d] = r; res.add++ }
      else if (r.f && !x.f) { st.days[d] = r; res.upg++ }   // 這裡的是還沒定案的（例如今天），匯入檔的是定案的：換成定案的
      else { res.keep++; continue }
      if (!res.from || d < res.from) res.from = d
      if (!res.to || d > res.to) res.to = d
    }
    if (res.add || res.upg) { applyMoves(st); await saveWeather(st) }
    return res
  }
  function wxImportMsg(r) {
    const n = r.add + r.upg
    if (!n) return r.keep ? "這部裝置已經有這些日子的天氣，沒有新增" : "天氣檔裏沒有可用的日子"
    return "已匯入天氣：" + n + " 天（" + r.from + " 至 " + r.to + "）" + (r.keep ? "；" + r.keep + " 天這裡已有，沒動" : "") + (r.skip ? "；" + r.skip + " 筆無法使用，略過" : "")
  }
  async function importWxFiles(imps) {   // 「匯入資料檔」時一起選到的天氣檔：一個一個併進去（排在 wxTask 隊伍裏，不和背景更新互相蓋掉）；回傳加總的摘要（st＝最新的天氣資料，要推給頁面）
    const sum = { add: 0, upg: 0, keep: 0, skip: 0, from: "", to: "", st: null }
    for (const imp of imps) {
      const r = await wxTask(() => importWeatherData(imp))
      sum.add += r.add; sum.upg += r.upg; sum.keep += r.keep; sum.skip += r.skip; sum.st = r.st
      if (r.from && (!sum.from || r.from < sum.from)) sum.from = r.from
      if (r.to && (!sum.to || r.to > sum.to)) sum.to = r.to
    }
    return sum
  }

  // ---------- 提醒：屬於日誌的某一天（一天一個），資料存在這部裝置（IndexedDB 的 reminders）----------
  // 和 Scriptable 版的差別：Scriptable 能請 iOS 預先排好通知，網頁版沒有伺服器，日誌關閉時沒有辦法自己叫醒，所以改成：
  //   · 日誌開著：每 30 秒檢查一次，到期就在畫面上跳出提醒（回到日誌時也立刻檢查一次）
  //   · 日誌沒開著：下次打開時補上（只補兩天內的；更早的不補，在「提醒清單」裏仍看得到「已逾期」）
  //   · 使用者在「⋯」→「提醒通知」允許通知後：日誌在背景但還活著時，到期改發系統通知
  //   · 點系統通知：由 sw.js 的 notificationclick 處理（日誌開著就切到提醒清單，沒開著就打開並進提醒清單）
  // 「哪些到期時間已經提醒過」存在 remfired（日期 → { due, k＝已提醒到第幾天 }），不會重複提醒；設好提醒的當下已經過去的時間，不算漏掉，不補。
  const REM_TICK_MS = 30000, REM_CATCH_MS = 2 * 864e5
  // 推播（日誌關閉也會響）：設好伺服器後，把 PUSH_URL（register 函式的網址）和 PUSH_KEY（推播公鑰）填進來；留空＝不啟用，行為和以前完全一樣（已填：Cloud Dictionary 專案的 register）
  const PUSH_URL = "https://rdxtwzyebyllsuqajwcp.supabase.co/functions/v1/register", PUSH_KEY = "BP0EWH8YwrAFs5rro1XxOtlaTZ1yvRJyu8kCcA8Z8QSneOAHrPegfCkfqahruiMdZLwubxr9__uUvjrg9olhQto"
  const remDays = r => Math.max(1, Math.min(60, r.repeat || 1))
  const occTime = (r, k) => { const d = new Date(r.due); d.setDate(d.getDate() + k); return d.getTime() }
  function dueOccurrence(r, now) {   // 到了的最後一天是第幾天（0 起算）；都還沒到回傳 -1
    let k = -1
    for (let i = 0; i < remDays(r); i++) { if (occTime(r, i) <= now) k = i; else break }
    return k
  }
  async function readRems() {
    const l = await getStore().get("reminders")
    return Array.isArray(l) ? l.filter(validRem) : []
  }
  async function saveRems(list) {
    const cutoff = Date.now() - REM_KEEP_MS
    await getStore().set("reminders", list.filter(r => validRem(r) && !(r.del && (r.t || 0) < cutoff)))
    pushSoon()   // 提醒有變動：把最新的到期時間交給伺服器（沒啟用推播就什麼都不做）
  }
  async function markFired(list, now) {   // 把這些提醒「到現在為止已經過去的時間」記成已提醒過
    const s = getStore(), f = await s.get("remfired") || {}
    for (const r of list) {
      if (!validRem(r)) continue
      if (r.del || !r.due) { delete f[r.date]; continue }
      f[r.date] = { due: r.due, k: dueOccurrence(r, now) }
    }
    await s.set("remfired", f)
  }
  async function pushRems(msg) {   // 把最新的提醒清單交給頁面（頁面的 __remUpdate 只換有變動那幾天的卡片；正在看提醒清單就重畫）
    const rems = await readRems()
    if (typeof root.__remUpdate === "function") root.__remUpdate(rems, msg || "")
  }
  function remText(date, fb, rows, edits) {   // 通知內文：這一天現在的文字（先看修改，再看原稿，最後用設提醒時存下的），去掉「19. 星期一」那行標題
    const e = edits.find(r => r.date === date && !r.del)
    const raw = rows.find(x => x[0] === date && !x[3])
    const full = e ? (e.deleted ? (fb || "") : (e.text || "")) : (raw ? raw[2] : (fb || ""))
    const lines = full.split("\n").filter(l => l.trim() !== "")
    if (raw && lines.length > 1 && new RegExp("^\\s*" + parseInt(date.slice(8)) + "\\s*[.．]").test(lines[0])) lines.shift()
    return lines.map(l => l.trim()).join(" ").slice(0, 200)
  }
  async function showNote(it) {   // 發系統通知；成功回傳 true（沒有權限、瀏覽器不支援、出錯都回傳 false）
    try {
      const N = root.Notification
      if (!N || N.permission !== "granted") return false
      const sw = root.navigator && root.navigator.serviceWorker, reg = sw && sw.getRegistration ? await sw.getRegistration() : null
      const opt = { body: it.body, tag: "diaryrem_" + it.date, icon: "icon-180.png", data: { tab: "rem" } }
      if (reg && reg.showNotification) await reg.showNotification(it.title, opt)
      else new N(it.title, opt)
      return true
    } catch (e) { return false }
  }
  async function remModal(items) {   // 日誌開著時到期：在畫面上跳出提醒
    const one = items.length === 1
    const text = items.slice(0, 6).map(x => (one ? "" : x.label + "　") + (x.body || "（這一天沒有文字）")).join("\n\n") + (items.length > 6 ? "\n\n…還有 " + (items.length - 6) + " 則" : "")
    const v = await modal(one ? items[0].title : "日誌提醒（" + items.length + " 則）", text, [
      { label: "知道了", kind: "pri", value: "ok" },
      { label: one ? "完成（不再提醒）" : "全部完成（不再提醒）", value: "done" },
      { label: "看提醒清單", value: "list" }])
    if (v === "done") {
      const by = new Map((await readRems()).map(r => [r.date, r]))
      for (const x of items) { const c = by.get(x.date); if (c && !c.del) by.set(x.date, Object.assign({}, c, { done: true, t: Date.now() })) }
      await saveRems([...by.values()])
      await pushRems("已完成")
    } else if (v === "list" && typeof root.showRem === "function") root.showRem()
  }
  async function remCheck() {   // 找出到期、還沒提醒過的：日誌看得到就跳出提醒；在背景就發系統通知（發不出去就先不記，等回到日誌再跳）
    const s = getStore(), now = Date.now()
    const rems = await readRems(), fired = await s.get("remfired") || {}, out = {}, alerts = []
    for (const r of rems) {
      if (r.del || !r.due) continue
      const f = fired[r.date], fk = (f && f.due === r.due && Number.isInteger(f.k)) ? f.k : -1
      out[r.date] = { due: r.due, k: fk }
      if (r.done) continue
      const k = dueOccurrence(r, now)
      if (k <= fk) continue
      if (now - occTime(r, k) > REM_CATCH_MS) { out[r.date].k = k; continue }   // 太久以前的不補
      alerts.push({ r, k })
    }
    const shown = []
    if (alerts.length) {
      const visible = !!(root.document && root.document.visibilityState === "visible")
      const rows = await s.get("rows") || [], edits = await s.get("edits") || []
      for (const a of alerts) {
        const md = parseInt(a.r.date.slice(5, 7)) + "月" + parseInt(a.r.date.slice(8)) + "日", n = remDays(a.r)
        const it = { date: a.r.date, label: md, title: "日誌提醒 " + md, body: remText(a.r.date, a.r.txt, rows, edits) + (n > 1 ? "\n（第 " + (a.k + 1) + "/" + n + " 天）" : "") }
        if (visible) { shown.push(it); out[a.r.date].k = a.k }
        else if (await showNote(it)) out[a.r.date].k = a.k
      }
    }
    if (JSON.stringify(out) !== JSON.stringify(fired)) await s.set("remfired", out)   // 先記下，再跳提醒：提醒開著的時候，別的檢查不會重複跳
    if (shown.length) await remModal(shown)
  }
  let remRunning = null
  function remCheckSoon() {   // 同一時間只做一次檢查（提醒視窗開著時，後面的定時檢查直接略過）
    if (!remRunning) remRunning = remCheck().catch(() => {}).then(() => { remRunning = null })
    return remRunning
  }
  function startReminders() {   // 頁面載入後呼叫：開始定時檢查；之後每次回到這個頁面也檢查一次
    const d = root.document
    if (d && d.addEventListener) {   // 組頁（document.write）會清掉舊的監聽，所以每次都「先拿掉舊的、再加新的」
      const onVis = () => { if (d.visibilityState === "visible") { remCheckSoon(); pushRetry(true) } }   // 回到日誌：順便把沒寄成功的補寄
      if (root.__remOnVis) d.removeEventListener("visibilitychange", root.__remOnVis)
      root.__remOnVis = onVis; d.addEventListener("visibilitychange", onVis)
    }
    const sw = root.navigator && root.navigator.serviceWorker   // 點系統通知（sw.js 的 notificationclick）：日誌已經開著時，切到提醒清單；沒開著時，網址帶 ?tab=rem（見 launch）
    if (sw && sw.addEventListener) {   // 這個監聽掛在 serviceWorker 上，組頁不會清掉，所以同樣先拿掉舊的
      if (root.__remOnMsg) sw.removeEventListener("message", root.__remOnMsg)
      root.__remOnMsg = ev => { if (ev && ev.data && ev.data.type === "diary-open-rem" && typeof root.showRem === "function") root.showRem() }
      sw.addEventListener("message", root.__remOnMsg)
    }
    if (root.__remTimer) root.clearInterval(root.__remTimer)   // 組頁不會清掉舊的計時器
    root.__remTimer = root.setInterval(() => { remCheckSoon(); pushRetry(false) }, REM_TICK_MS)
    root.setTimeout(remCheckSoon, 1500)   // 等頁面畫好再檢查
    if (root.addEventListener) {   // 剛連上網路：馬上補寄（監聽掛在 window 上，同樣先拿掉舊的再加新的）
      if (root.__pushOnline) root.removeEventListener("online", root.__pushOnline)
      root.__pushOnline = () => pushRetry(true); root.addEventListener("online", root.__pushOnline)
    }
    pushSoon(false)   // 每次打開日誌也同步一次，伺服器的資料才不會過期（沒有變動，所以不記成「還沒寄出」；寄失敗才會記）
  }
  async function remHint() {   // 第一次設提醒、還沒決定要不要通知：提示一次（只提示一次）
    try {
      const N = root.Notification, s = getStore()
      if (!N || N.permission !== "default" || await s.get("hint:remnotif")) return
      await s.set("hint:remnotif", 1)
      say("要在到期時收到系統通知：按「⋯」→「提醒通知」開啟", 8000)
    } catch (e) {}
  }
  // ---------- 推播：日誌關閉時由伺服器叫醒 ----------
  // 裝置把「每則提醒還沒到的具體時間」交給伺服器（只有日期和時間，沒有日誌文字）；到點時伺服器發推播，sw.js 的 push 從本機讀出文字、顯示通知。
  // 伺服器那邊以「整份未來時間」為準：每次都送完整清單，完成、取消、改時間都靠這個清單更新。
  const b64ToU8 = s => { const p = "=".repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)) }
  async function pushSub() {   // 取得這部裝置的推播訂閱；沒啟用、還沒允許通知、瀏覽器不支援都回傳 null
    const N = root.Notification, sw = root.navigator && root.navigator.serviceWorker
    if (!PUSH_URL || !PUSH_KEY || !N || N.permission !== "granted" || !sw || !sw.ready) return null
    const reg = await sw.ready
    if (!reg || !reg.pushManager) return null
    return (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(PUSH_KEY) })
  }
  // 同步狀態（存在 IndexedDB 的 pushsync）：{ dirty＝有變動、還沒確認寄給伺服器；last＝上次成功寄出的時間；tried＝上次嘗試的時間；err＝上次失敗的原因 }
  // 失敗不會悄悄放掉：dirty 一直留著，等有網路、或回到日誌、或定時（每 30 秒檢查一次、同一則最少隔 60 秒）自動補寄。
  // 編者按 / Editor's note：每次都要送「完整清單」，連空清單也要送——完成、取消、改時間都是靠這份清單傳到伺服器；伺服器沒收到取消，到點還是會響。不要改成只送有變動的那幾則，也不要在清單是空的時就略過。
  //   Always POST the FULL list, even when it is empty: that is how done/cancelled/rescheduled reminders reach the server. Skipping an empty list would leave cancelled reminders ringing.
  const PUSH_TIMEOUT_MS = 8000, PUSH_RETRY_MS = 60000
  let pushRev = 0, pushRun = null, pushAgain = false, stateQ = Promise.resolve()   // pushRev：每有變動加一，用來判斷「送的途中又有變動」
  async function readPushState() { const v = await getStore().get("pushsync"); return v && typeof v === "object" ? v : {} }
  function patchPushState(patch) {   // 狀態的讀改寫排成一條隊，免得兩邊同時寫、舊的蓋掉新的
    stateQ = stateQ.then(async () => { await getStore().set("pushsync", Object.assign(await readPushState(), patch)) }).catch(() => {})
    return stateQ
  }
  async function syncPushOnce() {
    let sub = null
    try { sub = await pushSub() } catch (e) { await patchPushState({ tried: Date.now(), err: "訂閱失敗：" + (e && e.message || e), dirty: true }); return false }
    if (!sub) return false   // 沒啟用、還沒允許通知：不算失敗，什麼都不記（允許通知時會立刻同步）
    const rev = pushRev, now = Date.now(), items = []
    for (const r of await readRems()) {
      if (r.del || !r.due || r.done) continue
      const occ = []
      for (let k = 0; k < remDays(r); k++) { const t = occTime(r, k); if (t > now) occ.push(t) }   // 只送還沒到的；已經過去的不再補
      if (occ.length) items.push({ date: r.date, occ })
    }
    const ac = root.AbortController ? new root.AbortController() : null, timer = ac ? root.setTimeout(() => ac.abort(), PUSH_TIMEOUT_MS) : 0
    try {
      const res = await fetch(PUSH_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), items }), signal: ac ? ac.signal : undefined })
      if (res.ok) { await patchPushState({ last: Date.now(), tried: Date.now(), err: "", dirty: rev !== pushRev }); return true }   // 送的途中又有變動：dirty 留著，下一輪再送
      await patchPushState({ tried: Date.now(), err: "伺服器回應 " + res.status, dirty: true }); return false
    } catch (e) {
      await patchPushState({ tried: Date.now(), err: ac && ac.signal.aborted ? "連線逾時" : "沒有網路，或連不上伺服器", dirty: true }); return false
    } finally { if (timer) root.clearTimeout(timer) }
  }
  function syncPush() {   // 同一時間只送一個；送的途中又有變動，就在這個送完之後再送一次
    if (pushRun) { pushAgain = true; return pushRun }
    pushRun = syncPushOnce().catch(() => false).then(ok => { pushRun = null; if (pushAgain) { pushAgain = false; pushSoon(false) } return ok })
    return pushRun
  }
  let pushTimer = 0
  function pushSoon(changed) {   // 連續幾次變動合併成一次送出；changed 不是 false＝提醒有變動：先記下「還沒確認寄出」，萬一寄不出去才不會忘記
    if (!PUSH_URL || !root.setTimeout) return
    if (changed !== false) { pushRev++; patchPushState({ dirty: true }) }
    root.clearTimeout(pushTimer); pushTimer = root.setTimeout(syncPush, 1500)
  }
  async function pushRetry(force) {   // 有變動還沒寄成功的話補寄；force（剛有網路、剛回到日誌）不受「同一則最少隔 60 秒」限制
    if (!PUSH_URL) return
    const st = await readPushState()
    if (!st.dirty) return
    if (!force && Date.now() - (st.tried || 0) < PUSH_RETRY_MS) return
    syncPush()
  }
  async function pushStatusText() {   // 「提醒通知」視窗用：讓使用者確認伺服器有沒有收到
    const st = await readPushState(), p = n => String(n).padStart(2, "0")
    const when = t => { const d = new Date(t); return (d.toDateString() === new Date().toDateString() ? "今天 " : (d.getMonth() + 1) + "月" + d.getDate() + "日 ") + p(d.getHours()) + ":" + p(d.getMinutes()) }
    const lines = [st.last ? "上次成功寄給伺服器：" + when(st.last) : "還沒有成功寄給伺服器過。"]
    if (st.dirty) lines.push("有變動還沒寄出去，有網路時會自動補寄" + (st.err ? "（上次失敗：" + st.err + "）" : "") + "。")
    else if (st.last) lines.push("提醒時間已經同步到伺服器。")
    return lines.join("\n")
  }
  async function doRemSave(raw) {   // 提醒（設定、完成、取消）：存好，再把最新的提醒清單推回頁面
    let rec = null
    try { rec = cleanRem(JSON.parse(raw)) } catch (e) {}
    if (!rec) { say("提醒儲存失敗：資料不對"); return }
    const by = new Map((await readRems()).map(r => [r.date, r]))
    const ex = by.get(rec.date)
    if (!ex || rec.t >= (ex.t || 0)) by.set(rec.date, rec)
    await saveRems([...by.values()])
    await markFired([rec], Date.now())   // 設定當下已經過去的時間不補提醒
    await pushRems(rec.del ? "已取消提醒" : rec.done ? "已完成" : "已儲存提醒")
    if (!rec.del && !rec.done) remHint()
    remCheckSoon()
  }
  function remSettings() {   // 「⋯」→「提醒通知」：要在按下的當下請求權限（瀏覽器的規定）
    const N = root.Notification
    if (!N) { modal("提醒通知", "這個瀏覽器不能顯示系統通知。" + (isIOS() ? "\n\niPhone／iPad：要先用 Safari 把日誌「加入主畫面」，再從主畫面的圖示打開（iOS 16.4 以上）。" : "") + "\n\n沒有通知也能提醒：到期時日誌開著會直接跳出來；沒開著，下次打開時補上（兩天內）。", [{ label: "好", value: 1 }]); return }
    if (N.permission === "default") { Promise.resolve(N.requestPermission()).then(remStatus, remStatus); return }
    remStatus()
  }
  async function remStatus() {
    const N = root.Notification, ok = !!N && N.permission === "granted"
    let sync = ""
    if (ok && PUSH_URL) { await syncPush(); sync = "\n\n" + await pushStatusText() }   // 剛允許通知也在這裏馬上訂閱並同步（最多等 8 秒），顯示的才是最新狀況
    const v = await modal("提醒通知", (ok ? "通知已開啟。" : "通知沒有開啟。請到系統或瀏覽器的網站設定，把這個網站的通知改成「允許」。") +
      (PUSH_URL ? "\n\n日誌關閉時，由伺服器推播叫醒（到期後約 1 分鐘內）。" : "\n\n網頁版沒有辦法在日誌關閉時自己叫醒：到期時日誌開著（或還活在背景）才會即時提醒；沒開著，下次打開時補上（兩天內）。") + sync,
      ok ? [{ label: "送出測試通知", kind: "pri", value: "test" }, { label: "好", value: 1 }] : [{ label: "好", value: 1 }])
    if (v === "test") say(await showNote({ date: "test", title: "日誌提醒", body: "通知正常" }) ? "已送出測試通知" : "測試通知失敗")
  }
  function installRemMenu() {   // 頁面載入後呼叫：在「⋯」選單加一個「提醒通知」按鈕（找不到選單，或已經加過，就什麼都不做）
    try {
      const d = root.document, menu = d && d.querySelector && d.querySelector("#pd .menu")
      if (!menu || d.getElementById("remx")) return
      const b = d.createElement("button")
      b.className = "mi"; b.id = "remx"; b.type = "button"; b.setAttribute("data-lb", "提醒通知"); b.setAttribute("aria-label", "提醒通知設定"); b.title = "提醒通知"
      if (typeof root.ico === "function") b.insertAdjacentHTML("afterbegin", root.ico("bell"))
      b.onclick = () => { remSettings(); if (typeof root.pdClose === "function") root.pdClose() }
      menu.appendChild(b)
    } catch (e) {}
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
  const UNSUPPORTED = { loadphotos: "整年照片頁" }
  function actionOf(p) {   // 這個訊息要做什麼：同步（沒有任何動作參數）、打開連結、備份、還原，或還沒開放的動作名
    if (p.openurl) return "open"
    if (p.backup !== undefined) return "backup"
    if (p.backupphotos !== undefined) return "backupphotos"
    if (p.restorephotos !== undefined) return "restorephotos"   // 面板「照片」那排的「還原」：直接開選照片的視窗
    if (p.backuppdfs !== undefined) return "backuppdfs"
    if (p.restorepdfs !== undefined) return "restorepdfs"
    if (p.restore !== undefined) return "restore"
    if (p.addphoto) return "addphoto"
    if (p.addpdf) return "addpdf"
    if (p.delphoto) return "delphoto"
    if (p.movephoto) return "movephoto"
    if (p.wxcfg !== undefined) return "wxcfg"
    if (p.bkcfg !== undefined) return "bkcfg"
    if (p.remsave !== undefined) return "remsave"
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
    else if (act === "backupphotos") await doBackupPhotos(p.backupphotos)
    else if (act === "restorephotos") await doRestorePhotos()
    else if (act === "backuppdfs") await doBackupPdfs(p.backuppdfs)
    else if (act === "restorepdfs") await doRestorePdfs()
    else if (act === "restore") restored = await doRestore(p.restore)
    else if (act === "addphoto") await doAddPhotos(p.addphoto)
    else if (act === "addpdf") await doAddPdf(p.addpdf)
    else if (act === "delphoto") await doDelPhoto(p.delphoto)
    else if (act === "movephoto") await doMovePhoto(p.movephoto, p.to)
    else if (act === "remsave") await doRemSave(p.remsave)
    else if (act === "bkcfg") await doBkCfg(p.bkcfg)
    else if (act === "wxcfg") doWxCfg(p.wxcfg)   // 不等它做完：定位和查天氣可能要幾秒，結果做完會自己推回頁面
    else if (act !== "sync") say("「" + UNSUPPORTED[act] + "」在 PWA 版還沒開放")
    if (restored) { await pushCloud(); await pushRems(); remCheckSoon() }
  }
  let queue = Promise.resolve()   // 一個一個處理，免得連按兩下時互相蓋掉
  function handle(u) { queue = queue.then(() => run(u)).catch(e => say("出錯了：" + (e && e.message || e))); return queue }

  // ---------- 啟動：有資料就組頁；沒有就先請使用者匯入 ----------
  // ---------- 假期自動更新：讀同一個網站上的 holidays.json，交給頁面的 __holUpdate 補進假期表 ----------
  // holidays.json 由 GitHub Actions（.github/workflows/update-holidays.yml）定期從英國 GOV.UK 和香港 1823 抓回來；放在自己的網站上，不用跨網站抓（沒有跨網域的問題）。
  // 離線時 sw.js 會給上次存下來的那份；抓不到、格式不對都不理它，照用程式裡內建的假期表。
  async function holidaysUpdate() {
    try {
      if (typeof root.__holUpdate !== "function") return false
      const r = await root.fetch("holidays.json", { cache: "no-cache" })
      if (!r.ok) return false
      const j = await r.json()
      if (!j || typeof j !== "object" || j.v !== 1) return false
      root.__holUpdate(j)
      return true
    } catch (e) { return false }
  }
  async function launch() {
    const r = await fetch("diary_template.html", { cache: "no-cache" })
    if (!r.ok) throw new Error("讀不到 diary_template.html（" + r.status + "）")
    const s = getStore(), rows = await s.get("rows") || [], edits = await s.get("edits") || []
    let wx = {}, cfg
    try { const wst = await readWeather(); wx = weatherForPage(wst); cfg = { fcDays: W.fcDays, hotC: W.hotC } } catch (e) {}   // 天氣讀不到也照樣打開日誌
    let bk
    try { bk = await bkCfgForPage() } catch (e) {}   // 讀不到也照樣打開日誌（頁面就不顯示「自動備份」那一行）
    let tab = ""
    try { if (new root.URLSearchParams(root.location.search).get("tab") === "rem") tab = "rem" } catch (e) {}   // 點通知進來（網址帶 ?tab=rem）：直接打開提醒清單
    const html = assemble(await r.text(), rows, edits, { weather: wx, wxcfg: cfg, rems: await readRems(), tab, bkcfg: bk })
    root.document.open(); root.document.write(html); root.document.close()
    holidaysUpdate()   // 不等它：頁面先用內建的假期表打開，讀到新的再換上去
  }
  async function importFiles(files) {   // 讀 dataXXXX.json（可一次選好幾個）；回傳摘要
    const s = getStore(), found = [], wxs = [], remsIn = []
    for (const f of files) {
      let list
      try { list = JSON.parse(await f.text()) } catch (e) { throw new Error("「" + f.name + "」不是有效的 JSON") }
      if (isWxFile(list)) { wxs.push(list); continue }   // Scriptable 版的天氣檔（weather.json）：日誌資料之外另外收
      if (list && okKind(list.kind) && Array.isArray(list.days)) {   // 備份檔也可以直接當資料來源（例如搬到新裝置）
        if (Array.isArray(list.reminders)) for (const x of list.reminders) { const c = cleanRem(x); if (c && !c.del) remsIn.push(c) }   // 備份裏的提醒一起收
        list = list.days.filter(x => x && typeof x.text === "string").map(x => [x.date, "", x.text]).concat(list.pre ? [[list.year + "-00-00", "", list.pre, true]] : [])
      }
      if (!Array.isArray(list)) throw new Error("「" + f.name + "」的格式不對（應該是一列一列的日誌）")
      const ok = list.filter(validRow)
      if (!ok.length) throw new Error("「" + f.name + "」裏找不到日誌")
      found.push(...ok)
    }
    const rows = mergeRows(await s.get("rows") || [], found)
    await s.set("rows", rows)
    if (remsIn.length) { await saveRems(mergeRems(await readRems(), remsIn)); await markFired(remsIn, Date.now()) }
    const days = rows.filter(r => !r[3]).length, years = [...new Set(rows.map(r => r[0].slice(0, 4)))].sort()
    let wx = 0
    for (const imp of wxs) { const r = await wxTask(() => importWeatherData(imp)); wx += r.add + r.upg }
    return { days, years, wx, rem: remsIn.length }
  }
  // ---------- 匯入資料檔：補進「目前沒有」的日子（日誌頁「⋯」選單）----------
  // 編者按 / Editor's note：這個功能只「加」不「蓋」——日誌裏已經有的日子（包括改過、刪除過的）一律不動。不要改成和 importFiles 一樣「後來的蓋掉現有的」，那會蓋掉使用者已經改好的內容。
  //   This only ADDS days that are missing; it never overwrites an existing day (edited or deleted days included). Do not "simplify" it to importFiles' last-one-wins merge: that would clobber the user's existing edits.
  // 為什麼需要：還原只能還原「目前正在看的那一年」，而年份選單是依已匯入的資料產生的。改用主畫面 App 之後（它的儲存和 Safari 是分開的）如果只匯入了今年，就選不到其他年份；
  // 「第一次使用」的匯入畫面又只在完全沒有資料時才出現。所以在日誌頁補一個入口，把 data2025.json 或 2025 年的備份檔補進來。
  // 可選：dataXXXX.json（Scriptable 版的資料檔）、備份檔（.json，網頁版和 Scriptable 版的都行）；天氣檔（weather.json）也可以一起選：程式依內容自己分（日誌、備份、天氣），天氣檔走 importWeatherData（只收已經發生的日子）。照片不在這些檔案裏。
  async function planDataAdd(files) {   // 讀檔、算出「會加入什麼」；這一步不寫入任何東西。回傳 { add（要加的列）, rems（要加的提醒）, skip（已經有、略過的天數）, wxs（選到的天氣檔內容，由呼叫端另外匯入）, years（年 → 天數）}
    const s = getStore(), found = new Map(), remsIn = [], wxs = []
    for (const f of files) {   // 讀檔的規則和 importFiles 相同
      let list
      try { list = JSON.parse(await f.text()) } catch (e) { throw new Error("「" + f.name + "」不是有效的 JSON") }
      if (isWxFile(list)) { wxs.push(list); continue }   // 天氣檔：不是日誌，交給 importWeatherData
      if (list && okKind(list.kind) && Array.isArray(list.days)) {   // 備份檔
        if (Array.isArray(list.reminders)) for (const x of list.reminders) { const c = cleanRem(x); if (c && !c.del) remsIn.push(c) }
        list = list.days.filter(x => x && typeof x.text === "string").map(x => [x.date, "", x.text]).concat(list.pre ? [[list.year + "-00-00", "", list.pre, true]] : [])
      }
      if (!Array.isArray(list)) throw new Error("「" + f.name + "」的格式不對（應該是一列一列的日誌）")
      const ok = list.filter(validRow)
      if (!ok.length) throw new Error("「" + f.name + "」裏找不到日誌")
      for (const r of ok) found.set(rowKey(r), r)   // 同一天出現在好幾個檔案：後選的為準
    }
    const rows = await s.get("rows") || [], edits = await s.get("edits") || []
    const have = new Set(rows.map(rowKey)), touched = new Set(edits.map(e => e && e.date))   // touched＝改過或刪除過的日子（edits 裏有紀錄），也不碰
    const add = [], years = {}; let skip = 0
    for (const [k, r] of found) {
      if (have.has(k) || touched.has(r[0])) { if (!r[3]) skip++; continue }
      add.push(r)
      if (!r[3]) { const y = r[0].slice(0, 4); years[y] = (years[y] || 0) + 1 }
    }
    const addDates = new Set(add.map(r => r[0])), haveRem = new Set((await readRems()).map(r => r.date))
    const rems = mergeRems([], remsIn.filter(r => addDates.has(r.date) && !haveRem.has(r.date)))   // 只收「新加進來的那幾天」的提醒；那一天現有的提醒不動
    return { add, rems, skip, wxs, years }
  }
  async function commitDataAdd(p) {   // 把 planDataAdd 算好的寫進去：加日子；加提醒（已經過去的時間記成已提醒過，不補響）
    const s = getStore(), rows = await s.get("rows") || [], have = new Set(rows.map(rowKey))
    const add = p.add.filter(r => !have.has(rowKey(r)))   // 寫入前再檢查一次：這中間如果已經有了，就不蓋
    await s.set("rows", mergeRows(rows, add))
    if (p.rems.length) { await saveRems(mergeRems(await readRems(), p.rems)); await markFired(p.rems, Date.now()) }
    return add.length
  }
  function startDataImport() {   // 「匯入資料檔」按鈕按下的當下呼叫：先打開檔案選單（瀏覽器只准許在剛按下時打開），選完再算、再問。日誌資料檔、備份檔、天氣檔可以一起選，程式依內容自己分
    const d = root.document, inp = d.createElement("input")
    inp.type = "file"; inp.accept = ".json,application/json"; inp.multiple = true; inp.hidden = true
    inp.onchange = async () => {
      const fs = [...(inp.files || [])]; inp.remove()
      if (!fs.length) return
      try {
        const p = await planDataAdd(fs)   // 問答不放進訊息佇列：對話框開著的時候，頁面的同步、備份照常進行
        const yrs = Object.keys(p.years).sort().map(y => y + " 年 " + p.years[y] + " 天").join("、"), nWx = p.wxs.length
        const notes = p.skip ? "\n已經有的 " + p.skip + " 天不會動。" : ""
        if (!p.add.length) {
          if (nWx) {   // 只選了天氣檔：不用確認，直接匯入（和以前「匯入天氣」一樣）
            say("匯入天氣中…")
            const r = await importWxFiles(p.wxs)
            if (r.add || r.upg) pushWeather(r.st)
            say(wxImportMsg(r) + (p.skip ? "（日誌檔裏已經有的 " + p.skip + " 天沒動）" : ""), 7000)
            return
          }
          await modal("沒有需要加入的日子", "這些檔案裏沒有目前還沒有的日子，所以沒有動任何東西。" + notes, [{ label: "好", value: 1 }])
          return
        }
        const ok = await modal("加入這些日子？", "會加入：" + (yrs || "只有前言") + (p.rems.length ? "；提醒 " + p.rems.length + " 則" : "") + "。" + (nWx ? "\n另外選了 " + nWx + " 個天氣檔，會一併匯入。" : "") + notes +
          "\n加入後頁面會重新載入一次，請先確認沒有編輯到一半的卡片。", [{ label: "加入", kind: "pri", value: true }, { label: "取消", value: false }])
        if (!ok) { say("已取消，沒有加入任何東西"); return }
        await commitDataAdd(p)
        const wxLine = nWx ? "\n" + wxImportMsg(await importWxFiles(p.wxs)) : ""   // 重新載入之前先匯入：新組的頁面就帶著天氣
        await modal("已加入", (yrs || "前言") + "已經加進日誌。" + wxLine + "\n照片不在資料檔裏，有 .jpg 備份的話請到「照片」那排按「還原…」。\n按「好」會重新載入頁面。", [{ label: "好", kind: "pri", value: 1 }])
        await launch()   // 年份選單是組頁時依資料產生的，要重新組頁才看得到新的年份
      } catch (e) { say("匯入失敗：" + (e && e.message || e), 7000) }
    }
    inp.addEventListener("cancel", () => inp.remove())
    d.body.appendChild(inp); inp.click()
  }
  function installDataImport() {   // 頁面載入後呼叫：在「⋯」選單裏加一個「匯入資料檔」按鈕（找不到選單，或已經加過，就什麼都不做）
    try {
      const d = root.document, menu = d && d.querySelector && d.querySelector("#pd .menu")
      if (!menu || d.getElementById("dix")) return
      const b = d.createElement("button")
      b.className = "mi"; b.id = "dix"; b.type = "button"; b.setAttribute("data-lb", "匯入資料檔"); b.setAttribute("aria-label", "匯入資料檔：補進缺的年份或日子，也可以匯入天氣檔（已有的不會動）"); b.title = "補進缺的年份或日子，也可以匯入天氣檔（已有的不會動）"
      const ref = menu.querySelector("svg")   // 借用選單裏現有圖示的外框（class、大小），只換圖案；找不到（模板改過）就沒有圖示
      if (ref) { const ic = ref.cloneNode(false); ic.innerHTML = '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/></g>'; b.appendChild(ic) }
      b.onclick = () => { startDataImport(); if (typeof root.pdClose === "function") root.pdClose() }   // 先打開檔案選單（要在按下的當下），再收起選單
      menu.appendChild(b)
    } catch (e) {}
  }
  async function hasLocalData() {   // 啟動檢查：舊日誌、本機新寫的日子、提醒，有任何一項就直接進日誌
    const s = getStore(), rows = await s.get("rows")
    if (rows && rows.length) return true   // 舊日誌
    const edits = await s.get("edits")
    if (Array.isArray(edits) && edits.some(e => e && DATERE.test(e.date || "") && !e.del && !e.deleted && typeof e.text === "string" && e.text.trim() !== "")) return true   // 本機新寫的日子
    return (await readRems()).some(r => !r.del)   // 提醒
  }
  function showImport(el) {
    el.innerHTML = '<h1>生活日誌</h1><p>第一次使用：請選取日誌資料檔（<code>data2025.json</code>、<code>data2026.json</code> …，或之前備份的 <code>.json</code> 備份檔，可以一次選好幾個）；沒有資料檔就直接按「從空白開始」。資料只會存在這部裝置的瀏覽器裏，不會上傳到任何地方。</p>' +
      '<label class="btn">資料檔<input id="pick" type="file" accept=".json,application/json" multiple hidden></label><p id="msg"></p><button id="go" class="btn pri">從空白開始</button>'
    const msg = el.querySelector("#msg"), go = el.querySelector("#go")
    el.querySelector("#pick").onchange = async e => {
      msg.className = ""; msg.textContent = "匯入中…"
      try {
        const r = await importFiles([...e.target.files])
        msg.textContent = (r.days ? "已匯入 " + r.days + " 天（" + r.years.join("、") + " 年）" : "還沒有匯入日誌資料") + (r.wx ? "；天氣 " + r.wx + " 天" : "") + (r.rem ? "；提醒 " + r.rem + " 則" : ""); go.textContent = r.days ? "開始使用" : "從空白開始"
      } catch (err) { msg.className = "err"; msg.textContent = String(err.message || err) }
    }
    go.onclick = () => launch().catch(err => { msg.className = "err"; msg.textContent = String(err.message || err) })
  }
  async function boot() {
    try { if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist() } catch (e) {}   // 請瀏覽器別隨便清掉資料
    try { if ("serviceWorker" in root.navigator) root.navigator.serviceWorker.register("sw.js") } catch (e) {}
    const el = root.document.getElementById("boot")
    try {
      if (await hasLocalData()) await launch(); else showImport(el)
    } catch (e) { el.innerHTML = '<h1>生活日誌</h1><p class="err">打不開：' + String(e && e.message || e) + "</p>" }
  }

  const api = { pdfTools: { annSvg, annBox, annHit, annMove, buildPdf, pageText, findIn }, boot, launch, handle, startReminders, syncPush, installRemMenu, remCheck, doRemSave, readRems, saveRems, cleanRem, mergeRems, yearRems, dueOccurrence, remText, prePickPhotos, loadCardPhotos, prePickPdf, loadCardPdfs, installPdf, pdfHtml, addPdfFiles, readPdf, startWeather, startAutoBackup, autoBackupCheck, autoBackupItems, readAcIndex, deleteAutoCopies, bkCfgForPage, doBkCfg, installPhotoImport, startPhotoImport, askDate, addPhotoFiles, weatherForPage, importWeatherData, importWxFiles, isWxFile, wxRecord, applyWxCfg, readWeather, weatherUpdate, okName, dateOf, assemble, parse, mergeEdits, mergeRows, sortRows, readPushState, pushStatusText, pushRetry, importFiles, hasLocalData, isIOS, planDataAdd, commitDataAdd, startDataImport, installDataImport, validRow, effectiveDays, makeBackupBody, planRestore,
    get store() { return getStore() }, get W() { return W }, useStore(s) { store = s }, memStore }
  root.PwaHost = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof window !== "undefined" ? window : globalThis)

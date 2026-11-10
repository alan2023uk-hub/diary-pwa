// 抓英國（GOV.UK，英格蘭及威爾斯）和香港（1823）的官方公眾假期，存成 holidays.json。
// 由 GitHub Actions 定期執行（.github/workflows/update-holidays.yml）；網頁版打開時讀 holidays.json，補進假期表。
// 抓不到（或資料明顯不對）的那一組，保留上次的資料；兩組都失敗才讓工作失敗（GitHub 會寄信通知）。
// 只新增、更新，不刪舊的：1823 只保留近三年，舊年份靠上一次存下來的 holidays.json 留著。
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { pathToFileURL } from "node:url"

const OUT = "holidays.json"
const UK_URL = "https://www.gov.uk/bank-holidays.json"
const HK_URL = "https://www.1823.gov.hk/common/ical/tc.json"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MIN_EVENTS = 5   // 少於這個數目，視為抓到的不是正確資料

// 英國假期名稱（英文 → 日誌裡用的中文）；補假（notes 有 Substitute）加「（補假）」。對不上的保留英文原名並提醒。
export function ukName(title, notes) {
  const t = String(title || "").toLowerCase()
  let n = ""
  if (/funeral/.test(t)) n = "伊麗莎白二世女王國葬日"
  else if (/coronation/.test(t)) n = "查理三世加冕日"
  else if (/jubilee/.test(t)) n = "白金禧年假期"
  else if (/early may/.test(t)) n = /ve day|victory/.test(t) ? "五月初銀行假期（歐戰勝利紀念日）" : "五月初銀行假期"
  else if (/spring bank/.test(t)) n = "春季銀行假期"
  else if (/summer bank/.test(t)) n = "夏季銀行假期"
  else if (/new year/.test(t)) n = "元旦"
  else if (/good friday/.test(t)) n = "耶穌受難節"
  else if (/easter monday/.test(t)) n = "復活節星期一"
  else if (/christmas/.test(t)) n = "聖誕節"
  else if (/boxing/.test(t)) n = "節禮日"
  else return { name: String(title || "").trim(), known: false }
  if (/substitute/i.test(String(notes || "")) || /substitute/.test(t)) n += "（補假）"
  return { name: n, known: true }
}

export function parseUK(j) {
  const ev = j && j["england-and-wales"] && j["england-and-wales"].events
  if (!Array.isArray(ev)) throw new Error("GOV.UK：找不到 england-and-wales.events")
  const out = {}, unknown = []
  for (const e of ev) {
    if (!e || !DATE_RE.test(e.date || "")) continue
    const r = ukName(e.title, e.notes)
    if (!r.name) continue
    if (!r.known) unknown.push(e.date + " " + e.title)
    out[e.date] = r.name
  }
  return { map: out, unknown }
}

const ymdOf = s => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || "").replace(/-/g, "")); return m ? m[1] + "-" + m[2] + "-" + m[3] : "" }
const addDay = d => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10) }

export function parseHK(j) {
  const cal = j && Array.isArray(j.vcalendar) ? j.vcalendar[0] : null
  const ev = cal && cal.vevent
  if (!Array.isArray(ev)) throw new Error("1823：找不到 vcalendar[0].vevent")
  const out = {}
  for (const e of ev) {
    if (!e) continue
    const first = x => Array.isArray(x) ? x[0] : x
    const s = ymdOf(first(e.dtstart)), end = ymdOf(first(e.dtend)), name = String(e.summary || "").trim()
    if (!DATE_RE.test(s) || !name) continue
    let d = s
    for (let i = 0; i < 5; i++) {   // 一般一天一筆；dtend（不含當天）比開始晚兩天以上就逐天展開，最多五天
      out[d] = name
      d = addDay(d)
      if (!end || d >= end) break
    }
  }
  return { map: out, unknown: [] }
}

async function getJson(url) {
  let err
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000)
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "diary-pwa-holiday-updater", "Accept": "application/json" } })
        if (!r.ok) throw new Error("HTTP " + r.status)
        return JSON.parse((await r.text()).replace(/^\uFEFF/, ""))
      } finally { clearTimeout(timer) }
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 2000 * (i + 1))) }
  }
  throw err
}

const sortObj = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]))
const range = o => { const k = Object.keys(o).sort(); return k.length ? k[0] + " ~ " + k[k.length - 1] + "（" + k.length + " 筆）" : "（空）" }

export function mergeSets(prev, fresh) {   // 以新抓的為準，上次有、這次沒有的日期保留
  return sortObj(Object.assign({}, prev || {}, fresh || {}))
}

async function main() {
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { v: 1, updated: "", uk: {}, hk: {} }
  const next = { v: 1, updated: prev.updated || "", uk: prev.uk || {}, hk: prev.hk || {} }
  let okCount = 0
  for (const [key, label, url, parse] of [["uk", "英國 GOV.UK", UK_URL, parseUK], ["hk", "香港 1823", HK_URL, parseHK]]) {
    try {
      const r = parse(await getJson(url))
      if (Object.keys(r.map).length < MIN_EVENTS) throw new Error("只解析到 " + Object.keys(r.map).length + " 筆，資料格式可能變了")
      next[key] = mergeSets(prev[key], r.map)
      okCount++
      console.log(label + "：抓到 " + range(r.map) + "；合併後 " + range(next[key]))
      for (const u of r.unknown) console.log("::warning::" + label + " 有沒對照的名稱，暫時用英文原名：" + u)
    } catch (e) {
      console.log("::warning::" + label + " 更新失敗，保留上次的資料：" + (e && e.message || e))
    }
  }
  if (!okCount) { console.error("兩組資料都抓不到"); process.exit(1) }
  const same = JSON.stringify([prev.uk || {}, prev.hk || {}]) === JSON.stringify([next.uk, next.hk])
  if (same && existsSync(OUT)) { console.log("沒有變動，不寫檔"); return }
  next.updated = new Date().toISOString().slice(0, 10)
  writeFileSync(OUT, JSON.stringify(next, null, 1) + "\n")
  console.log("已寫入 " + OUT)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

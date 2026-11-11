// The briefs in the command view (지휘), always in reach: one line under the
// task box (📚 전체 브리프 first, then the newest five as chips; b, ⌥B,
// walks them), and a picked session's newest brief over both its looks.
// 📚 opens every brief in the panel beside the table, newest first, each
// with where it stands (결정 대기, 완료 and its result, 답함, 읽기). It
// replaced the line's 전체/접기, which only put three more recent chips on
// a line that scrolls sideways: the person found it meaningless, and the
// older briefs were not reachable from the office at all.
// Loaded before command.js, which calls these.

const BRIEF_CSS = `
/* One line, whatever the width: 📚 first, then the chips, scrolling sideways. */
#command .briefs { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; padding: 5px 12px; border-bottom: 2px solid rgba(59,42,53,.14); background: #fffaf0; overflow-x: auto; scrollbar-width: none; }
#command .briefs > * { flex: 0 0 auto; }
#command .briefs .bchip { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid rgba(59,42,53,.35); border-radius: 999px; background: #fff; padding: 0 8px; cursor: pointer; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command .briefs .bchip.sel { border-color: #2a2033; background: #fff3c4; }
#command .briefs .bchip.lib { background: #2a2033; color: #fff; border-color: #2a2033; max-width: none; }
#command .briefs .bchip.lib.sel { background: #e0793a; border-color: #e0793a; }
/* 📚: ~/briefs/index.html's look (bin/brief.py index), in the panel's width. */
#command .blib { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #f6f6f4; font: 13px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .blib .head { padding: 8px 12px 6px; border-bottom: 1px solid #e6e5e1; background: #f6f6f4; }
#command .blib .search { position: relative; display: block; }
#command .blib .search input { width: 100%; height: 28px; padding: 0 36px 0 10px; border: 1px solid #e6e5e1; border-radius: 10px; background: #fff; font: inherit; outline: none; }
#command .blib .search input:focus { border-color: #3b5bdb; box-shadow: 0 0 0 3px #e8edfd; }
#command .blib .kbd { position: absolute; right: 8px; top: 50%; translate: 0 -50%; font: 11px ui-monospace, Menlo, monospace; color: #9b9ba3; border: 1px solid #e6e5e1; border-radius: 6px; padding: 0 5px; }
/* One line each, scrolling sideways (as the brief line does): the panel is short beside the table. */
#command .blib .facets { display: flex; gap: 5px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-top: 6px; align-items: center; }
#command .blib .facets > * { flex: 0 0 auto; }
#command .blib .facet { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 1px solid #e6e5e1; border-radius: 999px; background: #fff; color: #6b6b73; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; cursor: pointer; }
#command .blib .facet small { color: #9b9ba3; font-variant-numeric: tabular-nums; }
#command .blib .facet[aria-pressed="true"] { background: #18181b; color: #f6f6f4; border-color: #18181b; }
#command .blib .facet[aria-pressed="true"] small { color: inherit; opacity: .7; }
#command .blib .facet.more { border-style: dashed; }
#command .blib .sep { width: 1px; height: 16px; background: #e6e5e1; }
#command .blib .cnt { display: flex; gap: 8px; align-items: baseline; justify-content: flex-end; margin-top: 2px; min-height: 18px; }
#command .blib .count { font-size: 12px; color: #9b9ba3; font-variant-numeric: tabular-nums; }
#command .blib .clear { font: 12px -apple-system, sans-serif; color: #3b5bdb; background: none; border: 0; cursor: pointer; padding: 2px; }
#command .blib .list { flex: 1; overflow: auto; padding: 0 12px 16px; }
#command .blib .day h3 { display: flex; align-items: baseline; gap: 6px; margin: 14px 2px 6px; font-size: 13px; font-weight: 600; }
#command .blib .day h3 small { color: #9b9ba3; font-weight: 500; }
#command .blib .card { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; margin: 0 0 6px; padding: 9px 12px; background: #fff; border: 1px solid #e6e5e1; border-radius: 12px; cursor: pointer; font: inherit; color: #18181b; }
#command .blib .card:hover, #command .blib .card.sel { border-color: #3b5bdb; }
#command .blib .card.done { border-left: 4px solid #2f9e6c; }
#command .blib .card.pending { border-left: 4px solid #e0793a; }
#command .blib .card .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#command .blib .card .topic { font-size: 11px; font-weight: 600; color: #3b5bdb; background: #e8edfd; border-radius: 6px; padding: 0 6px; }
#command .blib .card .pend { font-size: 11px; font-weight: 600; color: #fff; background: #e0793a; border-radius: 6px; padding: 0 6px; }
#command .blib .card .donebadge { font-size: 11px; font-weight: 600; color: #1f7a50; background: #2f9e6c22; border-radius: 6px; padding: 0 6px; }
#command .blib .card .answered { font-size: 11px; color: #9b9ba3; border: 1px dashed #e6e5e1; border-radius: 6px; padding: 0 5px; }
#command .blib .card .tt { font-weight: 600; font-size: 13.5px; }
#command .blib .card p { margin: 0; font-size: 12px; color: #6b6b73; }
#command .blib .card p.res { color: #2f9e6c; font-weight: 600; }
#command .blib .card p.ask { color: #b2541b; }
#command .blib .empty { margin-top: 30px; text-align: center; color: #9b9ba3; }
#command .donefoot { margin-top: 10px; border-top: 2px dashed rgba(59,42,53,.18); padding-top: 6px; }
#command .donefoot h3 { margin: 0 0 4px; }
#command .donefoot h3 .alldone { float: right; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; color: #1a5fb4; background: none; border: 0; cursor: pointer; padding: 0; }
#command .donefoot .dn { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; border-left: 3px solid #2f9e6c; padding: 2px 8px; margin-bottom: 2px; cursor: pointer; font: 12.5px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .donefoot .dn:hover, #command .donefoot .dn.sel { background: #f1faf1; }
#command .donefoot .dn .t { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
#command .donefoot .dn .r { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #1f7a50; }
#command .donefoot .dn .m { color: #7a7090; }
#command .sbrief { padding: 4px 12px; border-bottom: 1px dashed rgba(59,42,53,.18); background: #fffaf0; }
#command .sbrief:empty { display: none; }
#command .briefb { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid var(--line); border-radius: 999px; background: #fff3c4; padding: 0 8px; margin-top: 3px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: BRIEF_CSS }))

// The brief line under the box: 📚 전체 브리프 (the panel with every brief),
// then the newest briefs (/command's recent, newest first), a chip each.
const BRIEF_CHIPS = 5
const cmdBriefs = () => (cmd.data?.recent || []).slice(0, BRIEF_CHIPS)
function cmdRenderBriefs() {
  const el = cmdEl.querySelector('.briefs')
  if (!el) return
  const bs = cmdBriefs(), left = el.scrollLeft, sel = cmd.sel?.path || '', lib = !!cmd.sel?.library
  el.innerHTML = '<button class="bchip lib' + (lib ? ' sel' : '') + '" data-lib="1" title="모든 브리프를 날짜순으로 (결정 대기 · 완료 표시)">📚 전체 브리프' + (blib.data ? ' ' + blib.data.total : '') + '</button>'
    + '<span class="m" title="b · TWeb에서는 ⌥B로 차례로 열기">최근 <span class="key">B</span></span>'
    + (bs.length ? bs.map((b) => '<button class="bchip' + (sel === b.path ? ' sel' : '') + '" data-brief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.title + ' · ' + b.file) + '">' + (b.done ? '✅ ' : b.pending ? '⏳ ' : '') + cmdEsc(b.title) + '</button>').join('') : '<span class="m">없음</span>')
  // The 3 s redraw keeps where the line was scrolled; a newly picked chip
  // comes into view, and anything else picked brings back its start (📚).
  el.scrollLeft = left
  const on = el.querySelector('.bchip.sel')
  if (el.dataset.sel !== sel) el.scrollLeft = on ? Math.max(0, on.offsetLeft - el.clientWidth + on.offsetWidth + 12) : 0
  el.dataset.sel = sel
}

// ✅ 최근 완료 under the table: briefs marked done (`brief done`; /command's
// `done`, newest first), as ~/briefs/index.html shows them: the newest
// DONE_SHOWN done in the last day, one line each (title, result, when),
// and 완료 N개 모두, which opens 📚 on its 완료 filter. A row's links and
// its undo command are on the brief itself (its done banner). The person:
// "최근 완료가 너무 길어서 불편하다" (13 rows of three lines, 1052 px).
const DONE_SHOWN = 3
const cmdDone = () => cmd.data?.done || []
function doneFoot() {
  const all = cmdDone()
  const fresh = all.filter((d) => !d.old)
  if (!fresh.length) return ''
  const sel = cmd.sel?.path || ''
  const row = (d) => '<div class="dn' + (sel === d.path ? ' sel' : '') + '" data-dbrief="' + cmdEsc(d.path) + '" data-title="' + cmdEsc(d.title) + '" title="' + cmdEsc(d.title + ' — ' + d.result) + '">'
    + '<span class="t">' + cmdEsc(d.title) + '</span><span class="r">' + cmdEsc(d.result) + '</span><span class="m">' + cmdEsc(cmdAgo(d.at)) + '</span></div>'
  return '<div class="donefoot"><h3>✅ 최근 완료 <span class="m">24시간 ' + fresh.length + '</span>'
    + (all.length > Math.min(fresh.length, DONE_SHOWN) ? '<button class="alldone" data-dall="1" title="📚 전체 브리프의 완료 필터로">완료 ' + all.length + '개 모두</button>' : '') + '</h3>'
    + fresh.slice(0, DONE_SHOWN).map(row).join('') + '</div>'
}

// A click in the list on one of the ✅ rows; false when it was not one.
function doneClick(ev) {
  const t = ev.target
  if (t.closest('[data-dall]')) {
    blib.only = 'done'; blib.topic = ''; blib.q = ''; blib.key = null
    cmd.sel = { library: true }; cmd.row = null; cmd.armed = null; cmd.q = null; blib.at = 0
    cmdRender()
    return true
  }
  const b = t.closest('[data-dbrief]')
  if (b) { cmdPick({ file: b.dataset.dbrief.split('/').pop(), path: b.dataset.dbrief, title: b.dataset.title }); cmdRender(); return true }
  return false
}

function cmdBriefClick(ev) {
  const b = ev.target.closest('button')
  if (!b) return
  if (b.dataset.lib) return blibToggle()
  cmdPick({ file: b.dataset.brief.split('/').pop(), path: b.dataset.brief, title: b.dataset.title })
  cmdRender()
}

// 📚 전체 브리프: the panel beside the table (cmd.sel = { library }) with
// every brief, laid out as ~/briefs/index.html is (keyolk/briefs `brief
// index`): a search box (/ to it), the topic facets with their counts, n /
// total and 필터 지우기, then the briefs by day (오늘, 어제, 11월 10일 (월)),
// each a card with its topic, its state (결정 대기 · ✅ 완료 · 답함) and its
// description or result. /briefs.json is `brief list --json`, the records
// the index is made of, and the match is the index's: the search text
// contains the words, the topic is the one pressed. The office adds one
// thing the index puts at its top instead: a state filter (⏳ 결정 대기 N,
// ✅ 완료 N), since the person comes here for those. A card opens that brief
// where a brief opens; ← 📚 on its bar comes back.
const blib = { data: null, at: 0, q: '', topic: '', only: '', more: false, key: null, loading: false }
const BLIB_STATE = { pending: ['⏳', '결정 대기'], done: ['✅', '완료'], answered: ['☑', '답함'], read: ['📄', '읽기'] }
const BLIB_FACETS = 12  // topics on the line before 더 보기 (it scrolls sideways); the index shows all
async function blibLoad(force = false) {
  if (!force && blib.data && Date.now() - blib.at < 30000) return blib.data
  try {
    const r = await fetch('/briefs.json')
    if (r.ok) { blib.data = await r.json(); blib.at = Date.now() }
  } catch {}
  return blib.data
}
function blibToggle() {
  if (cmd.sel && cmd.sel.library) cmd.sel = null
  else { cmd.sel = { library: true }; cmd.row = null; cmd.armed = null; cmd.q = null; blib.at = 0 }
  cmdRender()
}
// The index's match (bin/brief.py index: apply()), and the state filter.
function blibMatch(b) {
  const v = blib.q.trim().toLowerCase()
  return (!v || String(b.search || '').includes(v)) && (!blib.topic || b.topic === blib.topic) && (!blib.only || b.state === blib.only)
}
const blibItems = (d = blib.data) => (d?.items || []).filter(blibMatch)
const blibFiltered = () => !!(blib.q.trim() || blib.topic || blib.only)
// 오늘, 어제, 11월 10일 (월), or 2025. 3. 1. for another year: the index's day_label.
function blibDay(iso, today = new Date()) {
  const [y, m, d] = iso.split('-').map(Number), dd = new Date(y, m - 1, d)
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const delta = Math.round((t0 - dd) / 86400000)
  if (delta === 0) return '오늘'
  if (delta === 1) return '어제'
  return y === today.getFullYear() ? m + '월 ' + d + '일 (' + '일월화수목금토'[dd.getDay()] + ')' : y + '. ' + m + '. ' + d + '.'
}
function blibCard(b, sel) {
  const badge = b.state === 'pending' ? '<span class="pend">결정 대기</span>' : b.state === 'done' ? '<span class="donebadge">✅ 완료</span>' : b.state === 'answered' ? '<span class="answered">답함</span>' : ''
  const sub = b.state === 'pending' && b.ask ? '<p class="ask">❓ ' + cmdEsc(b.ask) + '</p>' : b.state === 'done' && b.result ? '<p class="res">✅ ' + cmdEsc(b.result) + '</p>' : b.desc ? '<p class="ds">' + cmdEsc(b.desc) + '</p>' : ''
  return '<button class="card ' + cmdEsc(b.state) + (sel === b.path ? ' sel' : '') + '" data-lbrief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.file) + '">'
    + '<span class="meta"><span class="topic">' + cmdEsc(b.topic || '기타') + '</span>' + badge + '</span>'
    + '<span class="tt">' + cmdEsc(b.title) + '</span>' + sub + '</button>'
}
function blibHtml(d = blib.data) {
  if (!d) return '<div class="m" style="padding:8px">불러오는 중…</div>'
  const items = blibItems(d), sel = cmd.libFrom || ''
  if (!items.length) return '<p class="empty">조건에 맞는 브리프가 없습니다.</p>'
  const days = []
  for (const b of items) {
    if (!days.length || days[days.length - 1].d !== b.date) days.push({ d: b.date, bs: [] })
    days[days.length - 1].bs.push(b)
  }
  return days.map((g) => '<section class="day"><h3><span>' + cmdEsc(blibDay(g.d)) + '</span><small>' + g.bs.length + '</small></h3>' + g.bs.map((b) => blibCard(b, sel)).join('') + '</section>').join('')
}
// The bar over the list: facets (topics, folded past BLIB_FACETS; the state
// filter on its own line), the count and 필터 지우기.
function blibFacets(d = blib.data) {
  const topics = d?.topics || [], c = d?.counts || {}
  const shown = blib.more ? topics : topics.slice(0, BLIB_FACETS)
  if (blib.topic && !shown.some(([k]) => k === blib.topic)) shown.push(topics.find(([k]) => k === blib.topic) || [blib.topic, 0])
  const n = d ? blibItems(d).length : 0
  return '<div class="facets">' + ['pending', 'done'].map((k) => '<button class="facet st" data-lonly="' + k + '" aria-pressed="' + (blib.only === k) + '">' + BLIB_STATE[k][0] + ' ' + BLIB_STATE[k][1] + '<small>' + (c[k] || 0) + '</small></button>').join('')
    + '<span class="sep"></span>'
    + shown.map(([k, v]) => '<button class="facet" data-ltopic="' + cmdEsc(k) + '" aria-pressed="' + (blib.topic === k) + '">' + cmdEsc(k) + '<small>' + v + '</small></button>').join('')
    + (topics.length > BLIB_FACETS ? '<button class="facet more" data-lmore="1">' + (blib.more ? '접기' : '주제 ' + (topics.length - BLIB_FACETS) + '개 더') + '</button>' : '') + '</div>'
    + '<div class="cnt"><span class="count">' + (d ? (blibFiltered() ? n + ' / ' + d.total : d.total + '개') : '') + '</span>'
    + (blibFiltered() ? '<button class="clear" data-lclear="1">필터 지우기</button>' : '') + '</div>'
}
function blibRenderDoc(bar, doc, dec) {
  if (cmd.frame !== 'library') {
    cmd.frame = 'library'
    bar.innerHTML = '<b>📚 전체 브리프</b><span class="m">날짜순 · / 로 찾기</span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="blib"><div class="head"><label class="search"><input type="search" placeholder="제목, 주제, 요약, 세션 ID" autocomplete="off"><span class="kbd">/</span></label><div class="fx"></div></div><div class="list"></div></div>'
    const input = doc.querySelector('input')
    input.value = blib.q
    input.oninput = () => { blib.q = input.value; blib.key = null; blibRenderDoc(bar, doc, dec) }
    // Esc in the box: the index's (clear what is typed, then leave the box).
    input.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (input.value) { input.value = ''; blib.q = ''; blib.key = null; blibRenderDoc(bar, doc, dec) } else input.blur() } }
    doc.onclick = blibClick
    dec.dataset.key = ''
    dec.innerHTML = ''
    dec.style.display = 'none'
    blib.key = null
  }
  // The view redraws every 3 s; the list is fetched again at most every 30 s.
  if (!blib.loading && (!blib.data || Date.now() - blib.at > 30000)) {
    blib.loading = true
    blibLoad(true).finally(() => { blib.loading = false; if (cmd.sel?.library) { cmdRenderDoc(); cmdRenderBriefs() } })
  }
  const fx = doc.querySelector('.fx'), fh = blibFacets()
  if (fx.dataset.key !== fh) { fx.dataset.key = fh; fx.innerHTML = fh }
  const h = blibHtml()
  if (h === blib.key) return
  blib.key = h
  const list = doc.querySelector('.list'), keep = list.scrollTop
  list.innerHTML = h
  list.scrollTop = keep
}
// / in the panel: to the search box, as on the index.
function blibSlash(e) {
  if (!cmd.sel?.library) return false
  const i = cmdEl.querySelector('.blib input')
  if (!i || document.activeElement === i) return false
  e.preventDefault(); i.focus(); i.select()
  return true
}
function blibClick(ev) {
  const t = ev.target
  const tp = t.closest('[data-ltopic]')
  if (tp) { blib.topic = blib.topic === tp.dataset.ltopic ? '' : tp.dataset.ltopic; blib.key = null; cmdRenderDoc(); return }
  const st = t.closest('[data-lonly]')
  if (st) { blib.only = blib.only === st.dataset.lonly ? '' : st.dataset.lonly; blib.key = null; cmdRenderDoc(); return }
  if (t.closest('[data-lmore]')) { blib.more = !blib.more; cmdRenderDoc(); return }
  if (t.closest('[data-lclear]')) {
    blib.q = ''; blib.topic = ''; blib.only = ''; blib.key = null
    const i = cmdEl.querySelector('.blib input'); if (i) i.value = ''
    cmdRenderDoc(); return
  }
  const b = t.closest('[data-lbrief]')
  if (!b) return
  cmd.libFrom = b.dataset.lbrief
  cmdPick({ file: b.dataset.lbrief.split('/').pop(), path: b.dataset.lbrief, title: b.dataset.title, fromLib: true })
  cmdRender()
}

// b (⌥B, ⇧ backwards): the next brief of the line opens where a brief does;
// from anything else, the newest. No brief: the key is the floor's.
function cmdBriefWalk(e) {
  const bs = cmdBriefs()
  if (!bs.length) return false
  e.preventDefault()
  const at = bs.findIndex((b) => cmd.sel && cmd.sel.path === b.path), d = e.shiftKey ? -1 : 1
  const b = bs[at < 0 ? (d > 0 ? 0 : bs.length - 1) : (at + d + bs.length) % bs.length]
  cmdPick({ file: b.path.split('/').pop(), path: b.path, title: b.title })
  cmdRender()
  return true
}

// The newest brief a picked session is recorded on: what it asks says it
// (/command?sid=), else its row in the table.
function cmdSessionBrief(sid) {
  if (cmd.ask && cmd.ask.sid === sid && cmd.ask.brief) return cmd.ask.brief
  return cmdWorkers().find((x) => x.w.sid === sid)?.w.brief || null
}

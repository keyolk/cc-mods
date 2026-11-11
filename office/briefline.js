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
#command .blib { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#command .blib .head { display: flex; gap: 6px; align-items: center; padding: 6px 12px; border-bottom: 1px solid rgba(59,42,53,.14); flex-wrap: wrap; }
#command .blib .head input { flex: 1; min-width: 8em; font: 13px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid var(--line); border-radius: 8px; padding: 2px 8px; }
#command .blib .head button { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid rgba(59,42,53,.35); border-radius: 999px; background: #fff; padding: 0 8px; cursor: pointer; }
#command .blib .head button.on { background: #2a2033; color: #fff; border-color: #2a2033; }
#command .blib .list { flex: 1; overflow: auto; padding: 4px 8px 12px; }
#command .blib .day { font: 600 12px -apple-system, sans-serif; color: #7a7090; margin: 8px 4px 2px; }
#command .blib .it { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px dashed rgba(59,42,53,.14); background: none; padding: 4px 6px; cursor: pointer; font: 13px/1.4 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .blib .it:hover, #command .blib .it.sel { background: #fff3c4; }
#command .blib .it .s { display: block; font-size: 11.5px; color: #7a7090; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command .blib .it.pending { box-shadow: inset 3px 0 0 #e0793a; }
#command .donefoot { margin-top: 10px; border-top: 2px dashed rgba(59,42,53,.18); padding-top: 6px; }
#command .donefoot h3 { margin: 0 0 4px; }
#command .donefoot .dn { border: 2px solid #8fbf8f; border-radius: 10px; background: #f1faf1; padding: 5px 8px; margin-bottom: 5px; font: 12px/1.45 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .donefoot .dn.sel { border-color: #2a2033; }
#command .donefoot .dn .t { font-size: 13px; cursor: pointer; }
#command .donefoot .dn .r { margin: 2px 0; }
#command .donefoot .dn a { word-break: break-all; margin-right: 8px; }
#command .donefoot .dn button { font: inherit; font-size: 11px; border: 2px solid var(--line); border-radius: 999px; background: #fff; padding: 0 8px; cursor: pointer; }
#command .donefoot .fold { cursor: pointer; color: #7a7090; font-size: 12px; }
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
// `done`, newest first): the result in one line, its links, and the command
// that undoes it, one press to copy. One done more than a day ago (`old`)
// is folded; a brief only answered is not here (it has no ✅ on its chip).
const briefDone = { open: false }
const cmdDone = () => cmd.data?.done || []
function doneFoot() {
  const all = cmdDone()
  if (!all.length) return ''
  const fresh = all.filter((d) => !d.old), old = all.filter((d) => d.old), sel = cmd.sel?.path || ''
  const row = (d) => '<div class="dn' + (sel === d.path ? ' sel' : '') + '"><div class="t" data-dbrief="' + cmdEsc(d.path) + '" data-title="' + cmdEsc(d.title) + '" title="브리프 열기">✅ ' + cmdEsc(d.title) + ' <span class="m">' + cmdEsc(cmdAgo(d.at)) + (d.by ? ' · ' + cmdEsc(d.by) : '') + '</span></div>'
    + '<div class="r">' + cmdEsc(d.result) + '</div>'
    + ((d.links || []).length || d.revert ? '<div>' + (d.links || []).map((l) => '<a href="#" data-dlink="' + cmdEsc(l) + '">' + cmdEsc(l.replace(/^https?:\/\//, '')) + '</a>').join('') + (d.revert ? '<button data-drevert="' + cmdEsc(d.revert) + '" title="' + cmdEsc(d.revert) + '">↩ 되돌리기 명령 복사</button>' : '') + '</div>' : '')
    + '</div>'
  return '<div class="donefoot"><h3>✅ 최근 완료 <span class="m">' + all.length + '건 · 답을 실행하고 결과를 확인한 브리프</span></h3>'
    + fresh.map(row).join('')
    + (old.length ? '<div class="fold" data-dfold="1">' + (briefDone.open ? '▾' : '▸') + ' 24시간 지난 완료 ' + old.length + '</div>' + (briefDone.open ? old.map(row).join('') : '') : '')
    + '</div>'
}

// A click in the list on one of the ✅ rows; false when it was not one.
function doneClick(ev) {
  const t = ev.target
  const f = t.closest('[data-dfold]')
  if (f) { briefDone.open = !briefDone.open; cmdRender(); return true }
  const r = t.closest('[data-drevert]')
  if (r) { authCopy(r.dataset.drevert).then((ok) => toast(ok ? '↩ 되돌리기 명령을 복사했습니다' : '복사하지 못했습니다')); return true }
  const l = t.closest('a[data-dlink]')
  if (l) {
    ev.preventDefault()
    const v = l.dataset.dlink
    if (/(^|\/)briefs\/\d{4}-\d{2}-\d{2}-[\w.-]+\.html$/.test(v)) { cmdPick({ file: v.split('/').pop(), path: v, title: v.split('/').pop() }); cmdRender() }
    else window.open(v, '_blank', 'noopener')
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
// every brief (/briefs.json, office/command.py library), newest first by
// day. A filter box and the states to show; a row opens that brief where a
// brief opens, and ← 전체 브리프 on its bar (cmdBriefBar) comes back.
const blib = { data: null, at: 0, q: '', only: '', key: null, loading: false }
const BLIB_STATE = { pending: ['⏳', '결정 대기'], done: ['✅', '완료'], answered: ['☑', '답함'], read: ['📄', '읽기'] }
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
// The rows that pass the filter and the state picked.
function blibItems(d = blib.data) {
  const q = blib.q.trim().toLowerCase()
  return (d?.items || []).filter((b) => (!blib.only || b.state === blib.only) && (!q || (b.title + ' ' + b.file + ' ' + (b.result || '') + ' ' + (b.ask || '')).toLowerCase().includes(q)))
}
function blibHtml(d = blib.data) {
  if (!d) return '<div class="m" style="padding:8px">불러오는 중…</div>'
  const items = blibItems(d), sel = cmd.libFrom || ''
  if (!items.length) return '<div class="m" style="padding:8px">맞는 브리프가 없습니다.</div>'
  let day = '', out = ''
  for (const b of items) {
    if (b.date !== day) { day = b.date; out += '<div class="day">' + cmdEsc(day) + '</div>' }
    const [icon, word] = BLIB_STATE[b.state] || ['📄', '']
    const sub = b.state === 'pending' ? '❓ ' + (b.ask || '') : b.state === 'done' ? b.result || '' : word
    out += '<button class="it ' + cmdEsc(b.state) + (sel === b.path ? ' sel' : '') + '" data-lbrief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.file) + '">' + icon + ' ' + cmdEsc(b.title) + '<span class="s">' + cmdEsc(sub) + '</span></button>'
  }
  return out
}
function blibRenderDoc(bar, doc, dec) {
  if (cmd.frame !== 'library') {
    cmd.frame = 'library'
    bar.innerHTML = '<b>📚 전체 브리프</b><span class="m"></span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="blib"><div class="head"><input type="search" placeholder="제목·결과로 찾기"></div><div class="list"></div></div>'
    const input = doc.querySelector('input')
    input.value = blib.q
    input.oninput = () => { blib.q = input.value; blib.key = null; blibRenderDoc(bar, doc, dec) }
    input.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); input.blur() } }
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
  const d = blib.data, c = d?.counts || {}
  const head = doc.querySelector('.head')
  const chips = '<button data-lonly="" class="' + (blib.only ? '' : 'on') + '">전체 ' + (d ? d.total : '') + '</button>'
    + Object.entries(BLIB_STATE).map(([k, [icon, word]]) => '<button data-lonly="' + k + '" class="' + (blib.only === k ? 'on' : '') + '">' + icon + ' ' + word + ' ' + (c[k] || 0) + '</button>').join('')
  if (head.dataset.key !== chips) { head.dataset.key = chips; head.querySelectorAll('button').forEach((b) => b.remove()); head.insertAdjacentHTML('beforeend', chips) }
  bar.querySelector('.m').textContent = d ? (c.pending ? '결정 대기 ' + c.pending + ' · ' : '') + '날짜순 · 누르면 열림' : ''
  const h = blibHtml(d)
  if (h === blib.key) return
  blib.key = h
  const list = doc.querySelector('.list'), keep = list.scrollTop
  list.innerHTML = h
  list.scrollTop = keep
}
function blibClick(ev) {
  const f = ev.target.closest('[data-lonly]')
  if (f) { blib.only = f.dataset.lonly; blib.key = null; cmdRenderDoc(); return }
  const b = ev.target.closest('[data-lbrief]')
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

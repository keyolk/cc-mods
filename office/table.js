// The command view's table (지휘): a row a session, its cells overlaying
// what it holds — ❓N decisions its briefs ask, 🙋 waiting on an answer or an
// approval, 🔎N finished work put up for a look, 📨/🚨N slx triggers (a Slack
// mention, a Meerkat incident) on it or of its own, ⚙ at work, ✓ quiet — and how
// long it has waited. /command's `table` (office/turn.py) gives the rows and
// their order; each row only names what it holds, and the details come from
// `pending`, `calls` and `reviews`, so an answer that takes one out shows at
// once. Rows that need the person come first; the rest fold into one line,
// 👷 그 밖 N.
//
// A picked row opens beside the panel with a tab for each thing it holds:
// [❓결정 N] [🙋대기] [🔎검토 N] [📨 slx N], then [마지막 답] (when it waits on nobody)
// and [카드]; the most urgent opens first. Tab / ⇧Tab (⌥[ ⌥] in TWeb's
// normal mode) move between them, j/k between the rows that need the person.
// An answer goes on to the row's next need, else to the next row.
// A session is named by what it was doing (its summary; /command falls back
// to its repository and first prompt), its slug a small grey tag: the person
// could not tell `ops-k8s-4a` from its slug alone. Loaded before command.js.

const TABLE_CSS = `
#command .tblwrap { max-height: 50vh; overflow: auto; margin-bottom: 10px; border: 2px solid rgba(59,42,53,.14); border-radius: 10px; background: #fff; }
#command table.turn { margin: 0; table-layout: fixed; }
#command table.turn td { padding: 4px 6px; cursor: pointer; }
#command table.turn td.who { overflow: hidden; }
#command table.turn td.who b { font-weight: 600; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command table.turn td.who .m { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command table.turn td.st { width: 7.5em; white-space: nowrap; }
#command table.turn td.ago { width: 3.2em; text-align: right; color: #7a7090; white-space: nowrap; }
#command table.turn tr:hover td { background: #f3ecdf; }
#command table.turn tr.sel td { background: #fff3c4; }
#command table.turn tr.more td { color: #7a7090; text-decoration: underline; }
#command table.turn tr.other td { opacity: .8; }
#command table.turn td.who .slug { margin-left: 0; }
#command table.turn .end { font: 11px -apple-system, sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 5px; cursor: pointer; margin-left: 4px; }
#command .rtabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 12px 0; border-bottom: 2px solid var(--line); background: #fffaf0; }
#command .rtabs:empty { display: none; }
#command .rtabs button { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid rgba(59,42,53,.35); border-bottom: 0; border-radius: 8px 8px 0 0; background: #fff; padding: 2px 9px; cursor: pointer; }
#command .rtabs button.on { background: #2a2033; color: #fff; border-color: #2a2033; }
#command .rtabs .who { align-self: center; margin-right: 6px; font: 600 12.5px -apple-system, "Apple SD Gothic Neo", sans-serif; max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: TABLE_CSS }))

// othersOpen: the rows waiting on nobody unfolded.
const tbl = { othersOpen: false }
// A row's name for the person, and its slug when that says something else.
const tblName = (r) => r.summary || r.name || (r.sid || '').slice(0, 8)
const tblSlug = (r) => (r.summary && r.name && r.summary !== r.name ? r.name : '')

// The rows, resolved against what /command holds now: { row, ds (decisions),
// c (the call, unless answered in the last minute), rs (review items), needs }.
// A server from before `table`: a row per decision, per waiting session, per
// review item, in that order, then the coordinators and their workers.
function tblAll() {
  const d = cmd.data || {}
  const raw = d.table || tblLegacy(d)
  return raw.map((row) => {
    const ds = (row.decisions || []).map(cmdPending).filter(Boolean)
    const c0 = row.call && row.sid ? cmdCall(row.sid) : null
    const c = c0 && Date.now() - (cmd.sent[c0.sid] || 0) > 60000 ? c0 : null
    const rs = cmdRev() ? (row.reviews || []).map(([co, id]) => revList().find((r) => r.coord === co && r.id === id)).filter(Boolean) : []
    // A trigger rides on its session's row; with none it is the row.
    const xs = tblSlxOn() ? (row.slx || []).map((id) => (slxData().items || []).find((x) => x.id === id)).filter(Boolean) : []
    const own = String(row.key).startsWith('x:')
    return { row, ds, c, rs, xs, needs: !!(ds.length || c || rs.length || (own && xs.length)) }
  })
}
function tblLegacy(d) {
  const rows = [
    ...(d.pending || []).map((p) => ({ key: 'b:' + p.file, name: p.title, decisions: [p.file], reviews: [] })),
    ...(d.calls || []).map((c) => ({ key: 's:' + c.sid, sid: c.sid, name: c.slug || c.name, summary: c.summary, call: true, decisions: [], reviews: [], live: true })),
    ...(cmdRev() ? revList() : []).map((r) => ({ key: 'r:' + r.coord + '|' + r.id, name: r.id, decisions: [], reviews: [[r.coord, r.id]] })),
    ...(tblSlxOn() ? slxTurn() : []).map((x) => ({ key: 'x:' + x.id, name: x.from || x.id, decisions: [], reviews: [], slx: [x.id] })),
  ]
  // A trigger whose session has a row rides on it.
  for (const x of tblSlxOn() ? (slxData().items || []).filter((y) => y.merged && y.sid) : []) {
    const r = rows.find((y) => y.sid === x.sid)
    if (r) r.slx = [...(r.slx || []), x.id]
  }
  const seen = new Set(rows.map((r) => r.key))
  for (const c of d.coordinators || []) {
    for (const r of [{ sid: c.sid, name: c.name, summary: c.summary, isCoord: true, state: c.state, live: c.live }, ...(c.workers || []).filter((w) => w.sid).map((w) => ({ sid: w.sid, name: w.slug, summary: w.summary, relation: w.relation || 'owned', state: w.state, live: w.live, coord: c.sid }))]) {
      if (seen.has('s:' + r.sid)) continue
      seen.add('s:' + r.sid)
      rows.push({ key: 's:' + r.sid, decisions: [], reviews: [], ...r })
    }
  }
  return rows
}
const tblNeeds = () => tblAll().filter((R) => R.needs)
// slx.js, unless the server that sent this page has none.
const tblSlxOn = () => typeof slxList === 'function'
const tblFind = (key) => tblAll().find((R) => R.row.key === key)

// A row's tabs, the most urgent first.
function tblTabs(R) {
  const t = []
  const nq = R.ds.reduce((n, p) => n + cmdOpen(p).length, 0)
  if (R.ds.length) t.push({ k: 'dec', label: '❓ 결정 ' + nq })
  if (R.c) t.push({ k: 'wait', label: '🙋 대기' })
  if (R.rs.length) t.push({ k: 'rev', label: '🔎 검토 ' + R.rs.length })
  if (R.xs.length) t.push({ k: 'slx', label: R.xs[0].icon + ' slx' + (R.xs.length > 1 ? ' ' + R.xs.length : '') })
  if (R.row.sid && R.row.live !== false && !R.c) t.push({ k: 'said', label: '마지막 답' })
  if (R.row.sid && R.row.live !== false) t.push({ k: 'card', label: '🗂 카드' })
  return t
}
// The tab the left pane shows now, read from what it shows.
function tblTabNow() {
  const s = cmd.sel
  if (!s) return null
  if (s.file) return 'dec'
  if (s.revs || s.review) return 'rev'
  if (s.slx) return 'slx'
  if (s.sid) return cmd.view === 'card' ? 'card' : cmdCall(s.sid) ? 'wait' : 'said'
  return null
}

// Open a row, on a tab (else its most urgent one). render false: the
// caller draws (cmdRender's own first pick).
function tblOpen(key, k, render = true) {
  const R = tblFind(key)
  if (!R) return false
  const tabs = tblTabs(R)
  // A row that needs nothing opens in the look a session shows now (its
  // card stays its card); one that needs the person, on its most urgent tab.
  const look = !k && !R.needs && cmd.sel?.sid ? tblTabNow() : null
  const tab = tabs.find((t) => t.k === (k || look)) || tabs[0]
  if (!tab) { cmd.sel = null; cmd.row = key; if (render) cmdRender(); return true }
  tblShow(R, tab.k, render)
  return true
}
function tblShow(R, k, render = true) {
  const r = R.row, s = { sid: r.sid, name: r.name, summary: r.summary, window: R.c?.window }
  if (k === 'dec') cmdPick(R.ds[0])
  else if (k === 'rev') { cmd.sel = { revs: r.key, title: tblName(r) }; cmd.armed = null; cmd.q = null; cmd.force = null }
  else if (k === 'slx') slxPick(R.xs[0])
  else {
    if (!cmd.sel || cmd.sel.sid !== s.sid) cmdPickCall(s)
    cmd.view = k === 'card' ? 'card' : 'said'
    if (typeof cmdRenderView === 'function') cmdRenderView()
  }
  // The pickers clear the row (a pick from elsewhere has none): set after.
  cmd.row = r.key
  // The order it was opened in: an answer that takes the row out of an
  // older server's rows goes on from where it stood (tblHtml draws it too).
  tbl.order = tblOrder()
  // A coordinator opened from the table is the one the box speaks to once it is closed.
  if (r.isCoord) cmd.coord = r.sid
  if (render) cmdRender()
}
// The rows that need the person in the table's order (j/k and tblAfter walk it).
const tblOrder = () => tblNeeds().map((R) => R.row.key)
// The row of what is open now: the one opened from the table, else the row
// holding the picked brief, session or review item (a chip or a link opened
// it), so j/k go on from there.
function tblCur() {
  if (cmd.row) return cmd.row
  const s = cmd.sel
  if (!s) return null
  const R = tblAll().find((x) => (s.file && (x.row.decisions || []).includes(s.file)) || (s.sid && x.row.sid === s.sid) || (s.review && (x.row.reviews || []).some(([c, id]) => c === s.coord && id === s.review)) || (s.revs && x.row.key === s.revs) || (s.slx && (x.row.slx || []).includes(s.slx)))
  return R ? R.row.key : null
}
// Tab / ⇧Tab, [ ]: the next or previous tab of the open row.
function tblStep(dir) {
  const R = cmd.row && tblFind(cmd.row)
  if (!R) return false
  const tabs = tblTabs(R), at = tabs.findIndex((t) => t.k === tblTabNow())
  if (tabs.length < 2) return false
  tblShow(R, tabs[(at + dir + tabs.length) % tabs.length].k)
  return true
}

// Before an answer takes something out of the data: the row it belongs to
// (when the row was not opened from the table, the one `holds` finds) and
// the order now, which tblAfter goes on from.
function tblMark(holds) {
  if (!cmd.row) cmd.row = tblAll().find(holds)?.row.key || null
  tbl.order = tblOrder()
}

// After an answer: the row's next need, else the next row that needs the
// person (in the order last drawn), else closed.
function tblAfter() {
  const key = cmd.row, R = key && tblFind(key)
  if (R && R.needs) return tblOpen(key)
  // The rows in the order /command gave: an answered row keeps its place
  // there until the next poll (its cells only empty), so the next one is
  // under it. A row gone from it (an older server's, built from the data
  // the answer took out of) goes on from the order last drawn.
  const raw = tblAll().map((x) => x.row.key), order = raw.includes(key) ? raw : tbl.order || []
  const at = order.indexOf(key), needs = new Set(tblOrder())
  const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].find((k) => needs.has(k)) || [...needs][0]
  if (next) return tblOpen(next)
  cmdShut()
  cmdRender()
  return false
}

const tblShort = (sec) => { const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60)); return m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd' }

function tblCells(R) {
  const st = []
  const nq = R.ds.reduce((n, p) => n + cmdOpen(p).length, 0)
  if (nq) st.push('❓' + nq)
  if (R.c) st.push(R.c.attention === 'alert' ? '❗' : '🙋')
  if (R.rs.length) st.push('🔎' + R.rs.length)
  if (R.xs.length) st.push(R.xs[0].icon + (R.xs.length > 1 ? R.xs.length : ''))
  if (!st.length) st.push(R.row.state === 'working' ? '⚙' : R.row.live === false ? '·' : '✓')
  return st.join(' ')
}

// What a row needs, in words, under its name: the first open question, or
// what the review asks to check.
function tblAsk(R) {
  const q = R.ds.length ? cmdOpen(R.ds[0])[0] : null
  if (q) return q.question
  if (R.rs.length) return R.rs[0].title
  if (R.xs.length) return slxLine(R.xs[0].text).slice(0, 80)
  return ''
}

function tblRow(R, other) {
  const r = R.row, slug = tblSlug(r), ask = tblAsk(R)
  // A trigger's own row has no session: no 창 없음 there.
  const sub = [r.isCoord ? '🎖 coordinator' : r.relation === 'adopted' ? '입양' : '', r.sid && r.live === false ? '창 없음' : ''].filter(Boolean).join(' · ')
  const end = other && r.sid && r.live !== false && !r.isCoord ? '<button class="end" data-end="' + cmdEsc(r.sid) + '" title="세션 끝내기 (옆에 열고 확인)">⏹</button>' : ''
  // A trigger's own row carries its mark for the slx line's bulk choices.
  const mk = String(r.key).startsWith('x:') && R.xs.length && typeof slxMk === 'function' ? slxMk(R.xs[0]) + ' ' : ''
  return '<tr data-row="' + cmdEsc(r.key) + '" class="' + (cmd.row === r.key ? 'sel' : '') + (other ? ' other' : '') + '"><td class="who"><b title="' + cmdEsc(tblName(r)) + '">' + mk + cmdEsc(tblName(r)) + '</b>'
    + (slug || sub || ask ? '<span class="m">' + (slug ? '<span class="slug">' + cmdEsc(slug) + '</span> ' : '') + cmdEsc([sub, ask].filter(Boolean).join(' · ')) + '</span>' : '') + '</td>'
    + '<td class="st">' + tblCells(R) + end + '</td><td class="ago">' + (R.needs && r.at ? tblShort(r.at) : '') + '</td></tr>'
}

// The table for the list: the rows that need the person, then 👷 그 밖 N.
// Nothing is drawn for what is empty.
function tblHtml() {
  const all = tblAll(), needs = all.filter((R) => R.needs), others = all.filter((R) => !R.needs)
  tbl.order = needs.map((R) => R.row.key)
  // A row picked from under 그 밖 shows there even folded.
  const picked = !tbl.othersOpen && others.find((R) => R.row.key === cmd.row)
  const out = []
  if (needs.length) out.push('<h3>✋ 내 차례 ' + needs.length + ' <span class="m">오래 기다린 순 · j/k 행 · Tab 탭</span></h3>')
  const rows = needs.map((R) => tblRow(R, false))
  if (others.length) {
    rows.push('<tr class="more" data-fold="others"><td colspan="3">' + (tbl.othersOpen ? '▾' : '▸') + ' 👷 그 밖 ' + others.length + ' <span class="m">일하는 중 ' + others.filter((R) => R.row.state === 'working').length + '</span></td></tr>')
    if (tbl.othersOpen) rows.push(...others.map((R) => tblRow(R, true)))
    else if (picked) rows.push(tblRow(picked, true))
  }
  // colgroup: a fixed layout takes its widths from the first row, which is
  // the fold's one wide cell when nothing needs the person.
  if (rows.length) out.push('<div class="tblwrap"><table class="turn"><colgroup><col><col style="width:7.5em"><col style="width:3.2em"></colgroup>' + rows.join('') + '</table></div>')
  return out.join('')
}

// The open row's name and tabs over the left pane.
function tblRenderTabs() {
  const el = cmdEl.querySelector('.rtabs')
  if (!el) return
  const R = cmd.row && cmd.sel && tblFind(cmd.row)
  if (!R) { el.innerHTML = ''; return }
  const now = tblTabNow(), tabs = tblTabs(R)
  el.innerHTML = '<span class="who" title="' + cmdEsc(tblName(R.row)) + '">' + cmdEsc(tblName(R.row)) + '</span>'
    + tabs.map((t) => '<button data-tab="' + t.k + '" class="' + (t.k === now ? 'on' : '') + '">' + cmdEsc(t.label) + '</button>').join('')
    + (tabs.length > 1 ? '<span class="m" style="align-self:center;margin-left:4px">Tab · ⌥[ ]</span>' : '')
}
function tblTabClick(ev) {
  const b = ev.target.closest('button[data-tab]')
  const R = b && cmd.row && tblFind(cmd.row)
  if (R) tblShow(R, b.dataset.tab)
}

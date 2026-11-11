// The command view's table (지휘): a row a session, its cells overlaying
// what it holds — ❓N decisions its briefs ask, 🙋 waiting on an answer or an
// approval, 🔎N finished work put up for a look, 📨/🚨N slx triggers (a Slack
// mention, a Meerkat incident) on it or of its own, 🔌 MCP servers it lost (a
// stuck one needs the person: its card has 다시 연결), ⚙ at work, ✓ quiet — and how
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
// A row set aside (⏰ 나중에, defer.js) folds into ⏰ 미룸 N until its time
// or a new need; a row's memos are its tab 📝 메모 N and 📝N in its cells.

const TABLE_CSS = `
#command .tblwrap { max-height: 50vh; overflow: auto; margin-bottom: 10px; border: 2px solid rgba(59,42,53,.14); border-radius: 10px; background: #fff; }
#command table.turn { margin: 0; table-layout: fixed; }
#command table.turn td { padding: 4px 6px; cursor: pointer; }
#command table.turn td.who { overflow: hidden; }
#command table.turn td.who b { font-weight: 600; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command table.turn td.who .m { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command table.turn td.who b.do { white-space: normal; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
#command table.turn td.who b.do a { color: #1a5fb4; text-decoration: underline; }
#command table.turn td.who b.do code { font: 12px ui-monospace, Menlo, monospace; background: #f3ecdf; border-radius: 4px; padding: 0 3px; }
#command table.turn tr.act td:first-child { box-shadow: inset 4px 0 0 #e0793a; }
#command table.turn tr.grp td { background: #fff3e6; font-weight: 600; cursor: default; padding-top: 6px; }
#command table.turn td.st { width: 7.5em; white-space: nowrap; }
#command table.turn td.ago { width: 3.2em; text-align: right; color: #7a7090; white-space: nowrap; }
#command table.turn tr:hover td { background: #f3ecdf; }
#command table.turn tr.sel td { background: #fff3c4; }
#command table.turn tr.more td { color: #7a7090; text-decoration: underline; }
#command table.turn tr.other td { opacity: .8; }
#command table.turn tr.dim td { opacity: .5; }
#command table.turn tr.dim.sel td { opacity: .85; }
#command table.turn td.who .slug { margin-left: 0; }
#command table.turn .end { font: 11px -apple-system, sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 5px; cursor: pointer; margin-left: 4px; }
#command table.turn tr.relay td { cursor: default; padding: 2px 6px 6px 14px; box-shadow: inset 4px 0 0 #e0793a; }
#command table.turn tr.relay:hover td { background: transparent; }
#command .relay-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#command .relay-bar button { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 1px solid rgba(59,42,53,.45); border-radius: 8px; background: #fff; padding: 1px 8px; cursor: pointer; }
#command .relay-bar button:disabled { opacity: .45; cursor: default; }
#command .relay-bar input.relay-code { width: 8.5em; font: 14px ui-monospace, Menlo, monospace; letter-spacing: .12em; padding: 1px 6px; border: 1px solid rgba(59,42,53,.45); border-radius: 6px; }
#command img.relay-shot { display: block; max-width: 100%; max-height: 220px; margin-top: 5px; border: 1px solid rgba(59,42,53,.25); border-radius: 6px; }
#command .rtabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 12px 0; border-bottom: 2px solid var(--line); background: #fffaf0; }
#command .rtabs:empty { display: none; }
#command .rtabs button { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid rgba(59,42,53,.35); border-bottom: 0; border-radius: 8px 8px 0 0; background: #fff; padding: 2px 9px; cursor: pointer; }
#command .rtabs button.on { background: #2a2033; color: #fff; border-color: #2a2033; }
#command .rtabs .who { align-self: center; margin-right: 6px; font: 600 12.5px -apple-system, "Apple SD Gothic Neo", sans-serif; max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: TABLE_CSS }))

// othersOpen: the rows waiting on nobody unfolded; slxOpen: the triggers'
// own rows unfolded.
const tbl = { othersOpen: false, slxOpen: false, dfrOpen: false }
// defer.js, unless the server that sent this page has none.
const tblDfr = () => typeof dfrUntil === 'function'
// Triggers with no session up to this many show as rows; more fold to one
// line, 📨 slx N: a day of Slack mentions (26 in the live inbox) would
// otherwise bury the table, the length the person complained about.
const TBL_SLX_SHOWN = 3
const tblOwnSlx = (R) => String(R.row.key).startsWith('x:')
// The triggers' own rows fold away when there are many; one that is open
// stays in sight.
const tblSlxFolded = (all = tblAll()) => !tbl.slxOpen && all.filter((R) => R.needs && tblOwnSlx(R)).length > TBL_SLX_SHOWN
// A row's name for the person, and its slug when that says something else.
const tblName = (r) => r.summary || r.name || (r.sid || '').slice(0, 8)
const tblSlug = (r) => (r.summary && r.name && r.summary !== r.name ? r.name : '')

// A row that waits on the person to do something (a session blocked by its
// own status, a pane dialog, a missing dependency, a brief's question) comes
// before the rest of 내 차례 (a review to look at, a woken memo, a lost MCP
// server) and before the triggers: "gcl PR을 merge해야 한다"는 24개 Slack
// 멘션 사이에서 보이지 않았다.
const tblIsAct = (R) => R.needs && !tblOwnSlx(R) && !!(R.row.byStatus || R.c || R.row.dep || R.ds.length)
// 내 차례's rows in the table's order: to do, then to look at, then triggers.
const tblSplit = (all) => {
  const needs = all.filter((R) => R.needs)
  return { act: needs.filter(tblIsAct), look: needs.filter((R) => !tblIsAct(R) && !tblOwnSlx(R)), slx: needs.filter(tblOwnSlx) }
}
// What the person is to do, as the session wrote it: its `needs` text (a
// blocked status) or the dependency's text, else ''. Draw it, not the name.
const tblDoText = (R) => {
  if (R.row.dep) return R.row.dep.text || ''
  const st = R.row.status
  return R.row.byStatus && !R.ds.length && !R.c && st && st.state === 'blocked' ? st.needs || '' : ''
}
// Text for a line: URLs are links (a GitHub PR as owner/repo#N), `x` is code.
function tblLinkify(text) {
  return cmdEsc(text)
    .replace(/https?:\/\/(?:(?!&(?:quot|lt|gt);)[^\s)'`])+/g, (u) => {
      const m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/(\d+)/.exec(u)
      return '<a href="' + u + '" target="_blank" rel="noopener">' + (m ? m[1] + '#' + m[2] : u) + '</a>'
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

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
    // Set aside: out of 내 차례 until its time or a need it did not hold
    // (office/turn.py says which); its time come: up, until it is left.
    const deferred = row.sid && tblDfr() ? dfrUntil(row) : null, woke = !deferred && row.sid && tblDfr() && dfrWoke(row)
    // MCP servers the session lost (office.py mcp_state); a stuck one is
    // the person's to reconnect (its cc-mods gave up retrying alone).
    const mcp = row.mcp || [], mstuck = mcp.filter((m) => m.stuck)
    return { row, ds, c, rs, xs, mcp, mstuck, deferred, woke, memos: row.memos || [], needs: !deferred && !!(ds.length || c || rs.length || (own && xs.length) || woke || mstuck.length || row.byStatus || row.dep) }
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
    for (const r of [{ sid: c.sid, name: c.name, summary: c.summary, isCoord: true, state: c.state, live: c.live }, ...(c.workers || []).filter((w) => w.sid).map((w) => ({ sid: w.sid, name: w.slug, summary: w.summary, relation: w.relation || 'owned', state: w.state, live: w.live, coord: c.sid, status: w.status }))]) {
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
// One lost MCP server in words: which, and why it is still down. Its card
// (the 🔌 tab) has the 다시 연결 button.
function tblMcpLine(m) {
  const name = String(m.server || '').replace(/^claude\.ai /, '')
  const why = m.last === 'unknown' ? '이름 매핑 실패' : (m.atStart ? '시작 때 연결 실패 · ' : '') + '자동 재연결 ' + (m.tries || 0) + '회' + (m.stuck ? ' 실패' : ' 시도 중')
  return '🔌 MCP ' + name + ' 끊김 · ' + why
}

// A row's tabs, the most urgent first.
function tblTabs(R) {
  const t = []
  const nq = R.ds.reduce((n, p) => n + cmdOpen(p).length, 0)
  if (R.ds.length) t.push({ k: 'dec', label: '❓ 결정 ' + nq })
  if (R.c) t.push({ k: 'wait', label: '🙋 대기' })
  if (R.rs.length) t.push({ k: 'rev', label: '🔎 검토 ' + R.rs.length })
  if (R.xs.length) t.push({ k: 'slx', label: R.xs[0].icon + ' slx' + (R.xs.length > 1 ? ' ' + R.xs.length : '') })
  if (R.row.sid && (R.memos.length || cmd.sel?.memos === R.row.sid)) t.push({ k: 'memo', label: '📝 메모 ' + R.memos.length })
  // A server it could not get back: its card holds 다시 연결 (C), so the
  // card comes before 마지막 답.
  const card = R.row.sid && R.row.live !== false ? { k: 'card', label: R.mcp.length ? '🔌 MCP · 카드' : '🗂 카드' } : null
  if (card && R.mstuck.length) t.push(card)
  if (R.row.sid && R.row.live !== false && !R.c) t.push({ k: 'said', label: '마지막 답' })
  if (card && !R.mstuck.length) t.push(card)
  return t
}
// The tab the left pane shows now, read from what it shows.
function tblTabNow() {
  const s = cmd.sel
  if (!s) return null
  if (s.file) return 'dec'
  if (s.revs || s.review) return 'rev'
  if (s.slx) return 'slx'
  if (s.memos) return 'memo'
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
  else if (k === 'memo') { cmd.sel = { memos: r.sid, name: r.name, summary: r.summary }; cmd.armed = null; cmd.q = null; cmd.force = null }
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
  if (render) cmdRender()
}
// The rows that need the person in the table's order (j/k and tblAfter walk it).
// Folded trigger rows are not walked; the open one is.
function tblOrder() {
  const all = tblAll(), folded = tblSlxFolded(all)
  const g = tblSplit(all)
  return [...g.act, ...g.look, ...g.slx.filter((R) => !(folded && R.row.key !== cmd.row))].map((R) => R.row.key)
}
// The row of what is open now: the one opened from the table, else the row
// holding the picked brief, session or review item (a chip or a link opened
// it), so j/k go on from there.
function tblCur() {
  if (cmd.row) return cmd.row
  const s = cmd.sel
  if (!s) return null
  const R = tblAll().find((x) => (s.file && (x.row.decisions || []).includes(s.file)) || (s.sid && x.row.sid === s.sid) || (s.review && (x.row.reviews || []).some(([c, id]) => c === s.coord && id === s.review)) || (s.revs && x.row.key === s.revs) || (s.slx && (x.row.slx || []).includes(s.slx)) || (s.memos && x.row.sid === s.memos))
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
  if (R.mcp.length) st.push('🔌' + (R.mcp.length > 1 ? R.mcp.length : ''))
  if (R.woke) st.push('⏰')
  if (R.row.dep) st.push('🔧')
  if (R.row.byStatus && R.needs) st.push('⏸')
  if (R.memos.length) st.push('📝' + R.memos.length)
  if (!st.length || (st.length === 1 && R.memos.length)) st.push(R.row.state === 'working' ? '⚙' : R.row.live === false ? '·' : '✓')
  return st.join(' ')
}

// What a row needs, in words, under its name: the first open question, or
// what the review asks to check.
function tblAsk(R) {
  // Set aside: until when first, then what it holds.
  if (R.deferred) return ['⏰ ' + cmdHHMM(R.deferred * 1000) + '까지 미룸', tblAskNow({ ...R, deferred: null })].filter(Boolean).join(' · ')
  return tblAskNow(R)
}
function tblAskNow(R) {
  const q = R.ds.length ? cmdOpen(R.ds[0])[0] : null
  if (q) return q.question
  if (R.rs.length) return R.rs[0].title
  if (R.xs.length) return slxLine(R.xs[0].text).slice(0, 80)
  if (R.mcp.length) return tblMcpLine(R.mstuck[0] || R.mcp[0])
  if (R.woke) return '⏰ 다시 볼 시각' + (R.memos.length ? ' · 📝 ' + R.memos[0].text.slice(0, 60) : '')
  if (R.memos.length) return '📝 ' + R.memos[0].text.slice(0, 80)
  if (R.row.dep) return R.row.dep.text
  if (R.row.status) return tblStatus(R.row.status)
  return ''
}

// A worker's declared status (hooks/lib/status.ts) in a few words: its state,
// the phase, and what it waits on or does next.
const TBL_STATUS = { working: '⚙', blocked: '⏸', done: '✅', error: '⚠', idle: '·' }
const TBL_KIND = { question: '결정 대기', permission: '권한 대기', auth: '로그인 대기', wait: '외부 대기' }
function tblStatus(s) {
  const head = (TBL_STATUS[s.state] || '') + ' ' + (s.kind ? TBL_KIND[s.kind] || s.kind : s.state)
  const tail = s.state === 'blocked' ? s.needs : s.state === 'done' ? s.link || s.msg : s.next
  return [head + (s.progress != null ? ' ' + s.progress + '%' : ''), s.step, tail].filter(Boolean).join(' · ').slice(0, 120)
}

// A command the session's needs text names in backticks (a login to run by
// hand): the row offers it for copying.
const tblCmd = (R) => {
  if (R.row.dep && R.needs) return R.row.dep.cmd || ''
  const st = R.row.status
  const m = st && st.state === 'blocked' && R.needs && !R.ds.length && !R.c ? /`([^`]+)`/.exec(st.needs || '') : null
  return m ? m[1] : ''
}

// A trigger's own row that slx judged to ask nothing of the person: drawn faint.
const tblDim = (R) => tblOwnSlx(R) && R.xs.length > 0 && !!R.xs[0].dim && typeof slxWhy === 'function'

function tblRow(R, other) {
  const r = R.row, slug = tblSlug(r), ask = tblAsk(R)
  // A trigger's own row has no session: no 창 없음 there.
  const faint = tblDim(R)
  const sub = [faint ? slxWhy(R.xs[0]) : '', r.isCoord ? '🎖 coordinator' : r.relation === 'adopted' ? '입양' : '', r.sid && r.live === false ? '창 없음' : ''].filter(Boolean).join(' · ')
  const end = other && r.sid && r.live !== false && !r.isCoord ? '<button class="end" data-end="' + cmdEsc(r.sid) + '" title="세션 끝내기 (옆에 열고 확인)">⏹</button>' : ''
  const cp = tblCmd(R) ? '<button class="end" data-copy="' + cmdEsc(R.row.key) + '" title="명령 복사: ' + cmdEsc(tblCmd(R)) + '">📋</button>' : ''
  // A trigger's own row carries its mark for the slx line's bulk choices.
  const mk = String(r.key).startsWith('x:') && R.xs.length && typeof slxMk === 'function' ? slxMk(R.xs[0]) + ' ' : ''
  // What it asks of the person is the line; the session is the small one.
  const doing = !other && tblDoText(R)
  if (doing) {
    const who = [r.isCoord ? '🎖' : '', tblName(r), slug, R.row.status && R.row.status.kind ? TBL_KIND[R.row.status.kind] || R.row.status.kind : ''].filter(Boolean).join(' · ')
    return '<tr data-row="' + cmdEsc(r.key) + '" class="act' + (cmd.row === r.key ? ' sel' : '') + '"><td class="who"><b class="do" title="' + cmdEsc(doing) + '">' + tblLinkify(doing) + '</b>'
      + '<span class="m">' + cmdEsc(who) + '</span></td>'
      + '<td class="st">' + tblCells(R) + cp + '</td><td class="ago">' + (R.needs && r.at ? tblShort(r.at) : '') + '</td></tr>'
  }
  return '<tr data-row="' + cmdEsc(r.key) + '"' + (faint ? ' title="' + cmdEsc(slxWhy(R.xs[0])) + '"' : '') + ' class="' + (cmd.row === r.key ? 'sel' : '') + (other ? ' other' : '') + (faint ? ' dim' : '') + (R.needs && tblIsAct(R) ? ' act' : '') + '"><td class="who"><b title="' + cmdEsc(tblName(r)) + '">' + mk + cmdEsc(tblName(r)) + '</b>'
    + (slug || sub || ask ? '<span class="m">' + (slug ? '<span class="slug">' + cmdEsc(slug) + '</span> ' : '') + cmdEsc([sub, ask].filter(Boolean).join(' · ')) + '</span>' : '') + '</td>'
    + '<td class="st">' + tblCells(R) + cp + end + '</td><td class="ago">' + (R.needs && r.at ? tblShort(r.at) : '') + '</td></tr>'
}

// The table for the list: the rows that need the person, then 👷 그 밖 N.
// Nothing is drawn for what is empty.
function tblHtml() {
  const all = tblAll(), others = all.filter((R) => !R.needs && !R.deferred), later = all.filter((R) => R.deferred)
  const g = tblSplit(all), slxRows = g.slx, needs = [...g.act, ...g.look]
  const folded = tblSlxFolded(all)
  tbl.order = tblOrder()
  // A row picked from under 그 밖 shows there even folded.
  const picked = !tbl.othersOpen && others.find((R) => R.row.key === cmd.row)
  const out = []
  // 내 차례 counts what sessions and briefs wait on; triggers are candidates, counted on their own line.
  if (needs.length || slxRows.length) out.push('<h3>✋ 내 차례 ' + needs.length + (slxRows.length ? ' <span class="m">+ 📨 ' + slxRows.length + (slxRows.filter(tblDim).length ? ' · 흐림 ' + slxRows.filter(tblDim).length : '') + '</span>' : '') + ' <span class="m">오래 기다린 순 · j/k 행 · Tab 탭</span></h3>')
  const grp = (t) => '<tr class="grp"><td colspan="3">' + t + '</td></tr>'
  const rows = []
  if (g.act.length) rows.push(grp('🔶 지금 내가 해야 할 것 ' + g.act.length))
  rows.push(...g.act.flatMap((R) => [tblRow(R, false), tblRelayRow(R)]))
  if (g.look.length) rows.push(grp('🔎 보거나 다시 연결할 것 ' + g.look.length))
  rows.push(...g.look.map((R) => tblRow(R, false)))
  if (folded) {
    rows.push('<tr class="more" data-fold="slx"><td colspan="3">▸ 📨 slx ' + slxRows.length + ' <span class="m">세션 없는 멘션·incident · 펼치기</span></td></tr>')
    const open = slxRows.find((R) => R.row.key === cmd.row)
    if (open) rows.push(tblRow(open, false))
  } else {
    if (slxRows.length > TBL_SLX_SHOWN) rows.push('<tr class="more" data-fold="slx"><td colspan="3">▾ 📨 slx ' + slxRows.length + '</td></tr>')
    rows.push(...slxRows.map((R) => tblRow(R, false)))
  }
  // Set aside: one line, ⏰ 미룸 N; the open one shows under it folded.
  if (later.length) {
    rows.push('<tr class="more" data-fold="dfr"><td colspan="3">' + (tbl.dfrOpen ? '▾' : '▸') + ' ⏰ 미룸 ' + later.length + ' <span class="m">시각이 되거나 새 질문·대기가 오면 다시 올라옵니다</span></td></tr>')
    const open = later.find((R) => R.row.key === cmd.row)
    if (tbl.dfrOpen) rows.push(...later.map((R) => tblRow(R, false)))
    else if (open) rows.push(tblRow(open, false))
  }
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
    + (tblDfr() ? dfrTabsHtml(R) : '')
}
function tblTabClick(ev) {
  if (tblDfr() && dfrClick(ev)) return
  const b = ev.target.closest('button[data-tab]')
  const R = b && cmd.row && tblFind(cmd.row)
  if (R) tblShow(R, b.dataset.tab)
}

// A login wait the worker declared with pane/ask/target (hooks/lib/status.ts,
// office/relay.py): answered from this row, not from the worker's pane. 🖼
// shows the pane now (asked for, never polled); otp takes a code and sends
// it to the pane's input; click presses the button after a look; device
// only says to approve it on the device. The code goes in the /act body
// alone and is cleared from the box once sent.
const tblRelay = { shot: {}, busy: {} } // sid -> { png, url, visible, why, look, at }
const tblRelayOf = (R) => {
  const st = R.row.status
  return R.needs && R.row.sid && st && st.state === 'blocked' && st.kind === 'auth' && st.ask && st.pane ? st : null
}
function tblRelayRow(R) {
  const st = tblRelayOf(R)
  if (!st) return ''
  const sid = cmdEsc(R.row.sid), shot = tblRelay.shot[R.row.sid], busy = tblRelay.busy[R.row.sid]
  const lookB = st.ask !== 'device' ? '<button data-relay="look" data-sid="' + sid + '" title="' + cmdEsc(st.pane) + ' 화면을 지금 한 장 찍어 봅니다">🖼 ' + (shot ? '다시 보기' : '화면 보기') + '</button>' : ''
  let act = ''
  if (st.ask === 'otp') act = '<input class="relay-code" data-sid="' + sid + '" autocomplete="one-time-code" inputmode="numeric" maxlength="16" placeholder="인증 코드" aria-label="인증 코드"' + (busy ? ' disabled' : '') + '><button data-relay="otp" data-sid="' + sid + '"' + (busy ? ' disabled' : '') + '>보내기</button>'
  else if (st.ask === 'click') act = '<button data-relay="click" data-sid="' + sid + '"' + (shot && shot.look && !busy ? '' : ' disabled') + ' title="' + (shot ? cmdEsc(st.target) + ' 누르기' : '먼저 🖼 화면을 보고 누릅니다') + '">👆 ' + cmdEsc(st.target) + ' 누르기</button>'
  else act = '<span class="m">🔐 passkey·지문은 기기에서 승인하세요.</span> <button data-relay="device" data-sid="' + sid + '">승인했어요</button>'
  const where = '<span class="m">' + cmdEsc(st.pane) + (shot ? ' · ' + cmdEsc(shot.url.replace(/^https?:\/\//, '').slice(0, 60)) : '') + '</span>'
  const warn = shot && !shot.visible && st.ask !== 'device' ? '<div class="m">⚠ 대상이 지금 화면에 없습니다: ' + cmdEsc(shot.why) + '</div>' : ''
  const img = shot ? '<img class="relay-shot" alt="' + cmdEsc(st.pane) + ' 화면" src="data:image/png;base64,' + shot.png + '">' : ''
  return '<tr class="relay" data-relay-row="' + sid + '"><td colspan="3"><div class="relay-bar">' + lookB + act + where + '</div>' + warn + img + '</td></tr>'
}
async function tblRelayClick(ev) {
  const b = ev.target.closest('button[data-relay]')
  if (!b) return false
  const sid = b.dataset.sid, what = b.dataset.relay
  if (tblRelay.busy[sid]) return true
  const body = { sid, kind: 'relay_' + what }
  if (what === 'otp') {
    const box = cmdEl.querySelector('input.relay-code[data-sid="' + CSS.escape(sid) + '"]')
    const v = (box && box.value || '').trim()
    if (!v) { toast('코드를 넣으세요'); box && box.focus(); return true }
    body.value = v
    if (box) box.value = ''
  }
  if (what === 'click') body.look = (tblRelay.shot[sid] || {}).look
  tblRelay.busy[sid] = true
  cmdRender()
  try {
    const j = await cmdPost(body)
    if (what === 'look') {
      if (j && j.png) tblRelay.shot[sid] = { png: j.png, url: j.url || '', visible: j.visible, why: j.why || '', look: j.look, at: Date.now() }
    } else if (j && j.ok) {
      toast('✅ ' + (what === 'otp' ? '코드를 보냈습니다' : what === 'click' ? '눌렀습니다' : '알렸습니다'))
      // The look was spent (click) or the page moved on: look again to see.
      delete tblRelay.shot[sid]
    }
  } finally {
    delete body.value
    tblRelay.busy[sid] = false
    cmdRender()
  }
  return true
}
// Enter in the code box sends it; every other key is typing.
function tblRelayKey(ev) {
  const box = ev.target.closest && ev.target.closest('input.relay-code')
  if (!box) return false
  if (ev.key === 'Enter') { ev.preventDefault(); const b = cmdEl.querySelector('button[data-relay="otp"][data-sid="' + CSS.escape(box.dataset.sid) + '"]'); if (b) b.click() }
  ev.stopPropagation()
  return true
}

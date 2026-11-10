// The command view (지휘): the office seen from the coordinators' side.
//
// A panel on the right of the floor, which stays in sight and live. On top,
// always, a box for a task: whatever the person types goes to the
// coordinator, which picks the session (coord_route) or starts one, and the
// line under the box says where it went. The person never picks a session to
// instruct. Under it the brief line, then one table, a row a session
// (table.js, office/turn.py): its cells overlay what it holds — the decisions
// its briefs ask, whether it waits on an answer or an approval, finished work
// put up for a look, or that it is at work or quiet. The rows that need the
// person come first; the rest fold to one line. The person found a stack of
// sections too long and the slugs unreadable: a session is named by what it
// was doing, its slug a small grey tag. A trigger of the slx inbox (📨
// Slack, 🚨 Meerkat, office/slx.js) rides on its session's row as 📨N, or
// with no session has a row of its own after the rest; it opens with 세션
// 만들기, 무시, 이런 것 숨기기 or 나중에, each done by slx itself.
// A picked brief opens beside the panel in the same sandboxed frame the
// card's viewer uses; under it each of its questions, with the options to
// pick and a box for a note or an answer in the person's own words. An answer
// goes to the office server, which records it on the brief and, once the
// brief's last question is answered, hands them all to whoever asked
// (office/command.py).
// A session waiting on the person, picked in the list, opens there the same
// way: the end of its last answer, the choice on its screen (or the card's
// quick replies) and a box; an answer goes straight to that session, as the
// floor card's reply does, never through a coordinator.
// Finished work a coordinator put up for the person's look (🔎 검토,
// office/review.js) opens there too: 확인함 takes it off, 문제 있음 sends the
// person's words to its coordinator.
// A session at work, picked in its folded table, opens there too: to look at
// it, and to answer it directly only when the person means to.
// A picked session shows there in one of two looks, T (⌥T) between them:
// 마지막 답, the end of its last answer, and 카드, what the floor card shows
// (past turns, what it was handed, sent and wrote, its work, btw), drawn by
// office.html's cardPanes into the same place, so the view is never left.
// A picked row opens beside the panel with a tab for each thing it holds
// (table.js); Tab / ⇧Tab move between them, j/k between the rows.
// The briefs stay one line under the box, whatever the table holds: the
// newest few as chips, 전체 to every recent one; b (⌥B) walks them.
//
// The page knows two modes, 사무실 and 지휘; `C` (or `D`) or the header
// switch flips them. Everything here reads /command; nothing in office.html depends on it
// beyond the switch, the key hook and the card's brief badge.

const CMD_CSS = `
#modes { display: inline-flex; gap: 0; padding: 0; overflow: hidden; pointer-events: auto; }
#modes button { font: inherit; color: inherit; background: none; border: 0; padding: 2px 10px; cursor: pointer; }
#modes button.on { background: var(--warn); color: #2a2033; }
#modes b { color: var(--bad); }
#modes button.on b { color: #a1002b; }
#command { --cmd-w: clamp(340px, 30vw, 460px); }
#command .pane.left { position: fixed; right: 10px; top: 52px; bottom: 10px; width: var(--cmd-w); z-index: 3; }
#command .pane.right { position: fixed; left: 10px; right: calc(var(--cmd-w) + 20px); top: 52px; bottom: 10px; z-index: 3; }
#command:not(.on) .pane, #command:not(.doc-on) .pane.right { display: none; }
#command .pane { background: #fffaf0; color: #2a2033; border: 3px solid var(--line); border-radius: 16px; box-shadow: 0 5px 0 var(--line); overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
#command .list { overflow: auto; padding: 10px 12px; flex: 1; }
#command h3 { font-weight: 400; font-size: 15px; margin: 4px 0 6px; }
#command h3 .m, #command .m { color: #7a7090; font-size: 11px; font-family: -apple-system, sans-serif; }
#command .list .q { border: 2px solid rgba(59,42,53,.18); border-radius: 10px; padding: 6px 8px; margin-bottom: 6px; cursor: pointer; background: #fff; }
#command .list .q.sel { border-color: #2a2033; background: #fff3c4; }
#command .list .q .t { font-size: 13px; }
#command .list .q .ask { font: 12px/1.4 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: 2px 0; }
#command table { width: 100%; border-collapse: collapse; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; margin-bottom: 10px; }
#command th { text-align: left; font-weight: 600; color: #7a7090; border-bottom: 2px solid rgba(59,42,53,.18); padding: 2px 4px; }
#command td { border-bottom: 1px solid rgba(59,42,53,.1); padding: 3px 4px; vertical-align: top; }
#command .st-waiting, #command .st-asking { color: #b7791f; } #command .st-alert { color: #c0392b; } #command .st-working { color: #2f855a; } #command .st-gone { color: #9a93a8; }
#command .say { border-bottom: 2px solid rgba(59,42,53,.14); padding: 8px 12px; background: #fff3c4; }
#command .say .sent { margin-top: 4px; }
#command .say .row textarea { flex: 1; min-width: 0; }
#command .say .go { white-space: nowrap; align-self: stretch; }
#command .say .sent b { font-weight: 600; color: #2a2033; }
#command .say .re { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 1px 4px 1px 8px; border: 2px solid #2a2033; border-radius: 999px; background: #fff; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; max-width: 100%; }
#command .say .re .x { font: inherit; border: 0; background: none; cursor: pointer; padding: 0 4px; }
#command h3.ws { cursor: pointer; user-select: none; }
#command .fold { cursor: pointer; margin: -6px 0 10px; text-decoration: underline; }
#command .slug { display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 6px; background: rgba(59,42,53,.07); color: #8a8298; font: 10.5px ui-monospace, Menlo, monospace; vertical-align: 1px; white-space: nowrap; }
#command textarea, #command input[type=text] { width: 100%; font: 13px -apple-system, sans-serif; border: 2px solid var(--line); border-radius: 10px; padding: 5px 8px; }
#command textarea { min-height: 44px; resize: vertical; }
#command button.act { font: inherit; font-size: 13px; border: 2px solid var(--line); border-radius: 10px; padding: 3px 10px; cursor: pointer; background: #fff; box-shadow: 0 2px 0 var(--line); }
#command button.act:active { transform: translateY(2px); box-shadow: none; }
#command button.act:disabled { opacity: .45; cursor: default; }
#command .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 2px solid var(--line); font-size: 13px; }
#command .bar .m { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command .bar > * { flex: 0 0 auto; white-space: nowrap; }
#command .bar { gap: 6px; }
#command .bar button.act { padding: 3px 7px; }
#command .bar > b { flex: 0 1 auto; min-width: 6em; overflow: hidden; text-overflow: ellipsis; }
#command .bar > .m { flex: 1 1 0; min-width: 0; }
#command iframe { flex: 1; width: 100%; border: 0; background: #fff; min-height: 0; }
#command .feed { font: 12px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: 0 0 10px; padding: 0; list-style: none; }
#command .feed li { padding: 2px 4px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command .feed li:hover { background: #f3ecdf; }
#command .feed li.sel { background: #fff3c4; outline: 2px solid #2a2033; }
#command .doc > .said { flex: 1; overflow: auto; padding: 10px 14px; font: 13px/1.55 -apple-system, "Apple SD Gothic Neo", sans-serif; background: #fff; min-height: 0; }
#command .doc > .said p { margin: 0 0 6px; }
#command .doc > .said h1, #command .doc > .said h2, #command .doc > .said h3, #command .doc > .said h4 { font-size: 14px; margin: 8px 0 4px; }
#command .doc > .said ul, #command .doc > .said ol { margin: 0 0 6px; padding-left: 18px; }
#command .doc > .said code { font: 12px ui-monospace, Menlo, monospace; background: rgba(59,42,53,.08); border-radius: 4px; padding: 0 3px; }
#command .doc > .said pre { background: #2a2033; color: #f3ecdf; border-radius: 8px; padding: 6px 8px; overflow-x: auto; white-space: pre; }
#command .doc > .said pre code { background: none; padding: 0; color: inherit; }
#command .doc > .said .cut { color: #7a7090; font-size: 11px; margin-bottom: 6px; }
#command .feed li.more { color: #7a7090; text-decoration: underline; }
#command .feed.turn li { white-space: normal; overflow: visible; padding: 3px 6px; border-top: 1px solid rgba(59,42,53,.08); }
#command .feed.turn li.cont { padding-left: 22px; border-top: 0; }
#command .feed.turn li .ask { display: block; color: #5a5070; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command .decide { border-top: 2px solid var(--line); padding: 8px 12px 10px; max-height: 45%; overflow: auto; }
#command .decide .ask { font-size: 14px; margin-bottom: 6px; }
#command .qa { padding: 6px 8px; margin: 0 -8px 4px; border-radius: 10px; }
#command .qa.on { background: #fff3c4; }
#command .qa.done { opacity: .7; }
#command .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
#command .opt { text-align: left; max-width: 100%; }
#command .opt.rec { background: #a8e6b0; }
#command .opt.armed { outline: 3px solid #2a2033; }
#command .opt small { display: block; font: 11px -apple-system, sans-serif; color: #5a5070; }
#command .key { display: inline-block; min-width: 16px; margin-right: 5px; font-size: 11px; background: #2a2033; color: #fff; border-radius: 5px; padding: 0 4px; text-align: center; vertical-align: 1px; }
#command .row { display: flex; gap: 6px; align-items: center; }
@media (max-width: 760px) { #command { --cmd-w: calc(100vw - 20px); } #command .pane.right { right: 10px; bottom: 50%; } #command.doc-on .pane.left { top: 50%; } }
`

// sel: the picked brief ({ file, path, title }) or waiting session ({ sid,
// name, window }). armed: { q, i } (option i of question q, waiting for
// Enter), or { call: sid, i } for a session's choice; q: the question digits
// and m go to, when the person picked one by hand. ask: what the picked
// session asks (/command?sid=); force: a reply the server called busy, sent
// anyway on a second Enter; sent: sid -> when the person last answered it.
// coord: the coordinator the box speaks to, when the person clicked one;
// said: the last task typed in the box ({ coord, at, text }, at on the
// ledger log's clock), for the line saying where it went.
// view: how a picked session shows, 'said' (its last answer) or 'card'.
// row: the table's row open beside the panel (its key), whose tabs show
// over the left pane; null when what is open came from elsewhere (a brief
// chip, a link).
const cmd = { on: false, data: null, sel: null, coord: null, armed: null, q: null, timer: null, frame: null, pendingN: 0, ask: null, force: null, sent: {}, said: null, view: 'said', row: null }
const cmdEl = document.createElement('div')
cmdEl.id = 'command'
document.body.appendChild(cmdEl)
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CMD_CSS }))

const cmdEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function cmdAgo(iso) {
  // The brief CLI writes minutes only (2026-11-08T01:00Z); add the seconds ISO wants.
  const s = String(iso || ''), t = Date.parse(/T\d\d:\d\dZ$/.test(s) ? s.replace(/Z$/, ':00Z') : s)
  if (isNaN(t)) return ''
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  return m < 60 ? m + '분 전' : m < 1440 ? Math.round(m / 60) + '시간 전' : Math.round(m / 1440) + '일 전'
}
const STATE_KO = { working: '일하는 중', waiting: '기다림', idle: '쉼', done: '끝남' }
const ATTN_KO = { ask: '❓ 질문', alert: '❗ 확인', none: '' }

// The header switch: 사무실 | 지휘, with how many decisions wait.
function cmdSwitch() {
  let m = document.getElementById('modes')
  if (!m) {
    m = document.createElement('span'); m.id = 'modes'; m.className = 'chip'
    m.title = '사무실 ↔ 지휘 (C · TWeb에서는 ⌥C)'
    const h1 = document.getElementById('office-title'); h1.after(m)
    m.onclick = (ev) => { const b = ev.target.closest('button'); if (b) setCommand(b.dataset.m === 'command') }
  }
  m.innerHTML = '<button data-m="office" class="' + (cmd.on ? '' : 'on') + '">🏢 사무실</button><button data-m="command" class="' + (cmd.on ? 'on' : '') + '">🎖 지휘' + (cmd.pendingN ? ' <b>' + cmd.pendingN + '</b>' : '') + '</button>'
}

function setCommand(on) {
  // Leaving the view is a close as much as ✕ is: the decisions waiting now
  // do not open their brief again on their own when it is opened next.
  if (cmd.on && !on) { cmd.sel = null; cmd.armed = null; cmd.q = null; cmd.shut = (cmd.data?.pending || []).map((p) => p.file).join('|') }
  cmd.on = on
  cmdEl.classList.toggle('on', on)
  try { localStorage.setItem('office.mode', on ? 'command' : 'office') } catch { /* private window: the mode is only not remembered */ }
  cmdSwitch()
  clearTimeout(cmd.timer)
  if (on) cmdLoad()
}

// office.html's /state poll tells how many decisions wait, for the switch.
function commandCount(n) {
  if (n === cmd.pendingN) return
  cmd.pendingN = n || 0
  cmdSwitch()
}

async function cmdLoad() {
  clearTimeout(cmd.timer)
  if (!cmd.on) return
  try {
    const r = await fetch('/command', { cache: 'no-store' })
    if (r.ok) { cmd.data = await r.json(); commandCount(cmd.data.pending.length); cmdRender() }
  } catch { /* the server restarts: keep the last picture */ }
  if (cmd.sel?.sid) cmdAsk()
  cmd.timer = setTimeout(cmdLoad, 3000)
}

function cmdPending(file) { return (cmd.data?.pending || []).find((p) => p.file === file) }
// A brief's questions; a server from before questions[] sent its one decision.
const cmdQs = (p) => p.questions || [{ id: 'q1', ...p.decision }]
const cmdOpen = (p) => cmdQs(p).filter((q) => !q.answer)
// The question the keys work on: the one picked by hand while it is open, else the first open one.
function cmdActive(p) {
  const open = cmdOpen(p)
  return open.find((q) => q.id === cmd.q) || open[0]
}
// A pick from anywhere but the table leaves no row open; tblShow sets it again after.
function cmdPick(p) { cmd.sel = { file: p.file, path: p.path, title: p.title }; cmd.armed = null; cmd.q = null; cmd.row = null }
const cmdCall = (sid) => (cmd.data?.calls || []).find((c) => c.sid === sid)
// `summary`: what the session was doing, the name the person knows it by;
// `name` (its slug) stays for the small tag beside it.
function cmdPickCall(c) { cmd.sel = { sid: c.sid, name: c.name, summary: c.summary || cmdSummary(c.sid), window: c.window }; cmd.armed = null; cmd.q = null; cmd.force = null; cmd.row = null; cmdAsk() }
// What a session was doing, from whatever /command holds on it.
function cmdSummary(sid) {
  const d = cmd.data || {}
  return (d.table || []).find((r) => r.sid === sid)?.summary || cmdCall(sid)?.summary || cmdWorkers().find((x) => x.w.sid === sid)?.w.summary || (d.coordinators || []).find((c) => c.sid === sid)?.summary || ''
}
// A session as the person reads it: its summary, the slug after it.
const cmdWho = (s) => (s.summary && s.summary !== s.name ? s.summary + ' (' + s.name + ')' : s.name || '')
// A session at work, from the folded table: opened like a waiting one, to look at.
const cmdWorkers = () => (cmd.data?.coordinators || []).flatMap((c) => c.workers.map((w) => ({ c, w })))
// review.js and slx.js, unless the server that sent this page has none.
const cmdRev = () => typeof revList === 'function'
const cmdSlx = () => typeof slxList === 'function'

async function cmdAsk() {
  const sid = cmd.sel?.sid
  if (!sid) return
  try {
    const r = await fetch('/command?sid=' + encodeURIComponent(sid), { cache: 'no-store' })
    const j = await r.json()
    if (cmd.sel?.sid !== sid) return
    cmd.ask = j
    cmdRenderDoc()
  } catch { /* the server restarts: keep the last picture */ }
}

function cmdRender() {
  const d = cmd.data || { pending: [], coordinators: [] }
  // Nothing picked yet: the row that has waited longest, when it holds a decision.
  if (!cmd.sel && d.pending.length && cmd.shut !== d.pending.map((p) => p.file).join('|')) {
    const first = tblNeeds().find((R) => R.ds.length)
    if (!(first && tblOpen(first.row.key, 'dec', false))) cmdPick(d.pending[0])
  }
  if (!cmdEl.firstChild) {
    cmdEl.innerHTML = '<div class="pane left"><div class="say"></div><div class="briefs"></div><div class="list"></div></div><div class="pane right"><div class="rtabs"></div><div class="bar"></div><div class="doc"></div><div class="decide"></div></div>'
    cmdEl.querySelector('.list').onclick = cmdClick
    cmdEl.querySelector('.briefs').onclick = cmdBriefClick
    cmdEl.querySelector('.rtabs').onclick = tblTabClick
  }
  // The table scrolls on its own: a redraw keeps where it was.
  const list = cmdEl.querySelector('.list'), keep = list.scrollTop, keepT = list.querySelector('.tblwrap')?.scrollTop || 0
  // The slx line under the table: what is hidden, what runs, the bulk choices.
  list.innerHTML = tblHtml() + (cmdSlx() ? slxFoot() : '')
  list.scrollTop = keep
  const wrap = list.querySelector('.tblwrap')
  if (wrap) wrap.scrollTop = keepT
  cmdRenderBriefs()
  cmdRenderSay()
  cmdRenderDoc()
}

function cmdFold(which) {
  if (which === 'others') tbl.othersOpen = !tbl.othersOpen
  else if (which === 'slx') tbl.slxOpen = !tbl.slxOpen
  cmdRender()
}

function cmdClick(ev) {
  if (cmdSlx() && slxClick(ev)) return
  // ⏹ on a row: the session opens beside the panel and its end is asked
  // there, where the warning and the second press are.
  const end = ev.target.closest('button[data-end]')
  if (end) {
    const R = tblAll().find((x) => x.row.sid === end.dataset.end)
    if (R) { cmdPickCall({ sid: R.row.sid, name: R.row.name, summary: R.row.summary, window: R.c?.window }); cmd.row = R.row.key; cmdRender(); crewEnd(cmd.sel) }
    return
  }
  const f = ev.target.closest('[data-fold]')
  if (f) return cmdFold(f.dataset.fold)
  const tr = ev.target.closest('tr[data-row]')
  if (!tr) return
  // A coordinator's row clicked: the box's plain tasks go to it from now on
  // (with several on). Walking past one with j/k, or an answer moving on,
  // never changes where they go.
  const R = tblFind(tr.dataset.row)
  if (R && R.row.isCoord) cmd.coord = R.row.sid
  tblOpen(tr.dataset.row)
}

// The coordinator the box speaks to: the one last clicked, else the first
// with a live window.
function cmdCoord() {
  const cs = cmd.data?.coordinators || []
  return cs.find((x) => x.sid === cmd.coord) || cs.find((x) => x.live) || cs[0]
}

const cmdHHMM = (ms) => new Date(ms).toTimeString().slice(0, 5)

// Where the coordinator put the last task typed in the box: the first send
// or spawn in its log from then on ("<slug>: …" / "<slug> <model>/…").
function cmdWhere(c, at) {
  const e = (c?.log || []).find((x) => x.at >= at && (x.kind === 'send' || x.kind === 'spawn'))
  if (!e) return ''
  const slug = String(e.text).split(/[: ]/)[0]
  const w = (c?.workers || []).find((x) => x.slug === slug), tag = '<span class="slug">' + cmdEsc(slug) + '</span>'
  const name = w && w.summary && w.summary !== slug ? '<b>' + cmdEsc(w.summary) + '</b> ' + tag : '<b>' + cmdEsc(slug) + '</b>'
  return e.kind === 'spawn' ? '🆕 새 worker ' + name : '👷 ' + name + '에 맡김'
}

// What the person has open beside the panel is what the box speaks about:
// a brief (its worker), a session (straight to it) or a review item, shown
// as a chip over the box. ✕ on the chip makes the box a plain task again
// until something else is opened. Nothing open: the coordinator places it.
function cmdAbout() {
  const s = cmd.sel
  if (!s) return null
  const key = s.sid ? 'sid:' + s.sid : s.review ? 'review:' + s.review : s.revs ? 'revs:' + s.revs : s.slx ? 'slx:' + s.slx : 'brief:' + s.file
  // A ✕ holds for the thing it was pressed on; opening another brings the chip back.
  if (cmd.aboutSeen !== key) { cmd.aboutSeen = key; cmd.aboutOff = null }
  if (cmd.aboutOff === key) return null
  if (s.sid) return { key, kind: 'session', sid: s.sid, label: '👷 ' + (s.summary || s.name) + ' 에게' }
  if (s.review) return { key, kind: 'review', id: s.review, coord: s.coord, label: '🔎 ' + s.review + ' 에 대해' }
  if (s.slx && s.slx[0] === '!') return null
  if (s.slx) return { key, kind: 'slx', id: s.slx, label: '📨 ' + (s.title || s.slx) + ' 에 대해' }
  // A session's review items as a list: the box speaks about the unfolded one.
  if (s.revs) { const r = cmdRev() && revCur(s); return r ? { key, kind: 'review', id: r.id, coord: r.coord, label: '🔎 ' + (r.title || r.id) + ' 에 대해' } : null }
  const p = cmdPending(s.file)
  // The brief's worker: the one its question names, else the session whose latest brief it is.
  const worker = p?.decision?.worker || cmdWorkers().find((x) => x.w.brief && x.w.brief.file === s.file)?.w.slug || ''
  return { key, kind: 'brief', file: s.file, worker, coord: p?.decision?.coordinator, label: '📄 ' + (s.title || s.file) + ' 에 대해' }
}

const SAY_HINT = {
  none: '할 일을 쓰면 coordinator가 알맞은 세션에 맡기거나 새로 띄웁니다',
  brief: '이 브리프에 대해 할 일 (coordinator가 그 worker에게 넘깁니다)',
  review: '이 검토 항목에 대해 할 일 (문제 제기는 옆의 문제 있음 칸)',
  session: '이 세션에 바로 보낼 말 (coordinator를 거치지 않음)',
  slx: '이 slx 항목에 대해 할 일 (coordinator가 맡길 곳을 고릅니다)',
}

// The task in the box, to where cmdAbout says: true once it went.
async function cmdSay(text) {
  const ab = cmdAbout(), cs = cmd.data?.coordinators || []
  if (ab && ab.kind === 'session') {
    const s = cmd.sel
    if (!(await cmdReply(s, { kind: 'reply', value: text }, '지시'))) return false
    cmd.said = { direct: s.summary || s.name, at: Date.now(), text }
    return true
  }
  const c = (ab && ab.coord && cs.find((x) => x.sid === ab.coord)) || cmdCoord()
  if (!c) return false
  const re = !ab ? null : ab.kind === 'review' ? { review: ab.id } : ab.kind === 'slx' ? { slx: ab.id } : { brief: ab.file, worker: ab.worker }
  const j = await cmdPost({ kind: 'coord_say', coord: c.sid, slug: '', value: text, ...(re ? { re } : {}) })
  if (!j) return false
  cmd.said = { coord: c.sid, at: j.at || Date.now(), text, re: ab ? ab.label : '' }
  toast('📨 ' + (j.sent || '보냈습니다'))
  return true
}

function cmdRenderSent() {
  const el = cmdEl.querySelector('.say .sent'), s = cmd.said
  if (!el) return
  if (!s) { el.innerHTML = ''; return }
  el.title = s.text
  if (s.direct) { el.innerHTML = '→ 👷 <b>' + cmdEsc(s.direct) + '</b>에게 직접 보냄 ' + cmdHHMM(s.at); return }
  const c = (cmd.data?.coordinators || []).find((x) => x.sid === s.coord)
  const where = cmdWhere(c, s.at)
  el.innerHTML = '→ coordinator에게 보냄 ' + cmdHHMM(s.at) + (s.re ? ' (' + cmdEsc(s.re) + ')' : '') + ' · ' + (where || '<span class="m">맡길 곳을 고르는 중…</span>')
}

// The box on top, always there. Drawn once (the 3 s poll keeps what is
// typed); the chip, the line over it and the hint follow what is open.
function cmdRenderSay() {
  const box = cmdEl.querySelector('.say')
  if (!box) return
  const c = cmdCoord()
  if (!c) {
    box.dataset.for = ''
    box.innerHTML = '<div class="m">켜진 coordinator가 없어 맡길 곳이 없습니다. 세션에서 <code>/coord on</code>.</div>'
    return
  }
  if (box.dataset.for !== 'box') {
    box.dataset.for = 'box'
    box.innerHTML = '<div class="m head" style="margin-bottom:4px"></div><div class="about"></div><div class="row"><textarea></textarea><button class="act go">보내기</button></div><div class="sent m"></div>'
    const ta = box.querySelector('textarea')
    const go = async () => {
      const text = ta.value.trim()
      if (!text) return
      if (!(await cmdSay(text))) return
      ta.value = ''
      cmdRenderSent()
    }
    box.querySelector('.go').onclick = go
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); go() } else if (e.key === 'Escape') { e.preventDefault(); ta.blur() } }
    box.querySelector('.about').onclick = (e) => { if (e.target.closest('.x')) { cmd.aboutOff = cmdAbout()?.key; cmdRenderSay() } }
  }
  const ab = cmdAbout(), keys = ' <span class="m">(i · Enter 보내기 · Shift+Enter 줄바꿈)</span>'
  const ac = ab && ab.coord && (cmd.data?.coordinators || []).find((x) => x.sid === ab.coord)
  box.querySelector('.head').innerHTML = (ab && ab.kind === 'session' ? '이 세션에 직접' : '🎖 <b>' + cmdEsc((ac || c).name) + '</b>에게 맡기기') + keys
  box.querySelector('.about').innerHTML = ab ? '<span class="re">' + cmdEsc(ab.label) + ' <button class="x" title="일반 지시로 (coordinator가 맡길 곳을 고름)">✕</button></span>' : ''
  box.querySelector('textarea').placeholder = SAY_HINT[ab ? ab.kind : 'none']
  cmdRenderSent()
}

// ↗ 밖으로 opens this brief alone in the browser (the server's `open`); the
// office page is the person's screen and never moves.
function cmdBriefBar(bar, s) {
  bar.innerHTML = '<b>📄 ' + cmdEsc(s.title || s.file) + '</b><span class="m">' + cmdEsc(s.path) + '</span><button class="act out">↗ 밖으로</button><button class="act shut" title="닫기 (Esc)">✕</button>'
  bar.querySelector('.out').onclick = async () => { const j = await cmdPost({ kind: 'brief_open', file: s.file, via: lastPlace(s.path) }); if (j) toast('↗ ' + (j.sent || '열었습니다')) }
  bar.querySelector('.shut').onclick = cmdShut
}

// The frame told which page it shows now (office/command.py FRAME_NOTE): a link
// inside the brief moved it. The bar and the answer buttons follow, so they
// never stay under a page they are not about; the frame itself is not rebuilt.
// office.html listens for 'message' and calls this.
function cmdFrameMsg(ev) {
  const fr = cmdEl.querySelector('.doc iframe')
  const m = fr && ev.source === fr.contentWindow && ev.data && typeof ev.data.officeBrief === 'string' && ev.data.officeBrief.match(/^\/briefs\/([\w.-]+\.html)$/)
  if (!m || !cmd.sel || !cmd.sel.file || m[1] === cmd.sel.file) return
  const known = [...(cmd.data?.pending || []), ...(cmd.data?.recent || [])].find((p) => p.file === m[1])
  cmd.sel = { file: m[1], path: known ? known.path : '~/briefs/' + m[1], title: known ? known.title : m[1] }
  cmd.frame = cmd.sel.path; cmd.armed = null; cmd.q = null; cmd.row = null
  cmdBriefBar(cmdEl.querySelector('.bar'), cmd.sel)
  cmdRenderDoc()
}

function cmdRenderDoc() {
  const bar = cmdEl.querySelector('.bar'), doc = cmdEl.querySelector('.doc'), dec = cmdEl.querySelector('.decide'), s = cmd.sel
  // Not built yet (cmdRender builds the panes): a pick's /command?sid= can
  // answer before the view's first /command does. Drawing then failed after
  // cmd.frame was set, and every redraw after it found no .sbrief.
  if (!bar || !doc || !dec) return
  cmdEl.classList.toggle('doc-on', !!s)
  tblRenderTabs()
  if (!s) { doc.innerHTML = ''; dec.dataset.key = ''; cmd.frame = null; return }
  if (s.sid) return cmdRenderCall(bar, doc, dec, s)
  if (s.review) return cmdRev() ? revRenderDoc(bar, doc, dec, s) : cmdShut()
  if (s.revs) return cmdRev() ? revRenderList(bar, doc, dec, s) : cmdShut()
  if (s.slx) return cmdSlx() ? slxRenderDoc(bar, doc, dec, s) : cmdShut()
  // The frame is made once per brief: the 3 s refresh must not reload it.
  // It loads /briefs/<name>, not /file?path=: a link inside the brief
  // (← 모든 브리프, another brief) then resolves beside it in ~/briefs. Against
  // /file it became "/index.html", the office page, framed in itself.
  if (cmd.frame !== s.path) {
    cmd.frame = s.path
    cmdBriefBar(bar, s)
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;min-height:0'
    doc.innerHTML = '<iframe sandbox="allow-scripts allow-popups" src="/briefs/' + encodeURIComponent(s.file) + '"></iframe>'
  }
  const p = cmdPending(s.file)
  const act = p && cmdActive(p)
  const key = p ? JSON.stringify(cmdQs(p)) + '|' + JSON.stringify(cmd.armed) + '|' + (act && act.id) : 'none'
  if (dec.dataset.key === key) return
  // A redraw (an option armed, the 3 s poll) keeps what is typed in the boxes and where the caret is.
  const typed = {}
  dec.querySelectorAll('.note').forEach((n) => { typed[n.dataset.q] = n.value })
  const focused = document.activeElement && dec.contains(document.activeElement) ? document.activeElement.dataset.q : null
  dec.dataset.key = key
  if (!p) { dec.style.display = 'block'; dec.innerHTML = '<div class="m">이 브리프는 기다리는 결정이 없습니다 (읽기만).</div>'; return }
  const qs = cmdQs(p), dd = p.decision, multi = qs.length > 1
  dec.style.display = 'block'
  dec.innerHTML = '<div class="m" style="margin-bottom:4px">' + cmdEsc(['→ ' + (p.coordinatorName || (dd.coordinator ? 'coordinator ' + dd.coordinator.slice(0, 8) : dd.worker ? 'worker ' + dd.worker : '만든 세션')), cmdAgo(dd.asked), multi ? '질문 ' + qs.length + '개 · 다 답하면 한 번에 전달' : ''].filter(Boolean).join(' · ')) + '</div>'
  for (const q of qs) {
    const box = document.createElement('div')
    box.className = 'qa' + (q.answer ? ' done' : q === act && multi ? ' on' : '')
    box.dataset.q = q.id
    const head = (multi ? q.id + ' · ' : '') + q.question
    if (q.answer) {
      box.innerHTML = '<div class="ask">✅ ' + cmdEsc(head) + '</div><div class="m">' + cmdEsc(q.answer.choice + (q.answer.note ? ' — ' + q.answer.note : '')) + '</div>'
      dec.appendChild(box)
      continue
    }
    box.innerHTML = '<div class="ask">❓ ' + cmdEsc(head) + '</div><div class="opts"></div>'
      + '<div class="row"><input type="text" class="note" data-q="' + cmdEsc(q.id) + '" placeholder="직접 쓴 답 (Enter) · 선택지를 골랐으면 그 메모" title="Enter: 고른 선택지가 있으면 그 선택지와 이 메모를, 없으면 이 칸을 직접 답으로 보냅니다"></div>'
    const opts = box.querySelector('.opts')
    q.options.forEach((o, i) => {
      const b = document.createElement('button')
      const armed = cmd.armed && cmd.armed.q === q.id && cmd.armed.i === i
      b.className = 'act opt' + (i === q.recommended ? ' rec' : '') + (armed ? ' armed' : '')
      // Digits work on the active question only: its options carry the key.
      b.innerHTML = (q === act ? '<span class="key">' + (i + 1) + '</span>' : '') + (i === q.recommended ? '★ ' : '') + cmdEsc(o.label) + (o.detail ? '<small>' + cmdEsc(o.detail) + '</small>' : '')
      b.title = i === q.recommended ? '추천' : ''
      b.onclick = () => cmdAnswer(p, q, { label: o.label })
      opts.appendChild(b)
    })
    const note = box.querySelector('.note')
    note.value = typed[q.id] || ''
    cmdBoxKeys(note, (e) => cmdNoteKey(e, p, q))
    // Typing in a question's box, or a click on it, makes it the one the digits arm.
    note.onfocus = () => { if (multi && cmd.q !== q.id) { cmd.q = q.id; cmdRenderDoc() } }
    box.onclick = (e) => { if (multi && cmd.q !== q.id && !e.target.closest('button')) { cmd.q = q.id; cmdRenderDoc() } }
    dec.appendChild(box)
  }
  if (focused) dec.querySelector('.note[data-q="' + focused + '"]')?.focus()
}

// What a picked session offers to press: the choice drawn on its screen
// (sent as that key), else the card's quick replies (sent as a reply).
function cmdChoices(a) {
  if (!a || a.error) return []
  if (a.dialog) return a.dialog.options.map((o) => ({ label: o.label, body: { kind: 'key', value: String(o.n) } }))
  return (a.suggestions || []).map((t) => ({ label: t, body: { kind: 'reply', value: t } }))
}

// A session waiting on the person, where a brief opens: the end of its last
// answer (command.py ask_block), what it offers to press and a box. Redrawn
// only when what it asks changes, so the 3 s poll keeps what is typed.
function cmdRenderCall(bar, doc, dec, s) {
  const a = cmd.ask && cmd.ask.sid === s.sid ? cmd.ask : null, c = cmdCall(s.sid)
  // Its look is made again when it is not there, whatever cmd.frame says.
  if (cmd.frame !== 'call:' + s.sid || !doc.querySelector('.sbrief') || !doc.querySelector('.said')) {
    cmd.frame = 'call:' + s.sid
    // 🙋 waits on the person; 👷 is a session at work, opened from its table.
    bar.innerHTML = '<b title="' + cmdEsc(cmdWho(s)) + '">' + (c ? '🙋 ' : '👷 ') + cmdEsc(s.summary || s.name) + '</b>' + (s.summary && s.summary !== s.name ? '<span class="slug">' + cmdEsc(s.name) + '</span>' : '') + '<span class="m">' + cmdEsc(s.window || '') + '</span>'
      + '<span class="seg" title="마지막 답 ↔ 카드 (T · 입력칸에서는 ⌥T)"><button data-v="said" title="마지막 답"><span class="key">T</span>답</button><button data-v="card" title="카드: 지난 대화, 파일, 작업, btw">🗂 카드</button></span>'
      + '<button class="act go" title="이 세션의 tmux pane으로 (G · 입력칸에서는 ⌥G)"><span class="key">G</span>↗</button>' + (typeof crewButtons === 'function' ? crewButtons(s.sid) : '') + '<button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.go').onclick = () => cmdFocus(s)
    if (typeof crewWire === 'function') crewWire(bar, s)
    bar.querySelector('.seg').onclick = (ev) => { const b = ev.target.closest('button[data-v]'); if (b) cmdView(b.dataset.v) }
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="endarm"></div><div class="sbrief"></div><div class="said"><div class="m">불러오는 중…</div></div><div class="cardv"></div>'
    doc.querySelector('.sbrief').onclick = (ev) => { const b = ev.target.closest('button[data-brief]'); if (b) { cmdPick({ file: b.dataset.brief.split('/').pop(), path: b.dataset.brief, title: b.dataset.title }); cmdRender() } }
    dec.dataset.key = ''
    cmdRenderView()
  }
  // The end waiting for its second press (crew.js), on every redraw.
  if (typeof crewRenderArm === 'function') crewRenderArm()
  // Its brief, in both looks: one press opens it where a brief opens.
  const sb = doc.querySelector('.sbrief'), br = cmdSessionBrief(s.sid), bkey = br ? br.path + '|' + br.pending : ''
  if (sb.dataset.key !== bkey) {
    sb.dataset.key = bkey
    sb.innerHTML = br ? '<button class="briefb" data-brief="' + cmdEsc(br.path) + '" data-title="' + cmdEsc(br.title) + '" title="' + cmdEsc(br.path) + '">' + (br.pending ? '⏳ 결정 대기 · ' : '📄 브리프 · ') + cmdEsc(br.title) + '</button>' : ''
  }
  const said = doc.querySelector('.said'), skey = JSON.stringify(a && [a.error, a.text, a.cut])
  if (a && said.dataset.key !== skey) {
    said.dataset.key = skey
    bar.querySelector('.m').textContent = [a.summary && a.summary !== s.summary ? a.summary : '', a.window || s.window, a.pane, a.cwd].filter(Boolean).join(' · ')
    if (a.error) said.innerHTML = '<div class="m">' + (a.error === 'no such session' ? '이 세션이 없습니다 (창이 닫혔거나 끝났습니다).' : cmdEsc(a.error)) + '</div>'
    else said.innerHTML = (a.cut ? '<div class="cut">… 앞부분 생략 · 전체는 🗂 카드 (T)</div>' : '') + (a.text ? (typeof md === 'function' ? md(a.text) : '<pre>' + cmdEsc(a.text) + '</pre>') : '<div class="m">마지막 답이 없습니다.</div>')
    said.onclick = (ev) => { const l = ev.target.closest('a[data-open]'); if (l) { ev.preventDefault(); openLink(l.dataset.open) } }
    // The question is at the end of the answer.
    said.scrollTop = said.scrollHeight
  }
  const key = JSON.stringify([a && [a.error, a.dialog, a.suggestions, a.inbox], cmd.armed, !!c])
  if (dec.dataset.key === key) return
  const old = dec.querySelector('.note[data-call]'), typed = old?.value || '', focused = !!document.activeElement && dec.contains(document.activeElement)
  // A caret, a selection and an IME composition live in the input: it is taken out of the
  // redraw and put back (not made anew) so that a redraw under the person's hands keeps all three.
  const keep = old && old.dataset.call === s.sid && !a?.dialog && a && !a.error ? old : null
  if (keep) keep.remove()
  dec.dataset.key = key
  if (!a || a.error) { dec.style.display = 'none'; dec.innerHTML = ''; return }
  dec.style.display = 'block'
  const chs = cmdChoices(a)
  dec.innerHTML = '<div class="m" style="margin-bottom:4px">' + cmdEsc(['→ 이 세션에 직접 (coordinator를 거치지 않음)', c && c.boss ? '🎖 ' + c.boss + '의 worker' : '', c ? '' : '지금은 기다리지 않음'].filter(Boolean).join(' · ')) + '</div>'
    + (a.inbox ? '<div class="m" style="margin-bottom:4px">📨 앞서 보낸 답이 아직 전달 전: ' + cmdEsc(a.inbox.text) + '</div>' : '')
    + '<div class="qa"><div class="ask">' + (a.dialog ? '🗳 ' + cmdEsc(a.dialog.question || '화면의 선택지') : '💬 답장') + '</div><div class="opts"></div>'
    // A choice drawn on its screen takes a key, not a prompt (as on the card).
    + (a.dialog ? '<div class="m" style="margin-top:4px">권한 확인 창은 글로 답할 수 없습니다: 위 선택지를 누르거나, 그 pane에서 답하세요 · G로 이동</div>' : '<div class="row"><input type="text" class="note" data-call="' + cmdEsc(s.sid) + '" placeholder="직접 쓴 답 (Enter 보내기 · Esc 나가기)" title="Enter: 쓴 답이 있으면 그 답을, 없으면 고른 빠른 답을 보냅니다"></div>') + '</div>'
  const opts = dec.querySelector('.opts')
  chs.forEach((ch, i) => {
    const b = document.createElement('button'), armed = cmd.armed && cmd.armed.call === s.sid && cmd.armed.i === i
    b.className = 'act opt' + (armed ? ' armed' : '')
    b.innerHTML = '<span class="key">' + (i + 1) + '</span>' + cmdEsc(ch.label)
    b.onclick = () => cmdReply(s, ch.body, ch.label)
    opts.appendChild(b)
  })
  const fresh = dec.querySelector('.note[data-call]')
  if (keep && fresh) {
    fresh.replaceWith(keep)
    cmdBoxKeys(keep, (e) => cmdCallKey(e, s))
    if (focused) keep.focus({ preventScroll: true })
    return
  }
  const note = dec.querySelector('.note')
  if (note) {
    note.value = typed
    cmdBoxKeys(note, (e) => cmdCallKey(e, s))
    if (focused) note.focus()
  }
}

// Bring the picked session's pane in front in tmux, as the card's G does
// (office.html focusPane: /focus runs cc-focus, which switches every attached
// client to its window and selects the pane). The pane is the one /command
// last saw, so a session that moved since is still found.
function cmdFocus(s) {
  const pane = (cmd.ask && cmd.ask.sid === s.sid && cmd.ask.pane) || cmdCall(s.sid)?.pane
  if (!pane) { toast('이 세션의 pane을 모릅니다'); return }
  focusPane(pane)
  toast('↗ ' + (s.summary || s.name) + ' (' + pane + ')')
}

// A box's own keys go in through this, never as `el.onkeydown = (e) => key(e)`:
// a handler property that returns false cancels the event, and the box key
// functions return false for every key they leave alone, so each letter and
// each Hangul jamo typed by hand was cancelled before it reached the box.
// (`tweb type` inserts text without a keydown, which is why it still typed.)
function cmdBoxKeys(el, key) { el.onkeydown = (e) => { key(e) } }

// Keys in a session's box: Enter sends the words typed, or with none the
// quick reply armed (a brief's box sends the armed option with the words as
// its note; a session's reply has no note, so the words win), or a toast says
// what to do. Esc leaves the box. Everything else is typing.
function cmdCallKey(e, s) {
  if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); return true }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false
  e.preventDefault()
  const text = e.target.value.trim(), ch = cmd.armed && cmd.armed.call === s.sid ? cmdChoices(cmd.ask)[cmd.armed.i] : null
  if (text) cmdReply(s, { kind: 'reply', value: text }, '답장')
  else if (ch) cmdReply(s, ch.body, ch.label)
  else toast('빠른 답을 고르거나(숫자 뒤 Enter, 또는 클릭) 답을 쓰고 Enter')
  return true
}

// An answer to a waiting session, as the floor card sends it: a key for the
// choice on its screen, or a reply (its next prompt, by the office inbox).
// Not coord_say: the person answers the session itself, in their own words,
// and a coordinator's hold on its worker (coord_send's held) never stops it.
// A session at work, or with a reply not yet taken, is busy: a second Enter
// within 8 s sends it anyway, as on the card.
async function cmdReply(s, body, label) {
  const sig = JSON.stringify([s.sid, body])
  const force = !!cmd.force && cmd.force.sig === sig && Date.now() - cmd.force.at < 8000
  cmd.force = null
  const j = await cmdPost({ sid: s.sid, ...body, ...(force ? { force: true } : {}) }, true)
  if (!j) return false
  if (j.busy) {
    cmd.force = { sig, at: Date.now() }
    toast((j.busy === 'working' ? '🔨 일하는 중이라 보내면 끝난 뒤 이어서 처리됩니다' : '📨 앞서 보낸 답이 아직 전달 전입니다') + ' — 그래도 보내려면 한 번 더 Enter')
    return false
  }
  toast('📨 ' + label + ' → ' + (s.summary || s.name))
  const waited = !!cmdCall(s.sid)
  if (waited) tblMark((R) => R.row.sid === s.sid)
  cmd.sent[s.sid] = Date.now()
  // A session at work the person spoke to stays open: they went to it on purpose.
  if (!waited) {
    const n = cmdEl.querySelector('.decide .note[data-call]')
    if (n) n.value = ''
    cmd.armed = null
    cmdAsk()
    return true
  }
  // On to the row's next need, else the next row (table.js): the answered
  // call leaves the row for a minute (cmd.sent), as the server catches up.
  tblAfter()
  return true
}

// Keys in a question's box. Enter sends: the option armed for this question
// with the box as its note; with none armed, the box itself as the answer
// (직접 답); with neither, a toast says what to do. Esc leaves the box. The
// rest is typing: j/k, digits and the floor's keys never see the box's keys
// (office.html's officeKey stops at a text field), so the box owns Enter.
function cmdNoteKey(e, p, q) {
  if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); return true }
  // keyCode 229: WebKit's Enter that ends a Hangul composition.
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false
  e.preventDefault()
  const text = e.target.value.trim()
  if (cmd.armed && cmd.armed.q === q.id) cmdAnswer(p, q, { label: q.options[cmd.armed.i].label })
  else if (text) cmdAnswer(p, q, { text })
  else toast('선택지를 고르거나(숫자 뒤 Enter, 또는 클릭) 직접 답을 쓰고 Enter')
  return true
}

// Close the brief beside the panel; the floor shows again. A waiting
// decision is not picked again on its own until the list changes.
function cmdShut() {
  cmd.sel = null; cmd.armed = null; cmd.q = null; cmd.ask = null; cmd.force = null; cmd.view = 'said'; cmd.card = null; cmd.row = null; cmd.shut = (cmd.data?.pending || []).map((p) => p.file).join('|')
  cmdRenderDoc()
  cmdRenderSay()
}

// busyOk: a 409 that says busy comes back as { busy } for the caller to ask again.
async function cmdPost(body, busyOk = false) {
  try {
    const r = await fetch('/act', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN }, body: JSON.stringify(body) })
    if (r.status === 403) { staleToken(); return null }
    const j = await r.json().catch(() => ({}))
    if (busyOk && r.status === 409 && j.busy) return j
    if (!r.ok) { toast('✕ ' + (j.error || r.status)); return null }
    return j
  } catch (e) { toast('✕ 못 보냈습니다: ' + e.message); return null }
}

// One question's answer: an option (`label`, the box as its note) or the
// person's own words (`text`). The server tells whoever asked once the
// brief's last question is answered; until then the brief stays up.
async function cmdAnswer(p, q, { label = '', text = '' }) {
  const box = cmdEl.querySelector('.decide .qa[data-q="' + q.id + '"]')
  const note = text ? '' : box?.querySelector('.note')?.value || ''
  box?.querySelectorAll('button, input').forEach((b) => { b.disabled = true })
  const j = await cmdPost({ kind: 'brief_answer', file: p.file, qid: q.id, label, note, text })
  if (!j) { box?.querySelectorAll('button, input').forEach((b) => { b.disabled = false }); return }
  toast('✅ ' + (j.sent || label || '직접 답'))
  q.answer = text ? { choice: '직접 답', note: text } : { choice: label, note }
  cmd.armed = null; cmd.q = null
  const open = cmdOpen(p)
  if (open.length) {
    p.decision = open[0]
    cmdRenderDoc()
    cmdEl.querySelector('.decide .note[data-q="' + open[0].id + '"]')?.focus()
    return
  }
  // Its row and the order marked, out of the data, then on: the row's next
  // need, else the next row.
  tblMark((R) => R.row.decisions?.includes(p.file))
  const rest = (cmd.data?.pending || []).filter((x) => x.file !== p.file)
  cmd.data.pending = rest
  commandCount(rest.length)
  tblAfter()
}

// Keys while the command view is up (office.html's officeKey asks first).
// C toggles the view from the floor and back, decisions waiting or not.
// TWeb's normal mode keeps almost every bare letter for itself (c is its
// command palette, d half a page down), so ⌥C does the same and works
// everywhere, a text box included, as the office's other ⌥ keys do; a bare
// C in a box is typing. D still toggles for a browser without TWeb. An open
// card keeps C and ⌥C for its MCP reconnect. Esc goes back to the office
// (first closing an open brief); in the task box or the note, Esc only
// leaves the box and the next Esc closes. i to the task box on top, m to the
// active question's box; j/k through the table's rows that need the person
// (never the rows folded under 그 밖, which wait on nobody); Tab / ⇧Tab
// (⌥Tab, and ⌥[ ⌥] for TWeb's normal mode) through the open row's tabs; a digit arms an
// option of the active question (a picked session's choice or quick reply;
// 1 a review item's 확인함) and Enter sends it, so one stray key never
// decides. ⌥I, ⌥J and ⌥K do what i, j and k do, for TWeb's normal mode
// (⌥I from a box too). G (⌥G in its box) goes to a picked session's
// tmux pane. T (⌥T in its box) turns a picked session's look between its
// last answer and its card; on the card ⌥1…⌥9 pick its tab ([ ] are the
// row's tabs; its shelf takes them only with no row open). b (⌥B, ⇧ backwards) opens the brief line's next brief.
// X (⌥X) ends the picked session; an adopted one on a second press (crew.js). In a box every key is typing; its Enter is cmdNoteKey's
// (cmdCallKey's in a session's box).
function commandKey(e, k, typing) {
  const cardUp = typeof card !== 'undefined' && card.style.display === 'block'
  if (k === 'c' && (e.altKey || !typing) && !cardUp) { e.preventDefault(); setCommand(!cmd.on); return true }
  // ⌥G to the picked session's pane works in its box too, as on the card.
  if (k === 'g' && e.altKey && cmd.on && cmd.sel?.sid && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); cmdFocus(cmd.sel); return true }
  // ⌥T (T outside a box): TWeb's normal mode keeps bare t.
  if (k === 't' && (e.altKey || !typing) && cmd.on && cmd.sel?.sid && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); cmdView(); return true }
  // X (⌥X from a box; TWeb's normal mode keeps bare x): end the picked session (crew.js).
  if (k === 'x' && (e.altKey || !typing) && cmd.on && cmd.sel?.sid && typeof crewEnd === 'function' && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); crewEnd(cmd.sel); return true }
  // b (⌥B from anywhere, a box included) through the brief line.
  if (k === 'b' && (e.altKey || !typing) && cmd.on && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) return cmdBriefWalk(e)
  if (/^[1-9]$/.test(k) && e.altKey && cmd.on && cmdCardUp() && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); cmd.card.selectTab(+k - 1); return true }
  // ⌥M to a picked review item's box: TWeb's normal mode keeps bare m (live, 8899).
  if (k === 'm' && e.altKey && !typing && cmd.on && (cmd.sel?.review || cmd.sel?.revs) && cmdRev() && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); revFocus(); return true }
  // ⌥I to the task box, from anywhere (a box included), and ⌥J/⌥K through
  // what waits on the person: TWeb's normal mode keeps bare i, j and k.
  if (k === 'i' && e.altKey && cmd.on && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) { e.preventDefault(); cmdEl.querySelector('.say textarea')?.focus(); return true }
  if ((k === 'j' || k === 'k') && e.altKey && !typing && cmd.on && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) return cmdWalk(e, k)
  // ⌥[ ⌥] (and ⌥Tab): the open row's tabs, where TWeb's normal mode keeps the bare keys.
  if ((k === '[' || k === ']' || k === 'Tab') && e.altKey && !typing && cmd.on && !cardUp && !(typeof viewer !== 'undefined' && viewer.path)) return cmdTabKey(e, k === '[' || (k === 'Tab' && e.shiftKey) ? -1 : 1)
  if (e.altKey || typing) return false
  if (!cmd.on) {
    if (k === 'd') { e.preventDefault(); setCommand(true); return true }
    return false
  }
  if (cardUp) return false
  if (typeof viewer !== 'undefined' && viewer.path) return false
  const hit = (fn) => { e.preventDefault(); fn(); return true }
  // A trigger's armed choice (slx.js) backs out first: 3 and 4 take numbers of their own.
  if (k === 'Escape' && cmd.sel?.slx && cmd.armed?.slx) return hit(() => { cmd.armed = null; cmdRenderDoc() })
  if (k === 'Escape' && cmd.sel) return hit(cmdShut)
  if (k === 'Escape' || k === 'd') return hit(() => setCommand(false))
  // j/k only: the arrows walk the floor beside the panel.
  if (k === 'j' || k === 'k') return cmdWalk(e, k)
  // Tab / ⇧Tab: the open row's tabs; with none open (or one tab) the floor's.
  if (k === 'Tab') return cmdTabKey(e, e.shiftKey ? -1 : 1)
  const s = cmd.sel && cmd.sel.sid ? cmd.sel : null
  if (s) {
    const chs = cmdChoices(cmd.ask && cmd.ask.sid === s.sid ? cmd.ask : null)
    if (/^[1-9]$/.test(k) && +k <= chs.length) return hit(() => { cmd.armed = { call: s.sid, i: +k - 1 }; cmdRenderDoc(); toast('Enter로 「' + chs[+k - 1].label + '」 보내기') })
    if (k === 'Enter' && cmd.armed && cmd.armed.call === s.sid && chs[cmd.armed.i]) return hit(() => cmdReply(s, chs[cmd.armed.i].body, chs[cmd.armed.i].label))
    if (k === 'm') return hit(() => cmdEl.querySelector('.decide .note[data-call]')?.focus())
    if (k === 'g') return hit(() => cmdFocus(s))
  }
  // [ ]: the open row's tabs (Tab's twin); the card's own tabs are ⌥1…⌥9,
  // and its shelf takes [ ] only when no row with two tabs is open.
  if ((k === '[' || k === ']') && cmdTabKey(e, k === ']' ? 1 : -1)) return true
  if (s && (k === '[' || k === ']') && cmdCardUp()?.shelfTab) return hit(() => cmd.card.shelfTab(k === ']' ? 1 : -1))
  if ((cmd.sel?.review || cmd.sel?.revs) && cmdRev() && revKey(k, cmd.sel, hit)) return true
  if (cmd.sel?.slx && cmdSlx() && slxKey(k, cmd.sel, hit)) return true
  const p = cmd.sel && cmdPending(cmd.sel.file)
  const q = p && cmdActive(p)
  if (q && /^[1-9]$/.test(k) && +k <= q.options.length) return hit(() => { cmd.armed = { q: q.id, i: +k - 1 }; cmdRenderDoc(); toast('Enter로 「' + q.options[+k - 1].label + '」 보내기') })
  if (q && k === 'Enter' && cmd.armed && cmd.armed.q === q.id) return hit(() => cmdAnswer(p, q, { label: q.options[cmd.armed.i].label }))
  if (k === 'i') return hit(() => cmdEl.querySelector('.say textarea')?.focus())
  if (k === 'm') return hit(() => cmdEl.querySelector('.decide .note[data-q="' + (q ? q.id : '') + '"]')?.focus())
  // Everything else goes to the floor, which stays in sight beside the panel.
  return false
}

// j/k (⌥J/⌥K): to the next or previous row that needs the person, in the
// order the table shows. Nothing open, or a row from under 그 밖 (never in
// the walk): j starts at the first, k at the last. Nothing waiting: the key
// is the floor's.
function cmdWalk(e, k) {
  const list = tblOrder()
  if (!list.length) return false
  e.preventDefault()
  const at = list.indexOf(tblCur())
  const i = at < 0 ? (k === 'j' ? -1 : 0) : at
  tblOpen(list[(i + (k === 'j' ? 1 : -1) + list.length) % list.length])
  return true
}

// Tab / ⇧Tab: the open row's next or previous tab; false (the floor's key)
// when no row with two tabs is open.
function cmdTabKey(e, dir) {
  if (!tblStep(dir)) return false
  e.preventDefault()
  return true
}

cmdSwitch()
try { if (localStorage.getItem('office.mode') === 'command') setCommand(true) } catch { /* no storage: start in the office */ }

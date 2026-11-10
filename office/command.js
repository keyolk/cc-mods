// The command view (지휘): the office seen from the coordinators' side.
//
// A panel on the right of the floor, which stays in sight and live: the
// decisions waiting on the person (briefs whose sidecar asks a question
// nobody has answered), each coordinator's workers, who on the floor waits on
// the person, the briefs lately written, and a box to instruct a coordinator.
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
// An instruction for a worker goes to its coordinator, never to the worker:
// typing to a worker yourself is what the office floor's card is for.
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
#command .q { border: 2px solid rgba(59,42,53,.18); border-radius: 10px; padding: 6px 8px; margin-bottom: 6px; cursor: pointer; background: #fff; }
#command .q.sel { border-color: #2a2033; background: #fff3c4; }
#command .q .t { font-size: 13px; }
#command .q .ask { font: 12px/1.4 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: 2px 0; }
#command table { width: 100%; border-collapse: collapse; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; margin-bottom: 10px; }
#command th { text-align: left; font-weight: 600; color: #7a7090; border-bottom: 2px solid rgba(59,42,53,.18); padding: 2px 4px; }
#command td { border-bottom: 1px solid rgba(59,42,53,.1); padding: 3px 4px; vertical-align: top; }
#command tr.w, #command h3.c { cursor: pointer; }
#command h3.c.sel { text-decoration: underline; }
#command tr.w:hover td { background: #f3ecdf; }
#command tr.w.sel td { background: #fff3c4; }
#command .st-waiting, #command .st-asking { color: #b7791f; } #command .st-alert { color: #c0392b; } #command .st-working { color: #2f855a; } #command .st-gone { color: #9a93a8; }
#command .say { border-top: 2px solid rgba(59,42,53,.14); padding: 8px 12px; }
#command textarea, #command input[type=text] { width: 100%; font: 13px -apple-system, sans-serif; border: 2px solid var(--line); border-radius: 10px; padding: 5px 8px; }
#command textarea { min-height: 44px; resize: vertical; }
#command button.act { font: inherit; font-size: 13px; border: 2px solid var(--line); border-radius: 10px; padding: 3px 10px; cursor: pointer; background: #fff; box-shadow: 0 2px 0 var(--line); }
#command button.act:active { transform: translateY(2px); box-shadow: none; }
#command button.act:disabled { opacity: .45; cursor: default; }
#command .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 2px solid var(--line); font-size: 13px; }
#command .bar .m { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command iframe { flex: 1; width: 100%; border: 0; background: #fff; min-height: 0; }
#command .feed { font: 12px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: 0 0 10px; padding: 0; list-style: none; }
#command .feed li { padding: 2px 4px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#command .feed li:hover { background: #f3ecdf; }
#command .feed li.sel { background: #fff3c4; outline: 2px solid #2a2033; }
#command .said { flex: 1; overflow: auto; padding: 10px 14px; font: 13px/1.55 -apple-system, "Apple SD Gothic Neo", sans-serif; background: #fff; min-height: 0; }
#command .said p { margin: 0 0 6px; }
#command .said h1, #command .said h2, #command .said h3, #command .said h4 { font-size: 14px; margin: 8px 0 4px; }
#command .said ul, #command .said ol { margin: 0 0 6px; padding-left: 18px; }
#command .said code { font: 12px ui-monospace, Menlo, monospace; background: rgba(59,42,53,.08); border-radius: 4px; padding: 0 3px; }
#command .said pre { background: #2a2033; color: #f3ecdf; border-radius: 8px; padding: 6px 8px; overflow-x: auto; white-space: pre; }
#command .said pre code { background: none; padding: 0; color: inherit; }
#command .said .cut { color: #7a7090; font-size: 11px; margin-bottom: 6px; }
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
const cmd = { on: false, data: null, sel: null, worker: null, coord: null, armed: null, q: null, timer: null, frame: null, pendingN: 0, ask: null, force: null, sent: {} }
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
function cmdPick(p) { cmd.sel = { file: p.file, path: p.path, title: p.title }; cmd.armed = null; cmd.q = null }
const cmdCall = (sid) => (cmd.data?.calls || []).find((c) => c.sid === sid)
function cmdPickCall(c) { cmd.sel = { sid: c.sid, name: c.name, window: c.window }; cmd.armed = null; cmd.q = null; cmd.force = null; cmdAsk() }
// What j/k walk: the waiting briefs, then the sessions waiting on the person.
function cmdItems() {
  return [...(cmd.data?.pending || []).map((p) => ({ p })), ...(cmd.data?.calls || []).map((c) => ({ c }))]
}
const cmdIsSel = (it) => !!cmd.sel && (it.p ? cmd.sel.file === it.p.file : cmd.sel.sid === it.c.sid)
function cmdGo(it) { if (it.p) cmdPick(it.p); else cmdPickCall(it.c); cmdRender() }

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
  // Nothing picked yet: the decision that has waited longest.
  if (!cmd.sel && d.pending.length && cmd.shut !== d.pending.map((p) => p.file).join('|')) cmdPick(d.pending[0])
  if (!cmdEl.firstChild) {
    cmdEl.innerHTML = '<div class="pane left"><div class="list"></div><div class="say"></div></div><div class="pane right"><div class="bar"></div><div class="doc"></div><div class="decide"></div></div>'
    cmdEl.querySelector('.list').onclick = cmdClick
  }
  const list = cmdEl.querySelector('.list'), keep = list.scrollTop
  const out = ['<h3>⏳ 결정 대기 <span class="m">' + d.pending.length + '건 · 오래 기다린 순 · j/k</span></h3>']
  if (!d.pending.length) out.push('<div class="m" style="margin-bottom:10px">기다리는 결정이 없습니다. coordinator가 <code>brief ask</code>로 질문을 달면 여기에 나옵니다.</div>')
  for (const p of d.pending) {
    const sel = cmd.sel && cmd.sel.file === p.file
    const open = cmdOpen(p), more = open.length > 1 ? ' <span class="m">외 ' + (open.length - 1) + '건</span>' : ''
    out.push('<div class="q' + (sel ? ' sel' : '') + '" data-file="' + cmdEsc(p.file) + '"><div class="t">📄 ' + cmdEsc(p.title) + '</div><div class="ask">' + cmdEsc(p.decision.question) + more + '</div><div class="m">'
      + cmdEsc([p.coordinatorName ? '🎖 ' + p.coordinatorName : '', p.decision.worker ? '👷 ' + p.decision.worker : '', cmdAgo(p.decision.asked)].filter(Boolean).join(' · ')) + '</div></div>')
  }
  for (const c of d.coordinators) {
    const csel = !cmd.worker && cmdCoord()?.sid === c.sid
    out.push('<h3 class="c' + (csel ? ' sel' : '') + '" data-coord="' + cmdEsc(c.sid) + '" title="이 coordinator에게 지시">🎖 ' + cmdEsc(c.name) + ' <span class="m">' + cmdEsc([c.window, c.live ? STATE_KO[c.state] || c.state : '창 없음', ATTN_KO[c.attention] || ''].filter(Boolean).join(' · ')) + '</span></h3>')
    if (!c.workers.length) { out.push('<div class="m" style="margin-bottom:10px">worker가 없습니다.</div>'); continue }
    out.push('<table><tr><th>worker</th><th>model/effort</th><th>상태</th><th>브리프</th></tr>')
    for (const w of c.workers) {
      const sel = cmd.worker && cmd.worker.coord === c.sid && cmd.worker.slug === w.slug
      const st = !w.live ? 'gone' : w.doing === 'asking' || w.doing === 'alert' ? w.doing : w.state
      out.push('<tr class="w' + (sel ? ' sel' : '') + '" data-coord="' + cmdEsc(c.sid) + '" data-slug="' + cmdEsc(w.slug) + '"><td>' + cmdEsc(w.slug) + (w.relation === 'adopted' ? ' <span class="m">입양</span>' : '') + '</td><td>' + cmdEsc((w.model || '-') + '/' + (w.effort || '-')) + '</td>'
        + '<td class="st-' + cmdEsc(st) + '">' + cmdEsc(w.live ? STATE_KO[w.state] || w.state || '?' : '창 없음') + (ATTN_KO[w.attention] ? ' ' + ATTN_KO[w.attention] : '') + '</td>'
        + '<td>' + (w.brief ? '<a href="#" data-brief="' + cmdEsc(w.brief.path) + '" data-title="' + cmdEsc(w.brief.title) + '">' + (w.brief.pending ? '⏳ ' : '📄 ') + cmdEsc(w.brief.title.slice(0, 24)) + '</a>' : '<span class="m">—</span>') + '</td></tr>')
    }
    out.push('</table>')
  }
  if (!d.coordinators.length) out.push('<div class="m" style="margin-bottom:10px">켜진 coordinator가 없습니다. 세션에서 <code>/coord on</code>.</div>')
  const calls = d.calls || []
  out.push('<h3>🙋 나를 기다리는 세션 <span class="m">' + calls.length + ' · 누르면 옆에 열림 · j/k</span></h3>')
  out.push(calls.length ? '<ul class="feed">' + calls.map((c) => '<li data-call="' + cmdEsc(c.sid) + '"' + (cmd.sel && cmd.sel.sid === c.sid ? ' class="sel"' : '') + '>' + (c.attention === 'alert' ? '❗ ' : '❓ ') + cmdEsc(c.name) + ' <span class="m">' + cmdEsc([c.window, c.boss ? '🎖 ' + c.boss : '', Date.now() - (cmd.sent[c.sid] || 0) < 60000 ? '📨 답 보냄' : ''].filter(Boolean).join(' · ')) + '</span></li>').join('') + '</ul>' : '<div class="m" style="margin-bottom:10px">없습니다.</div>')
  const recent = d.recent || []
  out.push('<h3>📄 최근 브리프 <span class="m">누르면 옆에 열림</span></h3>')
  out.push(recent.length ? '<ul class="feed">' + recent.map((b) => '<li data-brief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.file) + '">' + (b.pending ? '⏳ ' : '') + cmdEsc(b.title) + ' <span class="m">' + cmdEsc([b.by, cmdAgo(new Date(b.at * 1000).toISOString())].filter(Boolean).join(' · ')) + '</span></li>').join('') + '</ul>' : '<div class="m">브리프가 없습니다.</div>')
  list.innerHTML = out.join('')
  list.scrollTop = keep
  cmdRenderSay()
  cmdRenderDoc()
}

function cmdClick(ev) {
  const li = ev.target.closest('li[data-call]')
  if (li) { const c = cmdCall(li.dataset.call); if (c) { cmdPickCall(c); cmdRender() } return }
  const a = ev.target.closest('[data-brief]')
  if (a) { ev.preventDefault(); cmdPick({ file: a.dataset.brief.split('/').pop(), path: a.dataset.brief, title: a.dataset.title }); return cmdRender() }
  const q = ev.target.closest('.q')
  if (q) { const p = cmdPending(q.dataset.file); if (p) { cmdPick(p); cmdRender() } return }
  const h = ev.target.closest('h3.c')
  if (h) {
    cmd.worker = null; cmd.coord = h.dataset.coord
    cmdRender()
    cmdEl.querySelector('.say textarea')?.focus()
    return
  }
  const tr = ev.target.closest('tr.w')
  if (tr) {
    cmd.worker = { coord: tr.dataset.coord, slug: tr.dataset.slug }
    cmdRender()
    cmdEl.querySelector('.say textarea')?.focus()
  }
}

// The coordinator the box speaks to when no worker is picked: the one last
// clicked, else the first with a live window.
function cmdCoord() {
  const cs = cmd.data?.coordinators || []
  return cs.find((x) => x.sid === cmd.coord) || cs.find((x) => x.live) || cs[0]
}

// The instruction box, always there: to the coordinator itself, which routes
// the task to a session (coord_route), or with a worker row picked, to that
// worker by way of its coordinator.
function cmdRenderSay() {
  const box = cmdEl.querySelector('.say'), w = cmd.worker
  let c = w && (cmd.data?.coordinators || []).find((x) => x.sid === w.coord)
  if (w && (!c || !c.workers.some((x) => x.slug === w.slug))) { cmd.worker = null; c = null }
  const slug = cmd.worker ? w.slug : ''
  c = c || cmdCoord()
  if (!c) {
    box.dataset.for = ''
    box.innerHTML = '<div class="m">켜진 coordinator가 없어 지시할 곳이 없습니다. 세션에서 <code>/coord on</code>.</div>'
    return
  }
  if (box.dataset.for === c.sid + '/' + slug) return // keep what is being typed
  box.dataset.for = c.sid + '/' + slug
  const to = slug ? '🎖 ' + cmdEsc(c.name) + '에게 → 👷 <b>' + cmdEsc(slug) + '</b> 지시' : '🎖 <b>' + cmdEsc(c.name) + '</b>에게 지시'
  const hint = slug ? 'coord_send로 전달' : 'coordinator가 맡을 세션을 고릅니다 · 직접 고르려면 worker 행을 누르세요'
  box.innerHTML = '<div class="m" style="margin-bottom:4px">' + to + ' <span class="m">(' + hint + ' · Enter 보내기 · Shift+Enter 줄바꿈)</span></div><textarea placeholder="' + (slug ? '예: 테스트부터 고치고 다시 READY' : '할 일을 쓰면 coordinator가 맡을 세션을 고릅니다 (예: keyolk/briefs의 X 고쳐줘)') + '"></textarea><div class="row" style="margin-top:4px"><button class="act go">보내기</button>' + (slug ? '<button class="act cancel">worker 선택 해제</button>' : '') + '</div>'
  const ta = box.querySelector('textarea')
  const go = async () => {
    const text = ta.value.trim()
    if (!text) return
    const j = await cmdPost({ kind: 'coord_say', coord: c.sid, slug, value: text })
    if (j) { ta.value = ''; toast('📨 ' + (j.sent || '보냈습니다')) }
  }
  box.querySelector('.go').onclick = go
  const cancel = box.querySelector('.cancel')
  if (cancel) cancel.onclick = () => { cmd.worker = null; cmdRender() }
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go() } else if (e.key === 'Escape') { e.preventDefault(); ta.blur() } }
}

function cmdRenderDoc() {
  const bar = cmdEl.querySelector('.bar'), doc = cmdEl.querySelector('.doc'), dec = cmdEl.querySelector('.decide'), s = cmd.sel
  cmdEl.classList.toggle('doc-on', !!s)
  if (!s) { doc.innerHTML = ''; dec.dataset.key = ''; cmd.frame = null; return }
  if (s.sid) return cmdRenderCall(bar, doc, dec, s)
  // The frame is made once per brief: the 3 s refresh must not reload it.
  if (cmd.frame !== s.path) {
    cmd.frame = s.path
    bar.innerHTML = '<b>📄 ' + cmdEsc(s.title || s.file) + '</b><span class="m">' + cmdEsc(s.path) + '</span><button class="act out">↗ 밖으로</button><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.out').onclick = () => openLink(s.path)
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;min-height:0'
    doc.innerHTML = '<iframe sandbox="allow-scripts allow-popups" src="/file?sid=command&path=' + encodeURIComponent(s.path) + '"></iframe>'
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
    note.onkeydown = (e) => cmdNoteKey(e, p, q)
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
  if (cmd.frame !== 'call:' + s.sid) {
    cmd.frame = 'call:' + s.sid
    bar.innerHTML = '<b>🙋 ' + cmdEsc(s.name) + '</b><span class="m">' + cmdEsc(s.window || '') + '</span><button class="act card" title="이 세션의 카드 (지난 대화, 파일, btw)">🗂 카드</button><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.card').onclick = () => { if (typeof openCard === 'function') openCard(s.sid) }
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="said"><div class="m">불러오는 중…</div></div>'
    dec.dataset.key = ''
  }
  const said = doc.querySelector('.said'), skey = JSON.stringify(a && [a.error, a.text, a.cut])
  if (a && said.dataset.key !== skey) {
    said.dataset.key = skey
    bar.querySelector('.m').textContent = [a.window || s.window, a.pane, a.cwd].filter(Boolean).join(' · ')
    if (a.error) said.innerHTML = '<div class="m">' + (a.error === 'no such session' ? '이 세션이 없습니다 (창이 닫혔거나 끝났습니다).' : cmdEsc(a.error)) + '</div>'
    else said.innerHTML = (a.cut ? '<div class="cut">… 앞부분 생략 · 전체는 🗂 카드</div>' : '') + (a.text ? (typeof md === 'function' ? md(a.text) : '<pre>' + cmdEsc(a.text) + '</pre>') : '<div class="m">마지막 답이 없습니다.</div>')
    said.onclick = (ev) => { const l = ev.target.closest('a[data-open]'); if (l) { ev.preventDefault(); openLink(l.dataset.open) } }
    // The question is at the end of the answer.
    said.scrollTop = said.scrollHeight
  }
  const key = JSON.stringify([a && [a.error, a.dialog, a.suggestions, a.inbox], cmd.armed, !!c])
  if (dec.dataset.key === key) return
  const typed = dec.querySelector('.note[data-call]')?.value || '', focused = !!document.activeElement && dec.contains(document.activeElement)
  dec.dataset.key = key
  if (!a || a.error) { dec.style.display = 'none'; dec.innerHTML = ''; return }
  dec.style.display = 'block'
  const chs = cmdChoices(a)
  dec.innerHTML = '<div class="m" style="margin-bottom:4px">' + cmdEsc(['→ 이 세션에 직접 (coordinator를 거치지 않음)', c && c.boss ? '🎖 ' + c.boss + '의 worker · 답하면 coordinator가 10분 동안 보내지 않음' : '', c ? '' : '지금은 기다리지 않음'].filter(Boolean).join(' · ')) + '</div>'
    + (a.inbox ? '<div class="m" style="margin-bottom:4px">📨 앞서 보낸 답이 아직 전달 전: ' + cmdEsc(a.inbox.text) + '</div>' : '')
    + '<div class="qa"><div class="ask">' + (a.dialog ? '🗳 ' + cmdEsc(a.dialog.question || '화면의 선택지') : '💬 답장') + '</div><div class="opts"></div>'
    // A choice drawn on its screen takes a key, not a prompt (as on the card).
    + (a.dialog ? '' : '<div class="row"><input type="text" class="note" data-call="' + cmdEsc(s.sid) + '" placeholder="직접 쓴 답 (Enter 보내기 · Esc 나가기)" title="Enter: 쓴 답이 있으면 그 답을, 없으면 고른 빠른 답을 보냅니다"></div>') + '</div>'
  const opts = dec.querySelector('.opts')
  chs.forEach((ch, i) => {
    const b = document.createElement('button'), armed = cmd.armed && cmd.armed.call === s.sid && cmd.armed.i === i
    b.className = 'act opt' + (armed ? ' armed' : '')
    b.innerHTML = '<span class="key">' + (i + 1) + '</span>' + cmdEsc(ch.label)
    b.onclick = () => cmdReply(s, ch.body, ch.label)
    opts.appendChild(b)
  })
  const note = dec.querySelector('.note')
  if (note) {
    note.value = typed
    note.onkeydown = (e) => cmdCallKey(e, s)
    if (focused) note.focus()
  }
}

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
// and the server marks the pane as theirs, so its coordinator holds it
// instead of answering too. A session at work, or with a reply not yet
// taken, is busy: a second Enter within 8 s sends it anyway, as on the card.
async function cmdReply(s, body, label) {
  const sig = JSON.stringify([s.sid, body])
  const force = !!cmd.force && cmd.force.sig === sig && Date.now() - cmd.force.at < 8000
  cmd.force = null
  const j = await cmdPost({ sid: s.sid, ...body, ...(force ? { force: true } : {}) }, true)
  if (!j) return
  if (j.busy) {
    cmd.force = { sig, at: Date.now() }
    toast((j.busy === 'working' ? '🔨 일하는 중이라 보내면 끝난 뒤 이어서 처리됩니다' : '📨 앞서 보낸 답이 아직 전달 전입니다') + ' — 그래도 보내려면 한 번 더 Enter')
    return
  }
  toast('📨 ' + label + ' → ' + s.name)
  cmd.sent[s.sid] = Date.now()
  // On to the next one waiting, as an answered brief goes on to the next brief.
  const items = cmdItems(), at = items.findIndex(cmdIsSel)
  const next = [...items.slice(at + 1), ...items.slice(0, Math.max(0, at))].find((it) => it.p || Date.now() - (cmd.sent[it.c.sid] || 0) > 60000)
  if (next) cmdGo(next)
  else { cmdShut(); cmdRender() }
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
  cmd.sel = null; cmd.armed = null; cmd.q = null; cmd.ask = null; cmd.force = null; cmd.shut = (cmd.data?.pending || []).map((p) => p.file).join('|')
  cmdRenderDoc()
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
  // On to the next waiting brief.
  const rest = (cmd.data?.pending || []).filter((x) => x.file !== p.file)
  cmd.data.pending = rest
  if (rest[0]) cmdPick(rest[0]); else cmd.sel = null
  commandCount(rest.length)
  cmdRender()
}

// Keys while the command view is up (office.html's officeKey asks first).
// C toggles the view from the floor and back, decisions waiting or not.
// TWeb's normal mode keeps almost every bare letter for itself (c is its
// command palette, d half a page down), so ⌥C does the same and works
// everywhere, a text box included, as the office's other ⌥ keys do; a bare
// C in a box is typing. D still toggles for a browser without TWeb. An open
// card keeps C and ⌥C for its MCP reconnect. Esc goes back to the office
// (first closing an open brief); in the instruction box or the note, Esc
// only leaves the box and the next Esc closes. i to the instruction box, m
// to the active question's box; j/k through the waiting briefs and then the
// sessions waiting on the person; a digit arms an option of the active
// question (a picked session's choice or quick reply) and Enter sends it, so
// one stray key never decides. In a box every key is typing; its Enter is
// cmdNoteKey's (cmdCallKey's in a session's box).
function commandKey(e, k, typing) {
  const cardUp = typeof card !== 'undefined' && card.style.display === 'block'
  if (k === 'c' && (e.altKey || !typing) && !cardUp) { e.preventDefault(); setCommand(!cmd.on); return true }
  if (e.altKey || typing) return false
  if (!cmd.on) {
    if (k === 'd') { e.preventDefault(); setCommand(true); return true }
    return false
  }
  if (cardUp) return false
  if (typeof viewer !== 'undefined' && viewer.path) return false
  const hit = (fn) => { e.preventDefault(); fn(); return true }
  if (k === 'Escape' && cmd.sel) return hit(cmdShut)
  if (k === 'Escape' || k === 'd') return hit(() => setCommand(false))
  const list = cmdItems()
  // j/k only: the arrows walk the floor beside the panel.
  if ((k === 'j' || k === 'k') && list.length) {
    // Nothing picked (the view was closed on them): j starts at the first, k at the last.
    const at = list.findIndex(cmdIsSel)
    const i = at < 0 ? (k === 'j' ? -1 : 0) : at
    const n = list[(i + (k === 'j' ? 1 : -1) + list.length) % list.length]
    return hit(() => cmdGo(n))
  }
  const s = cmd.sel && cmd.sel.sid ? cmd.sel : null
  if (s) {
    const chs = cmdChoices(cmd.ask && cmd.ask.sid === s.sid ? cmd.ask : null)
    if (/^[1-9]$/.test(k) && +k <= chs.length) return hit(() => { cmd.armed = { call: s.sid, i: +k - 1 }; cmdRenderDoc(); toast('Enter로 「' + chs[+k - 1].label + '」 보내기') })
    if (k === 'Enter' && cmd.armed && cmd.armed.call === s.sid && chs[cmd.armed.i]) return hit(() => cmdReply(s, chs[cmd.armed.i].body, chs[cmd.armed.i].label))
    if (k === 'm') return hit(() => cmdEl.querySelector('.decide .note[data-call]')?.focus())
  }
  const p = cmd.sel && cmdPending(cmd.sel.file)
  const q = p && cmdActive(p)
  if (q && /^[1-9]$/.test(k) && +k <= q.options.length) return hit(() => { cmd.armed = { q: q.id, i: +k - 1 }; cmdRenderDoc(); toast('Enter로 「' + q.options[+k - 1].label + '」 보내기') })
  if (q && k === 'Enter' && cmd.armed && cmd.armed.q === q.id) return hit(() => cmdAnswer(p, q, { label: q.options[cmd.armed.i].label }))
  if (k === 'i') return hit(() => cmdEl.querySelector('.say textarea')?.focus())
  if (k === 'm') return hit(() => cmdEl.querySelector('.decide .note[data-q="' + (q ? q.id : '') + '"]')?.focus())
  // Everything else goes to the floor, which stays in sight beside the panel.
  return false
}

cmdSwitch()
try { if (localStorage.getItem('office.mode') === 'command') setCommand(true) } catch { /* no storage: start in the office */ }

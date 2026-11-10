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

// armed: { q, i } (option i of question q, waiting for Enter); q: the question
// digits and m go to, when the person picked one by hand.
const cmd = { on: false, data: null, sel: null, worker: null, coord: null, armed: null, q: null, timer: null, frame: null, pendingN: 0 }
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
  out.push('<h3>🙋 나를 기다리는 세션 <span class="m">' + calls.length + ' · 누르면 카드</span></h3>')
  out.push(calls.length ? '<ul class="feed">' + calls.map((c) => '<li data-card="' + cmdEsc(c.sid) + '">' + (c.attention === 'alert' ? '❗ ' : '❓ ') + cmdEsc(c.name) + ' <span class="m">' + cmdEsc(c.window || '') + '</span></li>').join('') + '</ul>' : '<div class="m" style="margin-bottom:10px">없습니다.</div>')
  const recent = d.recent || []
  out.push('<h3>📄 최근 브리프 <span class="m">누르면 옆에 열림</span></h3>')
  out.push(recent.length ? '<ul class="feed">' + recent.map((b) => '<li data-brief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.file) + '">' + (b.pending ? '⏳ ' : '') + cmdEsc(b.title) + ' <span class="m">' + cmdEsc([b.by, cmdAgo(new Date(b.at * 1000).toISOString())].filter(Boolean).join(' · ')) + '</span></li>').join('') + '</ul>' : '<div class="m">브리프가 없습니다.</div>')
  list.innerHTML = out.join('')
  list.scrollTop = keep
  cmdRenderSay()
  cmdRenderDoc()
}

function cmdClick(ev) {
  const li = ev.target.closest('li[data-card]')
  if (li) { if (typeof openCard === 'function') openCard(li.dataset.card); return }
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
  cmd.sel = null; cmd.armed = null; cmd.q = null; cmd.shut = (cmd.data?.pending || []).map((p) => p.file).join('|')
  cmdRenderDoc()
}

async function cmdPost(body) {
  try {
    const r = await fetch('/act', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN }, body: JSON.stringify(body) })
    if (r.status === 403) { staleToken(); return null }
    const j = await r.json().catch(() => ({}))
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
// to the active question's box; j/k through the waiting briefs; a digit arms
// an option of the active question and Enter sends it, so one stray key
// never decides. In a box every key is typing; its Enter is cmdNoteKey's.
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
  const list = cmd.data?.pending || []
  // j/k only: the arrows walk the floor beside the panel.
  if ((k === 'j' || k === 'k') && list.length) {
    // Nothing picked (the view was closed on them): j starts at the first, k at the last.
    const at = list.findIndex((p) => cmd.sel && p.file === cmd.sel.file)
    const i = at < 0 ? (k === 'j' ? -1 : 0) : at
    const n = list[(i + (k === 'j' ? 1 : -1) + list.length) % list.length]
    return hit(() => { cmdPick(n); cmdRender() })
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

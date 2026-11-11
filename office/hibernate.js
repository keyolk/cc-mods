// Sessions put to sleep, and the ones that may be (휴면), in the command view.
//
// The person asked to take long-idle sessions down to save memory and bring
// them back from the office. office/hibernate.py decides who may sleep and
// does the work; /command carries `hibernate`: { cards, candidates, mb, auto,
// pressure, pins }. Drawn under the table:
// - 💤 휴면 N (folded): a row per sleeping session, its summary, when it went
//   down and how much it gave back, and 깨우기, which resumes it in a new
//   pane in the same directory (its old window when there is room).
// - ▸ 휴면 후보 N개 · 회수 예상 X GB [모두 내리기]: the list is the server's;
//   the press asks once more within 8 s. Under memory pressure the server
//   puts them to sleep itself (auto "pressure", office.json). 휴면 후보 N개
//   unfolds a row per candidate: what it is doing (its summary), how long it
//   has idled, what it would give back and why it is one (idle, 세션 상한),
//   with 💤 휴면 (this one, asked once more), 📌 고정 and ↗ 열기 (its pane).
//   Before, the names were only in the 모두 내리기 tooltip, as pane titles
//   (`agent`), and the person could not tell which to put down.
// A picked session's bar gets 💤 (put this one to sleep now, the idle time
// not needed but every other rule kept) and 📌 (never propose it). A brief
// recorded on a sleeping session gets 💤 깨우기 in its bar. Loaded before
// command.js, which calls these only when they are defined.

const HIB_CSS = `
#command .hibfoot { font: 12px/1.6 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: -4px 0 10px; color: #5a5070; }
#command .hibfoot button, #command .hiblist button { font: 11.5px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 6px; cursor: pointer; margin: 0 2px; }
#command .hibfoot button.armed { background: #c0392b; color: #fff; border-color: #c0392b; }
#command .hibfoot .warn { color: #c0392b; font-weight: 600; }
#command .hiblist { list-style: none; margin: 0 0 10px; padding: 0; font: 12px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .hiblist li { padding: 3px 6px; border-bottom: 1px dashed rgba(59,42,53,.15); }
#command .hiblist li .m { color: #7a7090; }
#command .hiblist.cand li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
#command .hiblist.cand li b { flex: 1 1 12em; font-weight: 600; }
#command .hiblist button.armed { background: #c0392b; color: #fff; border-color: #c0392b; }
#command .hibfoot button.cand { border: 0; background: none; padding: 0; margin: 0; text-decoration: underline; color: inherit; font: inherit; }
#command button.act.hib.on { background: #fff3c4; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: HIB_CSS }))

const hib = { open: false, candOpen: false, allArmed: 0, oneArmed: null, busy: {} }
const HIB_CONFIRM_MS = 8000
const hibData = () => cmd.data?.hibernate || { cards: [], candidates: [], mb: 0, pins: [] }
const hibCard = (sid) => hibData().cards.find((c) => c.sid === sid)
const hibPinned = (sid) => hibData().pins.includes(sid)
const hibGB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB')
function hibWhen(sec) { return sec ? new Date(sec * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '' }

// The lines under the table; '' when there is nothing to say.
function hibFoot() {
  const d = hibData(), cs = d.cards || [], cands = d.candidates || []
  if (!cs.length && !cands.length) return ''
  const parts = []
  if (cs.length) parts.push('<button data-hib="fold">' + (hib.open ? '▾' : '▸') + ' 💤 휴면 ' + cs.length + '</button>')
  if (cands.length) {
    const armed = Date.now() - hib.allArmed < HIB_CONFIRM_MS
    // A candidate the session cap brought in (`why: cap`) is marked: it has
    // rested hours, not half a day, and only a press puts it to sleep.
    const nCap = cands.filter((c) => c.why === 'cap').length
    parts.push('<button class="cand" data-hib="cands" title="후보 목록 ' + (hib.candOpen ? '접기' : '보기') + '">' + (hib.candOpen ? '▾' : '▸') + ' 휴면 후보 ' + cands.length + '개</button>' + (nCap ? ' (세션 상한 ' + nCap + ')' : '') + ' · 회수 예상 ' + hibGB(d.mb || 0) + ' <button data-hib="all" class="' + (armed ? 'armed' : '') + '" title="' + cmdEsc(cands.map((c) => (c.summary || c.name) + ' (' + c.idleH + 'h' + (c.why === 'cap' ? ' · 상한' : '') + ')').join(', ')) + '">' + (armed ? '한 번 더: 모두 내리기' : '모두 내리기') + '</button>')
  }
  // Over the session cap: how many run, and the cap.
  if (d.cap && d.cap.on) parts.push('<span class="warn">세션 ' + d.cap.live + '/' + d.cap.max + ' (상한 초과)</span>')
  if (d.pressure && d.pressure.on) parts.push('<span class="warn">메모리 압박' + (d.auto === 'off' ? '' : ' · 자동 휴면 켜짐') + '</span>')
  let out = '<div class="hibfoot">' + parts.join(' · ') + '</div>'
  if (hib.candOpen && cands.length) out += '<ul class="hiblist cand">' + cands.map(hibCandRow).join('') + '</ul>'
  if (hib.open && cs.length) out += '<ul class="hiblist">' + cs.map(hibRow).join('') + '</ul>'
  return out
}

// A candidate: what it is doing, its idle time, what it gives back and why
// it is one; 💤 휴면 asks once more (8 s), as 모두 내리기 does.
function hibCandRow(c) {
  const armed = hib.oneArmed && hib.oneArmed.sid === c.sid && Date.now() - hib.oneArmed.at < HIB_CONFIRM_MS
  const busy = hib.busy[c.sid], pinned = hibPinned(c.sid)
  const why = c.why === 'cap' ? '세션 상한' : 'idle'
  return '<li><b>' + cmdEsc(c.summary || c.name || c.sid.slice(0, 8)) + '</b>'
    + (c.summary && c.name && c.summary !== c.name ? '<span class="slug">' + cmdEsc(c.name) + '</span>' : '')
    + '<span class="m">' + cmdEsc(c.idleH + '시간 idle · ~' + hibGB(c.mb || 0) + ' · ' + why + (c.window ? ' · ' + c.window : '')) + '</span>'
    + '<span><button data-hib="one" data-sid="' + cmdEsc(c.sid) + '" class="' + (armed ? 'armed' : '') + '"' + (busy ? ' disabled' : '') + ' title="이 세션만 내립니다 (프로세스 종료, 대화는 남음)">' + (busy ? '내리는 중…' : armed ? '한 번 더: 💤 휴면' : '💤 휴면') + '</button>'
    + '<button data-hib="pin" data-sid="' + cmdEsc(c.sid) + '" title="' + (pinned ? '고정 해제' : '휴면 후보에서 뺍니다') + '">📌 ' + (pinned ? '고정 해제' : '고정') + '</button>'
    + (c.pane ? '<button data-hib="go" data-pane="' + cmdEsc(c.pane) + '" title="그 pane으로 이동">↗ 열기</button>' : '') + '</span></li>'
}

function hibRow(c) {
  const t = c.turn || {}, busy = hib.busy[c.sid]
  return '<li><b>💤 ' + cmdEsc(c.summary || c.name) + '</b> <span class="slug">' + cmdEsc(c.name || '') + '</span> '
    + '<button data-hib="wake" data-sid="' + cmdEsc(c.sid) + '"' + (busy || c.wokeAt ? ' disabled' : '') + '>' + (busy || c.wokeAt ? '깨우는 중…' : '깨우기') + '</button>'
    + '<div class="m">' + cmdEsc(hibWhen(c.at)) + '에 내림' + (c.auto ? ' (자동)' : '') + ' · ~' + cmdEsc(hibGB(c.mb || 0)) + ' · ' + cmdEsc(c.cwd || '') + '</div>'
    + (t.ask ? '<div class="m">요청: ' + cmdEsc(t.ask.split('\n')[0].slice(0, 160)) + '</div>' : '')
    + (t.said ? '<div class="m">답: ' + cmdEsc(t.said.slice(0, 160)) + '</div>' : '')
    + (c.dropped && c.dropped.length ? '<div class="m">다시 띄울 때 빠지는 인자: ' + cmdEsc(c.dropped.join(' ').slice(0, 120)) + '</div>' : '') + '</li>'
}

// A click in the list on one of these; false when it was not one.
function hibClick(ev) {
  const b = ev.target.closest('button[data-hib]')
  if (!b) return false
  const what = b.dataset.hib
  if (what === 'fold') { hib.open = !hib.open; cmdRender() } else if (what === 'all') hibAll()
  else if (what === 'cands') hibCandFold(!hib.candOpen)
  else if (what === 'one') hibOne(b.dataset.sid)
  else if (what === 'pin') hibPin(b.dataset.sid)
  else if (what === 'go') { if (typeof focusPane === 'function') focusPane(b.dataset.pane); toast('↗ ' + b.dataset.pane) }
  else if (what === 'wake') hibWake(b.dataset.sid)
  return true
}

// The unfolded list is a layer of its own (layers.js): Esc first takes back
// an armed 💤 휴면, then folds the list, before the 지휘 view's own steps;
// a layer opened over it (🔑 인증) closes before it.
function hibCandFold(open) {
  hib.candOpen = open
  if (!open) hib.oneArmed = null
  if (open && typeof layerUp === 'function') {
    layerUp('hibcands', () => hib.candOpen && cmd.on, () => hibCandFold(false), () => {
      if (hib.oneArmed && Date.now() - hib.oneArmed.at < HIB_CONFIRM_MS) { hib.oneArmed = null; cmdRender(); return true }
      return false
    })
  }
  cmdRender()
}

async function hibOne(sid) {
  if (!sid || hib.busy[sid]) return
  if (!(hib.oneArmed && hib.oneArmed.sid === sid && Date.now() - hib.oneArmed.at < HIB_CONFIRM_MS)) {
    hib.oneArmed = { sid, at: Date.now() }
    toast('한 번 더 누르면 이 세션을 내립니다')
    setTimeout(cmdRender, HIB_CONFIRM_MS + 50)
    return cmdRender()
  }
  hib.oneArmed = null
  hib.busy[sid] = true
  cmdRender()
  const j = await cmdPost({ kind: 'hibernate', sid })
  delete hib.busy[sid]
  if (j) toast('💤 ' + (j.sent || '휴면'))
  cmdLoad()
}

async function hibPin(sid) {
  const j = await cmdPost({ kind: 'hibernate_pin', sid, on: !hibPinned(sid) })
  if (j) toast(j.sent)
  cmdLoad()
}

async function hibAll() {
  if (Date.now() - hib.allArmed >= HIB_CONFIRM_MS) {
    hib.allArmed = Date.now()
    toast('한 번 더 누르면 휴면 후보 ' + hibData().candidates.length + '개를 모두 내립니다')
    setTimeout(cmdRender, HIB_CONFIRM_MS + 50)
    return cmdRender()
  }
  hib.allArmed = 0
  toast('💤 내리는 중…')
  const j = await cmdPost({ kind: 'hibernate_all' })
  if (j) toast(j.sent || '내렸습니다')
  cmdLoad()
}

async function hibWake(sid) {
  if (!sid || hib.busy[sid]) return false
  hib.busy[sid] = true
  cmdRender()
  const j = await cmdPost({ kind: 'wake', sid })
  delete hib.busy[sid]
  if (j) toast('☀ ' + (j.sent || '깨웠습니다'))
  cmdLoad()
  return !!j
}

// The bar of a picked session: 💤 now, and 📌. Not for a coordinator.
function hibButtons(sid) {
  if ((cmd.data?.coordinators || []).some((c) => c.sid === sid)) return ''
  return '<button class="act hib" title="지금 휴면 (프로세스 종료, 대화는 남음)">💤</button>'
    + '<button class="act hib pin' + (hibPinned(sid) ? ' on' : '') + '" title="' + (hibPinned(sid) ? '📌 고정 해제' : '📌 고정: 휴면 후보에서 뺌') + '">📌</button>'
}
function hibWire(bar, s) {
  const [now, pin] = bar.querySelectorAll('.hib')
  if (now) now.onclick = () => hibNow(s)
  if (pin) pin.onclick = async () => { const j = await cmdPost({ kind: 'hibernate_pin', sid: s.sid, on: !hibPinned(s.sid) }); if (j) toast(j.sent); cmdLoad() }
}
async function hibNow(s) {
  toast('💤 내리는 중…')
  const j = await cmdPost({ kind: 'hibernate', sid: s.sid })
  if (!j) return
  toast(j.sent || '휴면')
  if (cmd.sel && cmd.sel.sid === s.sid) cmdShut()
  cmdLoad()
}

// A brief whose session sleeps: 💤 깨우기 in its bar.
function hibBriefButton(file) {
  const c = hibData().cards.find((x) => x.brief && x.brief.file === file)
  return c ? '<button class="act hibwake" data-sid="' + cmdEsc(c.sid) + '" title="이 브리프의 세션을 깨웁니다 (' + cmdEsc(c.name || '') + ')">💤 깨우기</button>' : ''
}
function hibBriefWire(bar) {
  const b = bar.querySelector('.hibwake')
  if (b) b.onclick = () => hibWake(b.dataset.sid)
}

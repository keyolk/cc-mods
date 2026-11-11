// Sessions put to sleep, and the ones that may be (휴면), in the command view.
//
// The person asked to take long-idle sessions down to save memory and bring
// them back from the office. office/hibernate.py decides who may sleep and
// does the work; /command carries `hibernate`: { cards, candidates, mb, auto,
// pressure, pins }. Drawn under the table:
// - 💤 휴면 N (folded): a row per sleeping session, its summary, when it went
//   down and how much it gave back, and 깨우기, which resumes it in a new
//   pane in the same directory (its old window when there is room).
// - 휴면 후보 N개 · 회수 예상 X GB [모두 내리기]: the list is the server's;
//   the press asks once more within 8 s. Under memory pressure the server
//   puts them to sleep itself (auto "pressure", office.json).
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
#command button.act.hib.on { background: #fff3c4; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: HIB_CSS }))

const hib = { open: false, allArmed: 0, busy: {} }
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
    parts.push('휴면 후보 ' + cands.length + '개' + (nCap ? ' (세션 상한 ' + nCap + ')' : '') + ' · 회수 예상 ' + hibGB(d.mb || 0) + ' <button data-hib="all" class="' + (armed ? 'armed' : '') + '" title="' + cmdEsc(cands.map((c) => c.name + ' (' + c.idleH + 'h' + (c.why === 'cap' ? ' · 상한' : '') + ')').join(', ')) + '">' + (armed ? '한 번 더: 모두 내리기' : '모두 내리기') + '</button>')
  }
  // Over the session cap: how many run, and the cap.
  if (d.cap && d.cap.on) parts.push('<span class="warn">세션 ' + d.cap.live + '/' + d.cap.max + ' (상한 초과)</span>')
  if (d.pressure && d.pressure.on) parts.push('<span class="warn">메모리 압박' + (d.auto === 'off' ? '' : ' · 자동 휴면 켜짐') + '</span>')
  let out = '<div class="hibfoot">' + parts.join(' · ') + '</div>'
  if (hib.open && cs.length) out += '<ul class="hiblist">' + cs.map(hibRow).join('') + '</ul>'
  return out
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
  else if (what === 'wake') hibWake(b.dataset.sid)
  return true
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

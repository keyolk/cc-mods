// The person's day in the command view (지휘): one line under the brief line,
// and the day unfolded beside the panel.
//
// office/agenda.py reads the calendar through gcl (`gcl -json`, every 5 min,
// in the background) and /command carries `agenda`: { events, now, next,
// untilNext, free, error, loading, canWrite, links, prs }.
// - The line: the meeting under way (and how long it has left), else the
//   next one and how long until it; the next free stretch; how many
//   invitations wait on my reply. A click opens the day.
// - The day (the right pane): today's and tomorrow's meetings. Each shows its
//   time, my reply, ↗ (the event, the call), and its people; beside a person,
//   what in the office names them (a session, a brief, a review, a Slack or
//   Meerkat item) and the open PRs they wrote or review. A session opens its
//   row; a link opens in the default browser.
// - Replies (수락 · 미정 · 거절) and 🗓 시간 찾기 (the meeting's people, a
//   30-minute slot in the next 7 days) go out through gcl. A reply is an
//   outward write: the first press arms it, a second within 8 s sends it.
// Loaded before command.js, which calls these only when they are defined.

const AGENDA_CSS = `
#command .agline { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-bottom: 2px solid rgba(59,42,53,.14); background: #f4f8ff; font: 12px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; cursor: pointer; white-space: nowrap; overflow: hidden; }
#command .agline:empty { display: none; }
#command .agline.sel { background: #e3eeff; }
#command .agline .now { color: #b03a2e; font-weight: 600; }
#command .agline .t { overflow: hidden; text-overflow: ellipsis; }
#command .agline .m, #command .agday .m { color: #6a6080; }
#command .agline .warn { color: #c0392b; }
#command .agday { font: 12.5px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; padding: 8px 12px; overflow: auto; flex: 1; min-height: 0; }
#command .agday h3 { margin: 10px 0 4px; font-size: 13px; }
#command .agday .ev { border: 2px solid rgba(59,42,53,.18); border-radius: 10px; padding: 6px 9px; margin-bottom: 6px; background: #fff; }
#command .agday .ev.now { border-color: #b03a2e; }
#command .agday .ev.next { border-color: #2a6fdb; }
#command .agday .ev.past { opacity: .55; }
#command .agday .ev.declined .tt { text-decoration: line-through; }
#command .agday .ev .tt { font-weight: 600; }
#command .agday .ev .ppl { margin: 4px 0 0; padding: 0; list-style: none; }
#command .agday .ev .ppl li { padding: 2px 0; }
#command .agday .ev .ppl .lk { display: block; margin-left: 14px; font-size: 11.5px; }
#command .agday .ev .ppl .lk > * { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command .agday button { font: 11.5px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 7px; cursor: pointer; margin: 0 2px; }
#command .agday button.armed { background: #c0392b; color: #fff; border-color: #c0392b; }
#command .agday button:disabled { opacity: .5; cursor: default; }
#command .agday .slots { margin: 4px 0 0 0; padding-left: 16px; }
#command .agday .free { color: #2e7d32; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: AGENDA_CSS }))

const ag = { open: false, armed: null, busy: {}, found: {}, more: {} }
const AG_CONFIRM_MS = 8000
const AG_PEOPLE = 8
const AG_REPLY = { yes: ['수락', 'accepted'], maybe: ['미정', 'tentative'], no: ['거절', 'declined'] }
const AG_MINE = { accepted: '✓ 수락', tentative: '? 미정', declined: '✕ 거절', needsAction: '응답 대기' }
const AG_KIND = { session: '🧑‍💻', review: '🔎', brief: '📄', slack: '📨', meerkat: '🚨', pr: '🔀' }
const agData = () => cmd.data?.agenda || null

function agClock(sec) { return new Date(sec * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) }
function agLeft(s) {
  if (s == null) return ''
  const m = Math.max(0, Math.round(s / 60))
  if (m < 60) return m + '분'
  const h = Math.floor(m / 60), r = m % 60
  return h >= 24 ? Math.floor(h / 24) + '일' : h + '시간' + (r ? ' ' + r + '분' : '')
}
const agEv = (id) => (agData()?.events || []).find((e) => e.id === id)
const agWaiting = (d) => (d.events || []).filter((e) => e.mine === 'needsAction' && !e.allDay && e.end * 1000 > Date.now())

// The line under the brief line; '' with no agenda (a server without one).
function agLineHtml() {
  const d = agData()
  if (!d) return ''
  if (!d.events.length) return '<span class="m">📅 ' + cmdEsc(d.error || (d.loading ? '일정을 읽는 중…' : '오늘 일정 없음')) + '</span>'
  const now = Date.now() / 1000, parts = []
  const cur = (d.now || []).map(agEv).filter(Boolean)[0]
  if (cur) parts.push('<span class="now">● ' + cmdEsc(cur.title) + '</span> <span class="m">' + agLeft(cur.end - now) + ' 남음</span>')
  const nx = agEv(d.next)
  if (nx) parts.push('<span class="t">' + (cur ? '다음 ' : '') + cmdEsc(nx.title) + '</span> <span class="m">' + (nx.day ? '내일 ' + agClock(nx.start) : agLeft(nx.start - now) + ' 뒤') + '</span>')
  const f = (d.free || [])[0]
  if (f) parts.push('<span class="free">' + (f.start <= now + 60 ? '지금부터 ' : agClock(f.start) + '부터 ') + agLeft(f.end - Math.max(f.start, now)) + ' 빔</span>')
  const w = agWaiting(d).length
  if (w) parts.push('<span class="warn">응답 대기 ' + w + '</span>')
  if (d.error) parts.push('<span class="warn" title="' + cmdEsc(d.error) + '">⚠</span>')
  return '📅 ' + (parts.join(' <span class="m">·</span> ') || '<span class="m">남은 회의 없음</span>')
}

function agRenderLine() {
  const left = cmdEl.querySelector('.pane.left')
  if (!left) return
  let el = left.querySelector('.agline')
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'agline', title: '오늘 일정 (A, ⌥A)' })
    left.insertBefore(el, left.querySelector('.list'))
    el.onclick = () => agToggle()
  }
  el.innerHTML = agLineHtml()
  el.classList.toggle('sel', !!(cmd.sel && cmd.sel.agenda))
}

function agToggle() {
  if (cmd.sel && cmd.sel.agenda) { cmd.sel = null } else { cmd.sel = { agenda: true }; cmd.row = null }
  cmdRender()
}

function agLinks(email) {
  const hs = (agData()?.links || {})[email] || []
  if (!hs.length) return ''
  return '<span class="lk">' + hs.map((h) => {
    const icon = AG_KIND[h.kind] || '•', label = cmdEsc(h.label) + (h.role ? ' <span class="m">(' + cmdEsc(h.role) + ')</span>' : '')
    if (h.kind === 'session' && h.ref.sid) return '<a href="#" data-agsid="' + cmdEsc(h.ref.sid) + '">' + icon + ' ' + label + '</a>'
    const url = h.ref.url || h.ref.link
    if (url) return '<a href="#" data-agurl="' + cmdEsc(url) + '">' + icon + ' ' + label + '</a>'
    return '<span>' + icon + ' ' + label + '</span>'
  }).join('') + '</span>'
}

function agPerson(p, organizer) {
  const name = p.name || p.email.split('@')[0]
  const r = { accepted: '✓', declined: '✕', tentative: '?' }[p.response] || '·'
  return '<li><span class="m">' + r + '</span> ' + cmdEsc(name) + (p.email === organizer ? ' <span class="m">(주최)</span>' : '') + agLinks(p.email) + '</li>'
}

function agEventHtml(e, d) {
  const now = Date.now() / 1000
  const cls = ['ev', (d.now || []).includes(e.id) ? 'now' : '', d.next === e.id ? 'next' : '', !e.allDay && e.end < now ? 'past' : '', e.mine === 'declined' ? 'declined' : ''].join(' ')
  const when = e.allDay ? '종일' : agClock(e.start) + '–' + agClock(e.end)
  const others = e.attendees.filter((p) => !p.self)
  // The people linked to something first: they are who the meeting is for.
  const lk = agData()?.links || {}
  others.sort((a, b) => (lk[b.email] ? 1 : 0) - (lk[a.email] ? 1 : 0))
  const shown = ag.more[e.id] ? others : others.slice(0, AG_PEOPLE)
  const invited = e.attendees.some((p) => p.self)
  let h = '<div class="' + cls + '" data-agev="' + cmdEsc(e.id) + '"><div><span class="m">' + when + '</span> <span class="tt">' + cmdEsc(e.title) + '</span>'
  if (invited) h += ' <span class="m">' + cmdEsc(AG_MINE[e.mine] || '') + '</span>'
  if (e.conference) h += ' <a href="#" data-agurl="' + cmdEsc(e.conference) + '">📹</a>'
  if (e.link) h += ' <a href="#" data-agurl="' + cmdEsc(e.link) + '" title="Google Calendar">↗</a>'
  h += '</div>'
  if (!e.allDay && e.end > now && (invited || others.length)) {
    h += '<div>'
    if (invited && d.canWrite) {
      h += Object.entries(AG_REPLY).map(([k, [label, status]]) => {
        const armed = ag.armed && ag.armed.id === e.id && ag.armed.reply === k && Date.now() - ag.armed.at < AG_CONFIRM_MS
        return '<button data-agreply="' + k + '" class="' + (armed ? 'armed' : '') + '"' + (e.mine === status || ag.busy[e.id] ? ' disabled' : '') + '>' + (armed ? '한 번 더: ' : '') + label + '</button>'
      }).join('')
    }
    if (others.length && d.canWrite) h += '<button data-agfind="1"' + (ag.busy['find:' + e.id] ? ' disabled' : '') + ' title="이 회의 사람들과 7일 안의 30분">🗓 시간 찾기</button>'
    if (!d.canWrite) h += '<span class="m">응답·시간 찾기: gcl을 새로 설치하면 됩니다</span>'
    h += '</div>'
  }
  const found = ag.found[e.id]
  if (found) h += '<ul class="slots">' + (found.slots || []).slice(0, 6).map((s) => '<li>' + cmdEsc(new Date(s.start).toLocaleString('ko-KR', { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })) + (s.allFree ? ' <span class="free">모두 가능</span>' : ' <span class="m">불가: ' + cmdEsc((s.busy || []).map((x) => x.split('@')[0]).join(', ')) + '</span>') + '</li>').join('') + (found.slots && found.slots.length ? '' : '<li class="m">빈 시간이 없습니다</li>') + '</ul>'
  if (shown.length) h += '<ul class="ppl">' + shown.map((p) => agPerson(p, e.organizer)).join('') + '</ul>'
  if (others.length > shown.length) h += '<a href="#" data-agmore="1" class="m">+' + (others.length - shown.length) + '명 더</a>'
  return h + '</div>'
}

// The right pane when the day is picked. Drawn again only when what it shows
// changed: the view polls every 3 s, and a redraw would drop the scroll.
function agRenderDoc(bar, doc, dec) {
  const d = agData()
  if (cmd.frame !== 'agenda') {
    cmd.frame = 'agenda'
    bar.innerHTML = '<b>📅 오늘 일정</b><span class="m"></span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="agday"></div>'
    doc.onclick = agDayClick
    dec.dataset.key = ''
    dec.innerHTML = ''
    ag.key = null
  }
  const el = doc.querySelector('.agday')
  const h = agDayHtml(d)
  if (h === ag.key) return
  ag.key = h
  const keep = el.scrollTop
  el.innerHTML = h
  el.scrollTop = keep
}

function agDayHtml(d) {
  if (!d) return '<div class="m">이 서버에는 일정이 없습니다</div>'
  const days = [0, 1].map((n) => d.events.filter((e) => e.day === n))
  const free = (d.free || []).map((f) => agClock(f.start) + '–' + agClock(f.end)).join(', ')
  let h = ''
  if (d.error) h += '<div class="m">⚠ ' + cmdEsc(d.error) + (d.events.length ? ' (마지막으로 읽은 일정)' : '') + '</div>'
  if (d.prs && d.prs.error) h += '<div class="m">⚠ PR: ' + cmdEsc(d.prs.error) + '</div>'
  h += '<h3>오늘</h3>' + (free ? '<div class="free">빈 시간 ' + cmdEsc(free) + '</div>' : '') + (days[0].map((e) => agEventHtml(e, d)).join('') || '<div class="m">일정 없음</div>')
  if (days[1].length) h += '<h3>내일</h3>' + days[1].map((e) => agEventHtml(e, d)).join('')
  return h + '<div class="m">' + (d.at ? agClock(d.at) + '에 읽음 · 5분마다' : '') + (d.prs ? ' · 열린 PR ' + d.prs.count : '') + '</div>'
}

function agDayClick(ev) {
  const a = ev.target.closest('a[data-agurl], a[data-agsid], a[data-agmore]')
  const box = ev.target.closest('[data-agev]'), id = box && box.dataset.agev
  if (a) {
    ev.preventDefault()
    if (a.dataset.agurl) cmdPost({ kind: 'agenda_open', url: a.dataset.agurl }).then((j) => { if (j) toast('↗ ' + (j.sent || '열었습니다')) })
    else if (a.dataset.agsid) { const R = tblAll().find((x) => x.row.sid === a.dataset.agsid); if (R) tblOpen(R.row.key); else toast('그 세션은 지금 표에 없습니다') }
    else if (id) { ag.more[id] = true; cmdRenderDoc() }
    return
  }
  const b = ev.target.closest('button[data-agreply], button[data-agfind]')
  if (!b || !id) return
  if (b.dataset.agreply) agReply(id, b.dataset.agreply)
  else agFind(id)
}

async function agReply(id, reply) {
  const e = agEv(id)
  if (!e || ag.busy[id]) return
  const armed = ag.armed && ag.armed.id === id && ag.armed.reply === reply && Date.now() - ag.armed.at < AG_CONFIRM_MS
  if (!armed) {
    ag.armed = { id, reply, at: Date.now() }
    toast('한 번 더 누르면 「' + e.title + '」에 ' + AG_REPLY[reply][0] + '으로 답합니다 (주최자에게 메일이 갑니다)')
    setTimeout(() => { if (ag.armed && ag.armed.id === id) { ag.armed = null; cmdRenderDoc() } }, AG_CONFIRM_MS + 50)
    return cmdRenderDoc()
  }
  ag.armed = null
  ag.busy[id] = true
  cmdRenderDoc()
  const j = await cmdPost({ kind: 'agenda_rsvp', id, reply })
  delete ag.busy[id]
  if (j) { toast('📅 ' + (j.note || '답했습니다')); e.mine = AG_REPLY[reply][1] }
  cmdRenderDoc()
  cmdLoad()
}

async function agFind(id) {
  const e = agEv(id)
  if (!e) return
  ag.busy['find:' + id] = true
  cmdRenderDoc()
  const j = await cmdPost({ kind: 'agenda_find', with: e.attendees.filter((p) => !p.self).map((p) => p.email).slice(0, 20), minutes: 30, days: 7 })
  delete ag.busy['find:' + id]
  if (j) ag.found[id] = j
  cmdRenderDoc()
}

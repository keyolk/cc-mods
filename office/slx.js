// The slx inbox in the command view (지휘): the Slack mentions and DMs that
// look for the person, and Meerkat incidents, as slx collects them
// (office/slx.py reads `slx list` into /command's `slx`). A trigger is a
// candidate for a session: the person makes one, or puts it away.
//
// Where a trigger shows:
// - its session has a row in the table (table.js): as 📨 / 🚨 in that row's
//   cells, with a count when several ride on it, and a 📨 slx tab;
// - no session, or an ended one: a row of its own in the table, after the
//   rows that need the person (office/turn.py);
// - its session at work with no row in the table: under ⚙ 진행 중 in the slx
//   line below the table (slxFoot), folded.
//
// A picked trigger opens where a brief does: its message (an incident's
// title and alert summary), its links, and one key per choice, each sent with
// Enter: 1 세션 만들기 (slx open, as its b key: in the background), 2 무시
// (slx done: back only on a new mention), 3 이런 것 숨기기 (slx mute: the
// same channel, sender or text; an incident's service, alert or text), 4
// 나중에 (slx snooze: 1 h, 3 h, tomorrow 9:00, next Monday 9:00). 3 and 4
// show their own choices, picked by number. ☐ on a trigger's row marks it; with rows
// marked the slx line offers 무시, 나중에 and 같은 곳 숨기기 on all of them,
// and 모두 무시 takes every trigger row at a second press. The slx line also
// counts what is hidden and opens the mute rules, each with 해제.
//
// With slx's TUI off, 1 is [⏻ slx 켜기 · 세션 만들기]: the office has slx
// start its TUI in its own tmux session (slx up) and then opens the session,
// one press. With an older slx TUI up (it runs, but from before slx said
// so), 1 is [↻ slx 다시 시작 · 세션 만들기]: slx quits that one as a person
// would (Escape, q) and starts the new one; one that does not quit is left
// to the person, with where it is. The slx line offers the same, alone.
// Nothing here writes to Slack. Loaded before command.js.

const SLX_CSS = `
#command .slxv h4 { font-size: 12px; color: #7a7090; margin: 10px 0 2px; font-weight: 600; }
#command .slxv h4:first-child { margin-top: 0; }
#command .slxv .msg { white-space: pre-wrap; word-break: break-word; }
#command .slxv ul.links { margin: 0; padding-left: 18px; }
#command .slxv ul.links a { word-break: break-all; }
#command .slxv .rule { display: flex; gap: 8px; align-items: center; padding: 3px 0; border-top: 1px solid rgba(59,42,53,.08); }
#command .slxv .rule b { font-weight: 600; flex: 1; }
#command .slxfoot { font: 12px/1.6 -apple-system, "Apple SD Gothic Neo", sans-serif; margin: -4px 0 10px; color: #5a5070; }
#command .slxfoot button { font: 11.5px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 6px; cursor: pointer; margin: 0 2px; }
#command .slxfoot button.armed { background: #c0392b; color: #fff; border-color: #c0392b; }
#command .slxfoot .marks { display: block; margin-top: 2px; }
#command .slxmk { cursor: pointer; margin-right: 2px; }
#command .decide .sub { margin-top: 6px; }
#command .decide .sub input { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; width: 60%; border: 1px solid rgba(59,42,53,.4); border-radius: 6px; padding: 2px 6px; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: SLX_CSS }))

// The rules view's pick: not an id slx can have.
const SLX_RULES = '!rules'
// marks: trigger id -> true; allArmed: when 모두 무시 was pressed once; runOpen: ⚙ 진행 중 unfolded.
const slxUi = { marks: {}, allArmed: 0, runOpen: false, upping: false }

const slxData = () => cmd.data?.slx || { items: [], old: 0, mutes: [] }
// The items with a row of their own: their session has none above.
const slxList = () => (slxData().items || []).filter((x) => !x.merged)
// The ones waiting on the person: no session, or an ended one.
const slxTurn = () => slxList().filter((x) => !x.alive)
const slxRunning = () => slxList().filter((x) => x.alive)
const slxOf = (s) => (s && s.slx ? (slxData().items || []).find((x) => x.id === s.slx) : undefined)
function slxPick(x) { cmd.sel = { slx: x.id, title: x.from }; cmd.armed = null; cmd.q = null; cmd.force = null; cmd.row = null }
const slxIsSel = (x) => !!cmd.sel && cmd.sel.slx === x.id
const slxLine = (t) => String(t || '').replace(/\s+/g, ' ').trim()
const slxMarked = () => slxTurn().filter((x) => slxUi.marks[x.id])
// An older slx TUI that runs although slx says none does.
const slxStale = () => (slxData().stale || [])[0]

// What a session's row adds when it works on slx triggers.
function slxBadge(row) {
  const x = row && row.slx
  return x ? ' <span title="' + cmdEsc('slx: ' + x.from + ' · ' + x.text) + '">' + x.icon + (x.n > 1 ? x.n : '') + '</span>' : ''
}

function slxState(x) {
  if (x.alive) return '⚙ 세션 진행 중'
  if (x.sid) return '세션 끝남'
  return ''
}

// A trigger row's mark (☐/☑), for the bulk choices of the slx line.
const slxMk = (x) => '<span class="slxmk" data-slxmk="' + cmdEsc(x.id) + '" title="고르기">' + (slxUi.marks[x.id] ? '☑' : '☐') + '</span>'

// A trigger whose session runs with no row, under ⚙ 진행 중.
function slxTurnRow(x) {
  const mk = '<span class="slxmk" data-slxmk="' + cmdEsc(x.id) + '" title="고르기 (x)">' + (slxUi.marks[x.id] ? '☑' : '☐') + '</span>'
  return '<li data-slx="' + cmdEsc(x.id) + '" class="t' + (slxIsSel(x) ? ' sel' : '') + '">' + mk + x.icon + ' <b>' + cmdEsc(x.from) + '</b> · ' + cmdEsc(slxLine(x.text).slice(0, 80))
    + ' <span class="m">' + cmdEsc([x.where, cmdAgo(x.at), slxState(x), x.pending ? '새 멘션 ' + x.pending : ''].filter(Boolean).join(' · ')) + '</span></li>'
}

// The slx line under 내 차례: what is hidden, what runs, the bulk choices;
// nothing at all when there is nothing to say.
function slxFoot() {
  const d = slxData(), turn = slxTurn(), run = slxRunning(), marked = slxMarked(), rules = d.mutes || []
  const parts = []
  if (d.error) parts.push(cmdEsc(d.error))
  else if (d.tui === false) {
    const st = slxStale()
    parts.push(st ? 'slx가 예전 버전으로 떠 있음 (' + cmdEsc(st.pane + ' · ' + st.window) + ')' : 'slx 꺼짐')
    if (d.canUp) parts.push('<button data-slxf="up"' + (slxUi.upping ? ' disabled' : '') + '>' + (slxUi.upping ? '켜는 중…' : st ? '↻ slx 다시 시작' : '⏻ slx 켜기') + '</button>')
  }
  if (run.length) parts.push('<a href="#" data-slxf="run">⚙ 진행 중 ' + run.length + (slxUi.runOpen ? ' ▾' : ' ▸') + '</a>')
  if (rules.length || d.muted) parts.push('<a href="#" data-slxf="rules">🙈 숨김 규칙 ' + rules.length + (d.muted ? ' · 가린 ' + d.muted : '') + '</a>')
  if (d.snoozed) parts.push('⏰ 나중에 ' + d.snoozed)
  if (d.old) parts.push(Math.round(d.windowH || 72) + '시간 넘은 ' + d.old + '건은 slx에서')
  const armed = Date.now() - slxUi.allArmed < 8000
  if (turn.length > 1) parts.push('<button data-slxf="all"' + (armed ? ' class="armed"' : '') + '>' + (armed ? '한 번 더: trigger ' + turn.length + '건 무시' : 'trigger 행 모두 무시 (' + turn.length + ')') + '</button>')
  if (!parts.length && !marked.length) return ''
  let out = '<div class="slxfoot">📨 slx · ' + parts.join(' · ')
  if (marked.length) out += '<span class="marks">고른 ' + marked.length + '건: <button data-slxf="done">✓ 무시</button><button data-slxf="snooze">⏰ 3시간 뒤</button><button data-slxf="mute">🙈 같은 곳 숨기기</button><button data-slxf="clear">고르기 해제</button></span>'
  out += '</div>'
  if (slxUi.runOpen && run.length) out += '<ul class="feed turn">' + run.map(slxTurnRow).join('') + '</ul>'
  return out
}

// A click in the list on one of these; false when it was not one.
function slxClick(ev) {
  const mk = ev.target.closest('[data-slxmk]')
  if (mk) { slxMark(mk.dataset.slxmk); return true }
  const f = ev.target.closest('[data-slxf]')
  if (f) { ev.preventDefault(); slxFootDo(f.dataset.slxf); return true }
  const li = ev.target.closest('li[data-slx]')
  if (!li) return false
  const x = slxList().find((y) => y.id === li.dataset.slx)
  if (x) { slxPick(x); cmdRender() }
  return true
}

function slxMark(id) {
  if (slxUi.marks[id]) delete slxUi.marks[id]; else slxUi.marks[id] = true
  cmdRender()
}

async function slxFootDo(what) {
  if (what === 'run') { slxUi.runOpen = !slxUi.runOpen; return cmdRender() }
  if (what === 'rules') { cmd.sel = { slx: SLX_RULES, title: '숨김 규칙' }; cmd.armed = null; return cmdRender() }
  if (what === 'clear') { slxUi.marks = {}; return cmdRender() }
  if (what === 'up') return slxUp()
  if (what === 'all') {
    if (Date.now() - slxUi.allArmed >= 8000) { slxUi.allArmed = Date.now(); toast('한 번 더 누르면 trigger 행 ' + slxTurn().length + '건을 모두 무시합니다'); return cmdRender() }
    slxUi.allArmed = 0
    return slxBulk('done', slxTurn())
  }
  return slxBulk(what, slxMarked())
}

// One choice on many triggers: 무시, 3시간 뒤, or 같은 곳 숨기기 (a Slack
// trigger's channel, an incident's alert; the same rule made twice is one).
async function slxBulk(act, xs) {
  if (!xs.length) return
  const ids = xs.map((x) => x.id)
  let j
  if (act === 'mute') {
    const notes = []
    for (const x of xs) {
      const r = await cmdPost({ kind: 'slx_mute', id: x.id, by: x.trigger === 'meerkat' ? 'kind' : 'channel' })
      if (r) notes.push(r.sent)
    }
    j = notes.length ? { sent: [...new Set(notes)].join(' · ') } : null
  } else j = await cmdPost(act === 'done' ? { kind: 'slx_done', ids } : { kind: 'slx_snooze', ids, until: '3h' })
  if (!j) return cmdRender()
  toast((act === 'done' ? '✓ ' : act === 'snooze' ? '⏰ ' : '🙈 ') + (j.sent || '보냈습니다'))
  for (const id of ids) delete slxUi.marks[id]
  if (act !== 'mute' && cmd.data?.slx) cmd.data.slx.items = (cmd.data.slx.items || []).filter((x) => !ids.includes(x.id))
  if (cmd.sel?.slx && ids.includes(cmd.sel.slx)) cmdShut()
  cmdRender()
  cmdLoad()
}

// Choices 3 and 4 open their own: [label, what slxDo sends].
function slxMuteChoices(x) {
  if (x.trigger === 'meerkat') return [[x.service ? '서비스 ' + x.service : '', 'service'], ['이 알럿 (' + slxLine(x.text).slice(0, 40) + ')', 'kind'], ['문구가 들어간 것', 'text']].filter((c) => c[0])
  return [[x.dm ? x.from + '의 DM' : '채널 ' + x.where, 'channel'], [x.from + '이(가) 보낸 것', 'from'], ['문구가 들어간 것', 'text']]
}
function slxSnoozeChoices(now = new Date()) {
  const at = (days, base) => { const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.toISOString() }
  const monday = ((8 - now.getDay()) % 7) || 7
  return [['1시간 뒤', '1h'], ['3시간 뒤', '3h'], ['내일 오전 9시', at(1, now)], ['다음 주 월요일 오전 9시', at(monday, now)]]
}
const slxSubs = (x, act) => (act === 'mute' ? slxMuteChoices(x) : act === 'snooze' ? slxSnoozeChoices() : [])

function slxRulesDoc(bar, doc, dec) {
  if (cmd.frame !== 'slx:' + SLX_RULES) {
    cmd.frame = 'slx:' + SLX_RULES
    bar.innerHTML = '<b>🙈 숨김 규칙</b><span class="m"></span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="said slxv"></div>'
    dec.style.display = 'none'; dec.innerHTML = ''; dec.dataset.key = ''
  }
  const said = doc.querySelector('.said'), rules = slxData().mutes || [], key = JSON.stringify(rules)
  if (said.dataset.key === key) return
  said.dataset.key = key
  bar.querySelector('.m').textContent = rules.length + '개 · 규칙에 맞는 trigger는 지금도 앞으로도 목록에 나오지 않습니다 (slx는 그대로 받습니다)'
  said.innerHTML = rules.length ? rules.map((r) => '<div class="rule"><b>' + cmdEsc(r.label) + '</b><span class="m">' + cmdEsc([r.trigger === 'meerkat' ? 'Meerkat' : 'Slack', '가린 ' + r.hides + '건'].join(' · ')) + '</span><button class="act" data-unmute="' + cmdEsc(r.id) + '">해제</button></div>').join('') : '<div class="m">숨김 규칙이 없습니다.</div>'
  said.onclick = async (ev) => {
    const b = ev.target.closest('[data-unmute]')
    if (!b) return
    const j = await cmdPost({ kind: 'slx_unmute', rule: b.dataset.unmute })
    if (j) { toast('👁 ' + (j.sent || '풀었습니다')); cmdLoad() }
  }
}

// The picked item where a brief opens. Redrawn only when the item changes.
function slxRenderDoc(bar, doc, dec, s) {
  if (s.slx === SLX_RULES) return slxRulesDoc(bar, doc, dec)
  const x = slxOf(s)
  if (cmd.frame !== 'slx:' + s.slx) {
    cmd.frame = 'slx:' + s.slx
    bar.innerHTML = '<b></b><span class="m"></span><button class="act go" title="세션의 tmux pane으로 (G)"><span class="key">G</span>↗ 창으로</button><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.go').onclick = () => slxFocus(s)
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="said slxv"></div>'
    dec.dataset.key = ''
  }
  const said = doc.querySelector('.said'), skey = JSON.stringify(x || null)
  if (said.dataset.key !== skey) {
    said.dataset.key = skey
    bar.querySelector('.go').style.display = x && x.alive && x.pane ? '' : 'none'
    if (!x) said.innerHTML = '<div class="m">이 항목은 목록에 없습니다 (무시·숨김·나중에 했거나 세션이 생겨 위 행에 붙었습니다).</div>'
    else {
      bar.querySelector('b').textContent = x.icon + ' ' + x.from
      bar.querySelector('.m').textContent = [x.where, cmdAgo(x.at)].filter(Boolean).join(' · ')
      const links = [[x.trigger === 'meerkat' ? 'Meerkat' : '스레드', 'link', x.link], ['알럿 스레드', 'alert', x.alertThread !== x.link ? x.alertThread : '']].filter((l) => l[2])
      said.innerHTML = '<h4>' + (x.trigger === 'meerkat' ? '알럿' : '메시지') + '</h4><div class="msg">' + cmdEsc(x.text) + '</div>'
        + (x.detail ? '<h4>요약</h4><div class="msg">' + cmdEsc(x.detail) + '</div>' : '')
        + '<h4>링크</h4>' + (links.length ? '<ul class="links">' + links.map((l) => '<li>' + cmdEsc(l[0]) + ' · <a href="#" data-slink="' + l[1] + '">' + cmdEsc(l[2]) + '</a></li>').join('') + '</ul>' : '<div class="m">—</div>')
        + '<h4>slx</h4><div class="m">' + cmdEsc([x.status === 'new' ? '세션 없음' : slxState(x), x.mentions > 1 ? '멘션 ' + x.mentions : '', x.pending ? '세션이 못 본 멘션 ' + x.pending : '', x.window || '', x.joinedTo ? '↳ ' + x.joinedTo + '의 세션에 합쳐짐' : ''].filter(Boolean).join(' · ')) + '</div>'
      said.onclick = (ev) => { const a = ev.target.closest('a[data-slink]'); if (a) { ev.preventDefault(); cmdPost({ kind: 'slx_link', id: x.id, which: a.dataset.slink }).then((j) => { if (j) toast('↗ ' + (j.sent || '열었습니다')) }) } }
    }
  }
  const armed = cmd.armed && cmd.armed.slx === s.slx ? cmd.armed : null
  const d = slxData(), tui = d.tui !== false, stale = !tui && slxStale(), canUp = !tui && !!d.canUp
  const key = JSON.stringify([!!x, armed, tui, !!stale, canUp, slxUi.upping, x && x.sid, x && x.alive])
  if (dec.dataset.key === key) return
  dec.dataset.key = key
  if (!x) { dec.style.display = 'none'; dec.innerHTML = ''; return }
  dec.style.display = 'block'
  const open = x.alive ? '세션에 새 멘션 보내기' : x.sid ? '끝난 세션 이어 열기' : '세션 만들기'
  const first = tui ? '▶ ' + open : slxUi.upping ? '켜는 중…' : (stale ? '↻ slx 다시 시작 · ' : '⏻ slx 켜기 · ') + open
  const top = [['open', first], ['done', '✓ 무시'], ['mute', '🙈 이런 것 숨기기'], ['snooze', '⏰ 나중에']]
  const on = (a) => (armed && armed.act === a ? ' armed' : '')
  const say = tui ? '숫자를 고르고 Enter · slx가 b 키처럼 뒤에서 엽니다 · Slack에는 아무것도 보내지 않습니다'
    : !canUp ? 'slx가 꺼져 있고 이 slx는 스스로 켜지 못합니다: keyolk/slx에서 make install (무시·숨기기·나중에는 됩니다)'
      : stale ? 'slx가 예전 버전으로 떠 있어 세션을 열지 못합니다 (' + stale.pane + ' · ' + stale.window + '): 1은 그 slx를 q로 끄고 새로 띄운 뒤 세션을 엽니다 · 안 꺼지면 강제로 끄지 않고 알려 드립니다'
        : 'slx가 꺼져 있습니다: 1은 slx를 tmux의 slx 세션(inbox 창)에 띄운 뒤 세션을 엽니다'
  let html = '<div class="m" style="margin-bottom:4px">' + cmdEsc(say) + '</div>'
    + '<div class="qa"><div class="opts">' + top.map(([a, label], i) => '<button class="act opt' + (i === 0 ? ' rec' : '') + on(a) + '" data-sact="' + a + '"' + (a === 'open' && !tui && (!canUp || slxUi.upping) ? ' disabled' : '') + '><span class="key">' + (i + 1) + '</span>' + cmdEsc(label) + '</button>').join('') + '</div>'
  const subs = armed ? slxSubs(x, armed.act) : []
  if (subs.length) {
    html += '<div class="sub"><div class="m">' + (armed.act === 'mute' ? '무엇을 숨길까요? 숫자를 고르고 Enter · 지금 것과 앞으로 올 것 모두 · Esc로 돌아가기' : '언제 다시 보일까요? 숫자를 고르고 Enter · 새 멘션이 오면 바로 다시 보입니다 · Esc로 돌아가기') + '</div><div class="opts">'
      + subs.map(([label], i) => '<button class="act opt' + (armed.sub === i ? ' armed' : '') + '" data-ssub="' + i + '"><span class="key">' + (i + 1) + '</span>' + cmdEsc(label) + '</button>').join('') + '</div>'
    if (armed.act === 'mute' && subs[armed.sub]?.[1] === 'text') html += '<input class="stext" placeholder="숨길 문구 (대소문자 무시) · Enter" value="' + cmdEsc(armed.text ?? slxLine(x.text).slice(0, 30)) + '">'
    html += '</div>'
  }
  dec.innerHTML = html + '</div>'
  dec.querySelectorAll('[data-sact]').forEach((b) => { b.onclick = () => (b.dataset.sact === 'open' || b.dataset.sact === 'done' ? slxDo(s, b.dataset.sact) : slxArm(s, b.dataset.sact)) })
  dec.querySelectorAll('[data-ssub]').forEach((b) => { b.onclick = () => { slxArm(s, armed.act, +b.dataset.ssub); if (slxSubs(x, armed.act)[+b.dataset.ssub][1] !== 'text') slxSend(s) } })
  const inp = dec.querySelector('.stext')
  if (inp) {
    inp.oninput = () => { cmd.armed.text = inp.value }
    inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); cmd.armed.text = inp.value; slxSend(s) } else if (e.key === 'Escape') { e.preventDefault(); inp.blur() } }
    inp.focus()
  }
}

function slxFocus(s) {
  const x = slxOf(s)
  if (!x || !x.alive || !x.pane) { toast('이 항목의 세션 pane이 없습니다'); return }
  focusPane(x.pane)
  toast('↗ ' + x.from + ' (' + x.pane + ')')
}

function slxArm(s, act, sub) {
  const was = cmd.armed && cmd.armed.slx === s.slx && cmd.armed.act === act ? cmd.armed : null
  cmd.armed = { slx: s.slx, act, ...(sub !== undefined ? { sub } : {}), ...(was && was.text !== undefined ? { text: was.text } : {}) }
  cmdRenderDoc()
}

// What Enter sends: the armed choice, with its sub-choice for 3 and 4.
function slxSend(s) {
  const a = cmd.armed && cmd.armed.slx === s.slx ? cmd.armed : null
  if (!a) return false
  if (a.act === 'open' || a.act === 'done') { slxDo(s, a.act); return true }
  const x = slxOf(s), sub = x && slxSubs(x, a.act)[a.sub]
  if (!sub) { toast('숫자로 하나를 고르세요'); return true }
  if (a.act === 'snooze') slxDo(s, 'snooze', { until: sub[1] }, sub[0])
  else slxDo(s, 'mute', { by: sub[1], ...(sub[1] === 'text' ? { text: a.text ?? slxLine(x.text).slice(0, 30) } : {}) })
  return true
}

// The view's keys on a picked trigger (commandKey asks after j/k): 1-4 pick
// a choice (with 3 or 4 armed, they pick its sub-choice, and Esc, in
// commandKey, backs out), Enter sends, x marks the row, g goes to the pane.
// `hit` is commandKey's.
function slxKey(k, s, hit) {
  if (s.slx === SLX_RULES) return false
  const a = cmd.armed && cmd.armed.slx === s.slx ? cmd.armed : null
  const x = slxOf(s)
  if (/^[1-9]$/.test(k) && a && (a.act === 'mute' || a.act === 'snooze') && x) {
    const subs = slxSubs(x, a.act)
    if (+k > subs.length) return false
    return hit(() => { slxArm(s, a.act, +k - 1); toast('Enter로 「' + subs[+k - 1][0] + '」') })
  }
  const top = { 1: ['open', '세션 만들기'], 2: ['done', '무시'], 3: ['mute', '이런 것 숨기기'], 4: ['snooze', '나중에'] }[k]
  if (top) return hit(() => { slxArm(s, top[0]); toast(top[0] === 'open' || top[0] === 'done' ? 'Enter로 「' + top[1] + '」' : '「' + top[1] + '」: 숫자로 고르고 Enter') })
  if (k === 'Enter' && a) return hit(() => slxSend(s))
  if (k === 'x' && x && !x.alive) return hit(() => slxMark(x.id))
  if (k === 'g') return hit(() => slxFocus(s))
  return false
}

// 세션 만들기 keeps the item up (its session shows once slx opened it); the
// rest take it off and go on as any answer does: the row's next need, else
// the next row (table.js tblAfter), or close when none is left.
async function slxDo(s, act, extra = {}, label = '') {
  const d = slxData()
  if (act === 'open' && d.tui === false) {
    cmd.armed = null
    if (!d.canUp || slxUi.upping) { toast(slxUi.upping ? 'slx를 켜는 중입니다' : 'slx가 꺼져 있고 이 slx는 스스로 켜지 못합니다'); return cmdRenderDoc() }
    return slxUp(s.slx)
  }
  const kind = { open: 'slx_open', done: 'slx_done', mute: 'slx_mute', snooze: 'slx_snooze' }[act]
  const j = await cmdPost({ kind, id: s.slx, ...extra })
  cmd.armed = null
  if (!j) { cmdRenderDoc(); return }
  toast({ open: '▶ ', done: '✓ ', mute: '🙈 ', snooze: '⏰ ' }[act] + (j.sent || '보냈습니다') + (label ? ' (' + label + ')' : ''))
  if (act === 'open') { cmdRenderDoc(); cmdLoad(); return }
  delete slxUi.marks[s.slx]
  if (typeof tblMark === 'function') tblMark((R) => (R.row.slx || []).includes(s.slx))
  if (cmd.data?.slx) cmd.data.slx.items = (cmd.data.slx.items || []).filter((x) => x.id !== s.slx)
  if (typeof tblAfter === 'function' && cmd.row) tblAfter(); else { cmdShut(); cmdRender() }
  if (act === 'mute') cmdLoad()
}

// [slx 켜기] / [slx 다시 시작]: slx starts its TUI (replacing an older one
// that runs), then, with `then`, opens that trigger's session: the person
// pressed once. The press waits for slx (up to ~20 s).
async function slxUp(then) {
  if (slxUi.upping) return
  const stale = !!slxStale()
  slxUi.upping = true
  toast(stale ? '↻ 예전 slx를 끄고 새로 띄우는 중…' : '⏻ slx를 띄우는 중…')
  cmdRender(); cmdRenderDoc()
  const j = await cmdPost({ kind: 'slx_up', ...(stale ? { replace: true } : {}), ...(then ? { then } : {}) })
  slxUi.upping = false
  if (j) toast('⏻ ' + (j.sent || 'slx를 켰습니다'))
  if (cmd.data?.slx && j) { cmd.data.slx.tui = true; cmd.data.slx.stale = [] }
  cmdRender(); cmdRenderDoc(); cmdLoad()
}

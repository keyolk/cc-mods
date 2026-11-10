// A picked session's two looks in the command view (지휘), T (⌥T) between
// them: 마지막 답, the end of its last answer (command.js cmdRenderCall), and
// 카드, what the floor card shows (past turns, what it was handed, sent and
// wrote, its work, btw), drawn by office.html's cardPanes into the same
// place, so the view is never left. Loaded before command.js, which calls
// these; nothing here runs until the view does.

const LOOK_CSS = `
#command .bar .seg { display: inline-flex; border: 2px solid var(--line); border-radius: 10px; overflow: hidden; flex: 0 0 auto; }
#command .bar .seg button { font: inherit; font-size: 12px; border: 0; background: #fff; padding: 2px 8px; cursor: pointer; }
#command .bar .seg button + button { border-left: 2px solid var(--line); }
#command .bar .seg button.on { background: #2a2033; color: #fff; }
#command .cardv { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 6px 12px 8px; background: #fffaf0; overflow: hidden; }
#command .cardv > * { flex: 0 0 auto; }
#command .cardv > .cpane { flex: 1 1 auto; min-height: 0; overflow: auto; }
#command .cardv > .cpane .said, #command .cardv > .cpane .rel { max-height: none; }
#command .cardv .chead { border-bottom: 2px dashed rgba(59,42,53,.18); padding-bottom: 4px; margin-bottom: 2px; }
#command .cardv .sidebox { height: 100%; box-sizing: border-box; display: flex; flex-direction: column; border: 2px solid #c9b88f; border-radius: 12px; background: #fbf5e8; }
#command .cardv .sidebox .btw { flex: 1 1 auto; min-height: 0; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: LOOK_CSS }))

// T (⌥T), or the bar's switch: the picked session's other look. Going to
// the card loads it afresh; the 3 s poll never redraws it, so a tab, a scroll
// or what is typed in its btw stays put.
function cmdView(v = cmd.view === 'card' ? 'said' : 'card') {
  const cv = cmdEl.querySelector('.doc .cardv')
  if (v === 'card' && cmd.view !== 'card' && cv) cv.dataset.sid = ''
  cmd.view = v
  cmdRenderView()
}

function cmdRenderView() {
  const doc = cmdEl.querySelector('.doc'), s = cmd.sel
  if (!doc || !s || !s.sid) return
  const said = doc.querySelector('.said'), cv = doc.querySelector('.cardv'), on = cmd.view === 'card'
  if (!said || !cv) return
  said.style.display = on ? 'none' : ''
  cv.style.display = on ? '' : 'none'
  cmdEl.querySelectorAll('.bar .seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === cmd.view))
  if (on && cv.dataset.sid !== s.sid) cmdCard(s, cv)
}

// The session's card in the left pane: a head with what it was doing (its
// one-line summary; its brief is on the line over both looks), then the floor card's panes with
// btw as their last tab. The floor card's quick replies and reply box are
// not drawn again: the box under it (.decide) and the task box speak to it.
async function cmdCard(s, cv) {
  cv.dataset.sid = s.sid
  cv.innerHTML = '<div class="m">카드를 불러오는 중…</div>'
  if (typeof cardPanes !== 'function') { cv.innerHTML = '<div class="m">이 페이지에는 카드가 없습니다.</div>'; return }
  const q = encodeURIComponent(s.sid)
  let d, pn
  try {
    ;[d, pn] = await Promise.all([fetch('/detail?sid=' + q, { cache: 'no-store' }).then((r) => r.json()), fetch('/panels?sid=' + q, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}))])
  } catch (e) {
    if (cv.dataset.sid === s.sid) cv.innerHTML = '<div class="m">카드를 못 불러왔습니다: ' + cmdEsc(e.message) + '</div>'
    return
  }
  // Another session, or the other look, since: this card is not wanted.
  if (cv.dataset.sid !== s.sid || cmd.sel?.sid !== s.sid || !cv.isConnected) return
  cv.innerHTML = ''
  cmd.card = null
  if (d.error) { cv.innerHTML = '<div class="m">' + (d.error === 'no such session' ? '이 세션이 없습니다 (창이 닫혔거나 끝났습니다).' : cmdEsc(d.error)) + '</div>'; return }
  const w = cmdWorkers().find((x) => x.w.sid === s.sid)?.w
  const sum = d.summary || (cmd.ask && cmd.ask.sid === s.sid && cmd.ask.summary) || w?.summary || cmdCall(s.sid)?.summary || ''
  const head = document.createElement('div')
  head.className = 'chead'
  head.innerHTML = '<div class="csum" title="' + cmdEsc(sum) + '">📝 ' + cmdEsc(sum || d.name) + '</div><div class="m">' + cmdEsc([d.window + ' ' + d.name, STATE_KO[d.state] || d.state, d.inbox ? '📨 보낸 답이 아직 전달 전' : ''].filter(Boolean).join(' · ')) + '</div>'
  cv.appendChild(head)
  cardPanes(cv, d, pn, { sid: s.sid, btw: true, alive: () => cv.isConnected && cv.dataset.sid === s.sid && cmd.view === 'card' })
  cmd.card = cv
}

// The picked session's card, when that is the look it shows and it has loaded.
const cmdCardUp = () => (cmd.view === 'card' && cmd.card && cmd.card.isConnected !== false && cmd.sel?.sid && cmd.card.dataset.sid === cmd.sel.sid ? cmd.card : null)

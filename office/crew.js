// Ending a session, or taking it off the list, from the command view (지휘).
//
// The person asked to end sessions from here. A picked session's bar, and
// each row of 👷 일하는 중, has ⏹ 끝내기 (X, or ⌥X where TWeb's normal mode
// keeps bare x) and ⏏ 빼기. office/crew.py decides what ending means:
// an owned worker is closed as coord_close closes it (refused while its
// worktree has uncommitted changes); an adopted session is the person's own,
// so the first press only says what would end (its summary, its pane,
// uncommitted changes in its directory) and a second press within 8 s ends
// it. 빼기 takes it off the list for good and leaves it running. Neither is
// offered for a coordinator. Loaded before command.js, which calls these.

const CREW_CSS = `
#command .endarm { padding: 6px 12px; background: #ffe1e1; border-bottom: 2px solid #c0392b; font: 12.5px -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .endarm:empty { display: none; }
#command .endarm pre { margin: 4px 0 0; font: 11px ui-monospace, Menlo, monospace; white-space: pre-wrap; }
#command button.act.end { background: #ffb3b3; }
#command button.act.end.armed { outline: 3px solid #c0392b; }
#command td .end { font: 11px -apple-system, sans-serif; border: 1px solid rgba(59,42,53,.4); border-radius: 8px; background: #fff; padding: 0 5px; cursor: pointer; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CREW_CSS }))

// arm: the end the server asked to confirm ({ sid, at, text, dirty, cwd }).
const crewState = { arm: null }
const CREW_CONFIRM_MS = 8000
const crewIsCoord = (sid) => (cmd.data?.coordinators || []).some((c) => c.sid === sid)
// A worker in some coordinator's ledger: only that one can be taken off it.
const crewIsWorker = (sid) => cmdWorkers().some((x) => x.w.sid === sid)
const crewArmed = (sid) => !!crewState.arm && crewState.arm.sid === sid && Date.now() - crewState.arm.at < CREW_CONFIRM_MS

// The bar's buttons for a picked session; none for a coordinator.
function crewButtons(sid) {
  if (crewIsCoord(sid)) return ''
  return (crewIsWorker(sid) ? '<button class="act rel" title="지휘 목록에서만 빼기 (세션은 계속 돎)">⏏</button>' : '')
    + '<button class="act end" title="세션 끝내기 (X · 입력칸에서는 ⌥X)"><span class="key">X</span>⏹</button>'
}
function crewWire(bar, s) {
  const end = bar.querySelector('.end'), rel = bar.querySelector('.rel')
  if (end) end.onclick = () => crewEnd(s)
  if (rel) rel.onclick = () => crewRelease(s)
}

// The warning over the picked session while an end waits for its second press.
function crewRenderArm() {
  const el = cmdEl.querySelector('.doc .endarm'), s = cmd.sel
  const a = s && s.sid && crewArmed(s.sid) ? crewState.arm : null
  cmdEl.querySelectorAll('.bar .end').forEach((b) => b.classList.toggle('armed', !!a))
  if (!el) return
  el.innerHTML = a ? '⚠ ' + cmdEsc(a.text) + (a.dirty && a.dirty.length ? ' · <b>커밋하지 않은 변경 ' + a.dirty.length + '개</b> (' + cmdEsc(a.cwd || '') + ')<pre>' + cmdEsc(a.dirty.join('\n')) + '</pre>' : '') + '<div>⏹나 X(⌥X)를 8초 안에 한 번 더 누르면 끝냅니다.</div>' : ''
}

// ⏹ / X: ask the server; a second press within 8 s confirms an adopted one.
async function crewEnd(s) {
  if (!s || !s.sid || crewIsCoord(s.sid)) return false
  const confirm = crewArmed(s.sid)
  const j = await cmdPost({ kind: 'session_end', sid: s.sid, ...(confirm ? { confirm: true } : {}) })
  if (!j) { crewState.arm = null; crewRenderArm(); return false }
  if (j.confirm) {
    crewState.arm = { sid: s.sid, at: Date.now(), text: j.confirm, dirty: j.dirty || [], cwd: j.cwd }
    // The warning goes again when the time to confirm is up.
    setTimeout(crewRenderArm, CREW_CONFIRM_MS + 50)
    crewRenderArm()
    toast('⚠ 한 번 더 누르면 끝냅니다: ' + (s.name || ''))
    return true
  }
  crewState.arm = null
  toast('⏹ ' + (j.sent || '끝냄'))
  crewGone(s)
  return true
}

// ⏏: off the list for good; the session keeps running.
async function crewRelease(s) {
  if (!s || !s.sid || crewIsCoord(s.sid)) return false
  const j = await cmdPost({ kind: 'session_release', sid: s.sid })
  if (!j) return false
  toast('⏏ ' + (j.sent || '뺐습니다'))
  crewGone(s)
  return true
}

// Ended or released: closed if it was open, and the list asked again.
function crewGone(s) {
  if (cmd.sel && cmd.sel.sid === s.sid) cmdShut()
  cmdLoad()
}

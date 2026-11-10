// Input put off, in the command view (지휘): a session set aside until a
// time (⏰ 나중에, Z · ⌥Z) and memos left on it instead of being sent
// (📝, ⌥Enter in its box). office/defer.py keeps both under
// ~/.claude/state/office/defer/<sid>.json; office/turn.py decides the rows.
//
// A row set aside leaves 내 차례 and folds into one line, ⏰ 미룸 N. It comes
// back when its time comes (with its memos, until it is opened and left) or
// at once when a need it did not hold arrives: a new question, a new wait, a
// new trigger. The choices are slx's 나중에 (slx.js slxSnoozeChoices): 1 h,
// 3 h, tomorrow 9:00, next Monday 9:00. Z arms them over the row's tabs, a
// digit picks, Enter sends; one stray key never sets a row aside.
// A row's memos are its tab 📝 메모 N: each one 보내기 (the session's reply,
// then the memo goes; a busy session asks for a second press as a reply does)
// or 지우기. Loaded after table.js, before command.js.

const DFR_CSS = `
#command .rtabs .dfr { margin-left: auto; align-self: center; }
#command .rtabs button.dfr.on { background: #fff3c4; color: #2a2033; border-color: rgba(59,42,53,.35); }
#command .decide button.memo { white-space: nowrap; }
#command .dfrc { flex-basis: 100%; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; padding: 4px 0 6px; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .dfrc button { border-radius: 8px !important; border-bottom: 2px solid rgba(59,42,53,.35) !important; }
#command .dfrc button.armed { background: #2a2033; color: #fff; }
#command .memos .memo { border: 2px solid rgba(59,42,53,.14); border-radius: 10px; background: #fff; padding: 6px 10px; margin-bottom: 6px; }
#command .memos .memo .t { white-space: pre-wrap; word-break: break-word; }
#command .memos .memo .row { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
#command .memos .memo .row .m { margin-right: auto; }
#command .memoadd { display: flex; gap: 6px; padding-top: 6px; }
#command .memoadd textarea { flex: 1; min-height: 3em; font: inherit; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: DFR_CSS }))

// armed: the row whose choices are up ({ key, i }); local: what this page
// did before the next poll says so ({ until, at }, until 0 for 지금 다시);
// seen: woke rows left after opening; viewing: the row open now; force:
// a busy memo's second press.
const dfr = { armed: null, local: {}, seen: {}, viewing: null, force: null }
const DFR_LOCAL_MS = 15000

// Until when the row is set aside, or null: this page's own choice until the
// server shows it, else the server's.
function dfrUntil(row) {
  const l = dfr.local[row.key]
  // Once the server shows the same, it decides (a new need may wake it).
  if (l && (Date.now() - l.at >= DFR_LOCAL_MS || !l.until === !row.deferred)) delete dfr.local[row.key]
  else if (l) return l.until || null
  return row.deferred || null
}
// Its time came and it is not left yet.
const dfrWoke = (row) => !!row.woke && !(dfr.seen[row.key] && Date.now() - dfr.seen[row.key] < DFR_LOCAL_MS)

// The choices: slx's 나중에, and 지금 다시 for a row set aside.
function dfrChoices(R) {
  const ch = typeof slxSnoozeChoices === 'function' ? slxSnoozeChoices() : [['1시간 뒤', '1h'], ['3시간 뒤', '3h']]
  return R && R.deferred ? [...ch, ['지금 다시 올리기', 'clear']] : ch
}

// Z: arm the choices for the open row (or the one holding what is open).
function dfrArm() {
  const key = tblCur(), R = key && tblFind(key)
  if (!R) { toast('미룰 행을 먼저 고르세요 (j/k)'); return }
  if (!R.row.sid) { toast('세션이 없는 행(브리프·slx만 있는 행)은 미룰 수 없습니다'); return }
  cmd.row = key
  dfr.armed = { key, i: null }
  tblRenderTabs()
  toast('⏰ 언제 다시 볼까요? 숫자를 고르고 Enter · Esc 취소')
}

// The view's keys while choices are up (commandKey asks before any other
// digit, Enter or Esc), and Z to put them up.
function dfrKey(k, hit) {
  const a = dfr.armed, R = a && tblFind(a.key)
  if (a && (!R || tblCur() !== a.key)) dfr.armed = null
  else if (a) {
    const ch = dfrChoices(R)
    if (k === 'Escape' || k === 'z') return hit(() => { dfr.armed = null; tblRenderTabs() })
    if (/^[1-9]$/.test(k) && +k <= ch.length) return hit(() => { a.i = +k - 1; tblRenderTabs(); toast('Enter로 「' + ch[a.i][0] + '」') })
    if (k === 'Enter' && a.i !== null) return hit(() => dfrPick(a.key, ch[a.i]))
    if (/^[1-9]$/.test(k) || k === 'Enter') return hit(() => toast('숫자로 하나를 고르세요'))
    return false
  }
  if (k === 'z') return hit(dfrArm)
  return false
}

async function dfrPick(key, ch) {
  const R = tblFind(key)
  dfr.armed = null
  if (!R || !ch) return
  if (ch[1] === 'clear') {
    const j = await cmdPost({ kind: 'defer_clear', sid: R.row.sid })
    if (!j) return tblRenderTabs()
    dfr.local[key] = { until: 0, at: Date.now() }
    toast('⏰ ' + (j.sent || '다시 올렸습니다'))
    cmdRender(); cmdLoad()
    return
  }
  // What it holds now: only a need not among these brings it back early.
  const was = R.needs
  const j = await cmdPost({ kind: 'defer_set', sid: R.row.sid, until: ch[1], seen: R.row.needKeys || [] })
  if (!j) return tblRenderTabs()
  toast('⏰ ' + (j.sent || '미뤘습니다') + ' (' + ch[0] + ')')
  tblMark((x) => x.row.key === key)
  dfr.local[key] = { until: j.until || 1, at: Date.now() }
  // A row that waited goes on as an answer does; a quiet one stays open.
  if (was && cmd.row === key) tblAfter(); else cmdRender()
  cmdLoad()
}

// What goes over the row's tabs: ⏰ and, armed, its choices.
function dfrTabsHtml(R) {
  if (!R.row.sid) return ''
  const until = R.deferred
  const btn = '<button class="dfr' + (dfr.armed && dfr.armed.key === R.row.key ? ' on' : '') + '" data-dfr="arm" title="나중에 다시 보기 (Z · ⌥Z)">' + (until ? '⏰ ' + cmdHHMM(until * 1000) + '까지 미룸' : '⏰ 나중에') + ' <span class="key">Z</span></button>'
  if (!dfr.armed || dfr.armed.key !== R.row.key) return btn
  const ch = dfrChoices(R)
  return btn + '<div class="dfrc"><span class="m">언제 다시? · 새 질문이나 새 대기가 오면 바로 다시 올라옵니다 · Esc 취소</span>'
    + ch.map(([label], i) => '<button data-dfr="' + i + '" class="' + (dfr.armed.i === i ? 'armed' : '') + '"><span class="key">' + (i + 1) + '</span>' + cmdEsc(label) + '</button>').join('') + '</div>'
}
// A click over the tabs: ⏰ arms (or disarms), a choice sends.
function dfrClick(ev) {
  const b = ev.target.closest('[data-dfr]')
  if (!b) return false
  const R = cmd.row && tblFind(cmd.row)
  if (!R) return true
  if (b.dataset.dfr === 'arm') { if (dfr.armed && dfr.armed.key === R.row.key) { dfr.armed = null; tblRenderTabs() } else dfrArm(); return true }
  dfrPick(R.row.key, dfrChoices(R)[+b.dataset.dfr])
  return true
}

// A woke row is down again once the person opened it and went elsewhere.
function dfrLeave(next) {
  const prev = dfr.viewing
  dfr.viewing = next
  if (dfr.armed && dfr.armed.key !== next) dfr.armed = null
  if (!prev || prev === next) return
  const R = tblFind(prev)
  if (!R || !R.woke) return
  dfr.seen[prev] = Date.now()
  cmdPost({ kind: 'defer_seen', sid: R.row.sid })
}

// A memo: the words in a session's box kept, not sent.
async function dfrMemoAdd(sid, text, box) {
  if (!text) { toast('메모로 남길 말을 쓰세요'); return false }
  const j = await cmdPost({ kind: 'memo_add', sid, text })
  if (!j) return false
  if (box) box.value = ''
  toast('📝 ' + (j.sent || '메모로 남겼습니다') + ' · 세션에는 보내지 않았습니다')
  const row = (cmd.data?.table || []).find((r) => r.sid === sid)
  if (row && j.memo) row.memos = [...(row.memos || []), j.memo]
  cmdRender()
  cmdLoad()
  return true
}

async function dfrMemoSend(sid, id) {
  const sig = sid + '|' + id
  const force = !!dfr.force && dfr.force.sig === sig && Date.now() - dfr.force.at < 8000
  dfr.force = null
  const j = await cmdPost({ kind: 'memo_send', sid, id, ...(force ? { force: true } : {}) }, true)
  if (!j) return
  if (j.busy) {
    dfr.force = { sig, at: Date.now() }
    toast((j.busy === 'working' ? '🔨 일하는 중이라 보내면 끝난 뒤 이어서 처리됩니다' : '📨 앞서 보낸 답이 아직 전달 전입니다') + ' — 그래도 보내려면 한 번 더 보내기')
    return
  }
  toast('📨 ' + (j.sent || '메모를 보냈습니다'))
  cmd.sent[sid] = Date.now()
  dfrMemoGone(sid, id)
}
async function dfrMemoDel(sid, id) {
  const j = await cmdPost({ kind: 'memo_del', sid, id })
  if (!j) return
  toast('🗑 ' + (j.sent || '지웠습니다'))
  dfrMemoGone(sid, id)
}
function dfrMemoGone(sid, id) {
  const row = (cmd.data?.table || []).find((r) => r.sid === sid)
  if (row) row.memos = (row.memos || []).filter((m) => m.id !== id)
  cmdRender()
  cmdLoad()
}

const dfrMemosOf = (sid) => ((cmd.data?.table || []).find((r) => r.sid === sid)?.memos || [])

// The memo tab, where a brief opens: the memos, each 보내기 · 지우기, and a
// box for one more (Enter keeps it). Its look is made once; the list is
// redrawn only when it changes, so what is typed stays.
function dfrRenderMemos(bar, doc, dec, s) {
  if (cmd.frame !== 'memo:' + s.memos || !doc.querySelector('.memos')) {
    cmd.frame = 'memo:' + s.memos
    bar.innerHTML = '<b>📝 메모 · ' + cmdEsc(s.summary || s.name || '') + '</b><span class="m"></span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;padding:10px 12px;overflow:auto'
    doc.innerHTML = '<div class="memos"></div><div class="memoadd"><textarea class="note" data-memo="' + cmdEsc(s.memos) + '" placeholder="메모 더 남기기 (Enter 저장 · ⇧Enter 줄바꿈 · 세션에는 보내지 않음)"></textarea></div>'
    dec.style.display = 'none'; dec.innerHTML = ''; dec.dataset.key = ''
    doc.querySelector('.memos').onclick = (ev) => {
      const b = ev.target.closest('button[data-ms], button[data-md]')
      if (b && b.dataset.ms) dfrMemoSend(s.memos, b.dataset.ms)
      else if (b) dfrMemoDel(s.memos, b.dataset.md)
    }
    const ta = doc.querySelector('.memoadd textarea')
    cmdBoxKeys(ta, (e) => dfrMemoKey(e, s.memos))
  }
  const list = doc.querySelector('.memos'), ms = dfrMemosOf(s.memos), key = JSON.stringify(ms)
  if (list.dataset.key === key) return
  list.dataset.key = key
  bar.querySelector('.m').textContent = ms.length + '개 · 보내기는 그 세션에 답장으로 보냅니다'
  list.innerHTML = ms.length ? ms.map((m) => '<div class="memo"><div class="t">' + cmdEsc(m.text) + '</div><div class="row"><span class="m">' + cmdEsc(cmdAgo(new Date((m.at || 0) * 1000).toISOString())) + '</span><button class="act" data-ms="' + cmdEsc(m.id) + '">📨 보내기</button><button class="act" data-md="' + cmdEsc(m.id) + '">🗑 지우기</button></div></div>').join('') : '<div class="m">남은 메모가 없습니다.</div>'
}

// Keys in the memo tab's box: Enter keeps the words as a memo, Esc leaves.
function dfrMemoKey(e, sid) {
  if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); return true }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false
  e.preventDefault()
  dfrMemoAdd(sid, e.target.value.trim(), e.target)
  return true
}

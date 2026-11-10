// The review queue in the command view (지휘): finished work each coordinator
// put up for the person to judge (coord_review; office/review.py reads the
// queues into /command's `reviews`).
//
// The list shows the open items under 🔎 검토, after the sessions waiting on
// the person: j/k walk the decisions, then those sessions, then these. A
// picked item opens where a brief does: what changed, what was verified and
// what was not, what to check, the risk, its links. 확인함 (1, then Enter)
// takes it off the list and tells its coordinator `[review] confirmed <id>`;
// 문제 있음 is the box under it (m, or ⌥M where TWeb's normal mode keeps
// bare m): Enter sends the words as
// `[review] issue <id>: <words>`, and the item stays open until it is
// confirmed. Loaded before command.js, whose list, doc pane and keys call
// these; everything here runs only once the view does.

const REV_CSS = `
#command .rev h4 { font-size: 12px; color: #7a7090; margin: 10px 0 2px; font-weight: 600; }
#command .rev h4:first-child { margin-top: 0; }
#command .rev .none { color: #9a93a8; }
#command .rev ul.links { margin: 0; padding-left: 18px; }
#command .rev ul.links a { word-break: break-all; }
#command .rev .issue { background: #fff3c4; border-radius: 6px; padding: 2px 6px; margin: 2px 0; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: REV_CSS }))

const revList = () => cmd.data?.reviews || []
const revOf = (s) => (s && s.review ? revList().find((r) => r.coord === s.coord && r.id === s.review) : undefined)
function revPick(r) { cmd.sel = { review: r.id, coord: r.coord, title: r.title }; cmd.armed = null; cmd.q = null; cmd.force = null }
const revIsSel = (r) => !!cmd.sel && cmd.sel.review === r.id && cmd.sel.coord === r.coord
const revMs = (ms) => (ms ? new Date(+ms).toISOString() : '')

// The list's 🔎 검토 group.
function revSection() {
  const rs = revList()
  const out = ['<h3>🔎 검토 <span class="m">' + rs.length + '건 · 확인하면 빠짐 · j/k</span></h3>']
  if (!rs.length) out.push('<div class="m" style="margin-bottom:10px">검토할 완료 항목이 없습니다. coordinator가 merge한 일을 <code>coord_review</code>로 올리면 여기에 나옵니다.</div>')
  else out.push('<ul class="feed">' + rs.map((r) => '<li data-review="' + cmdEsc(r.id) + '" data-rcoord="' + cmdEsc(r.coord) + '"' + (revIsSel(r) ? ' class="sel"' : '') + ' title="' + cmdEsc(r.id) + '">' + (r.issues && r.issues.length ? '⚠ ' : '🔎 ') + cmdEsc(r.title)
    + ' <span class="m">' + cmdEsc(['🎖 ' + r.coordName, cmdAgo(revMs(r.updatedAt || r.at))].filter(Boolean).join(' · ')) + '</span></li>').join('') + '</ul>')
  return out.join('')
}

// A click in the list on one of these; false when it was not one.
function revClick(ev) {
  const li = ev.target.closest('li[data-review]')
  if (!li) return false
  const r = revList().find((x) => x.id === li.dataset.review && x.coord === li.dataset.rcoord)
  if (r) { revPick(r); cmdRender() }
  return true
}

// A link of an item: a brief opens in this pane as any brief does; anything
// else (a PR, a file) opens where its coordinator's own links go.
function revOpen(v, r) {
  const brief = /(^|\/)briefs\/\d{4}-\d{2}-\d{2}-[\w.-]+\.html$/.test(v)
  if (brief) { cmdPick({ file: v.split('/').pop(), path: v, title: v.split('/').pop() }); cmdRender(); return }
  cmdPost({ sid: r.coord, kind: 'open', value: v }).then((j) => { if (j) toast('↗ ' + (j.sent || '열었습니다')) })
}

function revField(name, text) {
  return '<h4>' + name + '</h4>' + (text ? (typeof md === 'function' ? md(text) : '<p>' + cmdEsc(text) + '</p>') : '<div class="none">—</div>')
}

// The picked item where a brief opens. Redrawn only when the item changes
// (the 3 s poll keeps what is typed in the box).
function revRenderDoc(bar, doc, dec, s) {
  const r = revOf(s)
  if (cmd.frame !== 'review:' + s.coord + '|' + s.review) {
    cmd.frame = 'review:' + s.coord + '|' + s.review
    bar.innerHTML = '<b>🔎 ' + cmdEsc(s.title || s.review) + '</b><span class="m"></span><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="said rev"></div>'
    dec.dataset.key = ''
  }
  const said = doc.querySelector('.said'), skey = JSON.stringify(r || null)
  if (said.dataset.key !== skey) {
    said.dataset.key = skey
    if (!r) said.innerHTML = '<div class="m">이 항목은 목록에 없습니다 (확인됐거나 coordinator가 지웠습니다).</div>'
    else {
      bar.querySelector('.m').textContent = [r.id, '🎖 ' + r.coordName, cmdAgo(revMs(r.updatedAt || r.at))].filter(Boolean).join(' · ')
      said.innerHTML = revField('변경', r.changed) + revField('검증', r.verified) + revField('확인할 것', r.check) + revField('위험', r.risk)
        + '<h4>링크</h4>' + (r.links.length ? '<ul class="links">' + r.links.map((l) => '<li><a href="#" data-rlink="' + cmdEsc(l) + '">' + cmdEsc(l) + '</a></li>').join('') + '</ul>' : '<div class="none">—</div>')
        + (r.issues && r.issues.length ? '<h4>보낸 문제</h4>' + r.issues.map((i) => '<div class="issue">⚠ ' + cmdEsc(i.text) + ' <span class="m">' + cmdEsc(cmdAgo(revMs(i.at))) + '</span></div>').join('') : '')
      said.onclick = (ev) => { const a = ev.target.closest('a[data-rlink], a[data-open]'); if (a) { ev.preventDefault(); revOpen(a.dataset.rlink || a.dataset.open, r) } }
    }
  }
  const armed = !!cmd.armed && cmd.armed.review === s.review
  const key = JSON.stringify([!!r, armed])
  if (dec.dataset.key === key) return
  const typed = dec.querySelector('.note[data-review]')?.value || '', focused = !!document.activeElement && dec.contains(document.activeElement)
  dec.dataset.key = key
  if (!r) { dec.style.display = 'none'; dec.innerHTML = ''; return }
  dec.style.display = 'block'
  dec.innerHTML = '<div class="m" style="margin-bottom:4px">→ 🎖 ' + cmdEsc(r.coordName) + ' · 확인함은 목록에서 빠지고, 문제 있음은 열린 채 남습니다</div>'
    + '<div class="qa"><div class="opts"><button class="act opt rec ok' + (armed ? ' armed' : '') + '"><span class="key">1</span>✅ 확인함</button><button class="act opt bad" title="m · TWeb에서는 ⌥M"><span class="key">⌥M</span>⚠ 문제 있음</button></div>'
    + '<div class="row"><input type="text" class="note" data-review="' + cmdEsc(r.id) + '" placeholder="무엇이 문제인지 쓰고 Enter → coordinator에게 (Esc 나가기)"></div></div>'
  dec.querySelector('.ok').onclick = () => revConfirm(s)
  const note = dec.querySelector('.note')
  dec.querySelector('.bad').onclick = () => { if (note.value.trim()) revIssue(s, note.value.trim()); else note.focus() }
  note.value = typed
  note.onkeydown = (e) => revBoxKey(e, s)
  if (focused) note.focus()
}

// Keys in an item's box: Enter sends the words as the issue; with none, the
// armed 확인함 (1 first); with neither, a toast says what to do. Esc leaves
// the box. Everything else is typing.
function revBoxKey(e, s) {
  if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); return true }
  // keyCode 229: WebKit's Enter that ends a Hangul composition.
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false
  e.preventDefault()
  const text = e.target.value.trim()
  if (text) revIssue(s, text)
  else if (cmd.armed && cmd.armed.review === s.review) revConfirm(s)
  else toast('무엇이 문제인지 쓰고 Enter · 확인했으면 1 뒤 Enter')
  return true
}

// The view's keys on a picked item (commandKey asks after j/k): 1 arms
// 확인함, Enter sends it, m to the box (⌥M is commandKey's). `hit` is
// commandKey's.
function revKey(k, s, hit) {
  if (k === '1') return hit(() => { cmd.armed = { review: s.review }; cmdRenderDoc(); toast('Enter로 「확인함」 보내기') })
  if (k === 'Enter' && cmd.armed && cmd.armed.review === s.review) return hit(() => revConfirm(s))
  if (k === 'm') return hit(revFocus)
  return false
}
function revFocus() { cmdEl.querySelector('.decide .note[data-review]')?.focus() }

// 확인함: off the list, on to the next item (or closed when none is left).
async function revConfirm(s) {
  const j = await cmdPost({ kind: 'review_confirm', coord: s.coord, id: s.review })
  if (!j) return
  toast('✅ ' + (j.sent || '확인함'))
  const rs = revList(), at = rs.findIndex((r) => r.coord === s.coord && r.id === s.review)
  const rest = rs.filter((_, i) => i !== at)
  if (cmd.data) cmd.data.reviews = rest
  const next = rest[at] || rest[at - 1]
  if (next) revPick(next); else cmdShut()
  cmdRender()
}

// 문제 있음: the words to the coordinator; the item stays, the words on it.
async function revIssue(s, text) {
  const j = await cmdPost({ kind: 'review_issue', coord: s.coord, id: s.review, value: text })
  if (!j) return
  toast('⚠ ' + (j.sent || '보냈습니다'))
  const r = revOf(s)
  if (r) r.issues = [...(r.issues || []), { text, at: Date.now() }]
  const note = cmdEl.querySelector('.decide .note[data-review]')
  if (note) note.value = ''
  cmd.armed = null
  cmdRender()
}

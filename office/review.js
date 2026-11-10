// The review queue in the command view (지휘): finished work each coordinator
// put up for the person to judge (coord_review; office/review.py reads the
// queues into /command's `reviews`).
//
// Each item belongs to a session's row of the table (table.js: the worker its
// id names, else the coordinator that put it up). The row's 🔎 검토 tab opens
// its items as one list where a brief opens ({ revs: <row key> }): a line
// each, unfolded to what changed, what was verified and what was not, what
// to check, the risk, its links; 확인함 on each, and 모두 확인함 for the lot.
// An item opened by itself ({ review, coord }: a link, the box's chip) shows
// alone, as before. 확인함 (1, then Enter, on the unfolded item)
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
#command .revs .ri { border: 2px solid rgba(59,42,53,.14); border-radius: 10px; margin: 0 0 6px; background: #fff; }
#command .revs .ri.on { border-color: #2a2033; }
#command .revs .ri > .rh { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; }
#command .revs .ri > .rh .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command .revs .ri > .rb { padding: 0 10px 8px; border-top: 1px dashed rgba(59,42,53,.14); }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: REV_CSS }))

const revList = () => cmd.data?.reviews || []
const revOf = (s) => (s && s.review ? revList().find((r) => r.coord === s.coord && r.id === s.review) : undefined)
function revPick(r) { cmd.sel = { review: r.id, coord: r.coord, title: r.title }; cmd.armed = null; cmd.q = null; cmd.force = null; cmd.row = null }
const revIsSel = (r) => !!cmd.sel && cmd.sel.review === r.id && cmd.sel.coord === r.coord
// A row's items, open now ({ revs: <row key> }; table.js tblFind).
const revRow = (s) => (s && s.revs && typeof tblFind === 'function' ? tblFind(s.revs)?.rs || [] : [])
// The item the keys and the box work on: a lone item, else the unfolded one of a row's.
function revCur(s) {
  if (s && s.review) return revOf(s)
  const rs = revRow(s)
  return rs.find((r) => r.coord + '|' + r.id === s.open) || rs[0]
}
const revSel = (r) => ({ review: r.id, coord: r.coord, title: r.title })
const revMs = (ms) => (ms ? new Date(+ms).toISOString() : '')

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
function revBody(r) {
  return revField('변경', r.changed) + revField('검증', r.verified) + revField('확인할 것', r.check) + revField('위험', r.risk)
    + '<h4>링크</h4>' + (r.links.length ? '<ul class="links">' + r.links.map((l) => '<li><a href="#" data-rlink="' + cmdEsc(l) + '">' + cmdEsc(l) + '</a></li>').join('') + '</ul>' : '<div class="none">—</div>')
    + (r.issues && r.issues.length ? '<h4>보낸 문제</h4>' + r.issues.map((i) => '<div class="issue">⚠ ' + cmdEsc(i.text) + ' <span class="m">' + cmdEsc(cmdAgo(revMs(i.at))) + '</span></div>').join('') : '')
}

// A row's items where a brief opens: a line each, the open one unfolded,
// 확인함 on each line and 모두 확인함 over them. The box under it speaks
// about the unfolded item.
function revRenderList(bar, doc, dec, s) {
  const rs = revRow(s), cur = revCur(s)
  if (cmd.frame !== 'revs:' + s.revs) {
    cmd.frame = 'revs:' + s.revs
    bar.innerHTML = '<b>🔎 ' + cmdEsc(s.title || '') + '</b><span class="m"></span><button class="act all" title="이 세션의 검토 항목을 모두 확인함">✅ 모두 확인함</button><button class="act shut" title="닫기 (Esc)">✕</button>'
    bar.querySelector('.shut').onclick = cmdShut
    bar.querySelector('.all').onclick = () => revConfirmAll(s)
    doc.className = 'doc'; doc.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
    doc.innerHTML = '<div class="said rev revs"></div>'
    doc.querySelector('.said').onclick = (ev) => {
      const a = ev.target.closest('a[data-rlink], a[data-open]')
      if (a) { ev.preventDefault(); const r = revCur(cmd.sel); if (r) revOpen(a.dataset.rlink || a.dataset.open, r); return }
      const ok = ev.target.closest('button[data-ok]')
      if (ok) { const r = rs.find((x) => x.coord + '|' + x.id === ok.dataset.ok) || revRow(cmd.sel).find((x) => x.coord + '|' + x.id === ok.dataset.ok); if (r) revConfirm(revSel(r)); return }
      const h = ev.target.closest('.rh[data-k]')
      if (h) { cmd.sel.open = h.dataset.k; cmd.armed = null; cmdRenderDoc() }
    }
    dec.dataset.key = ''
  }
  const said = doc.querySelector('.said'), skey = JSON.stringify([rs, cur && cur.coord + '|' + cur.id])
  if (said.dataset.key !== skey) {
    said.dataset.key = skey
    bar.querySelector('.m').textContent = rs.length ? rs.length + '건' + (rs[0].coordName ? ' · 🎖 ' + rs[0].coordName : '') : ''
    bar.querySelector('.all').disabled = rs.length < 2
    if (!rs.length) said.innerHTML = '<div class="m">검토할 항목이 남지 않았습니다.</div>'
    else said.innerHTML = rs.map((r) => {
      const k = r.coord + '|' + r.id, on = r === cur
      return '<div class="ri' + (on ? ' on' : '') + '"><div class="rh" data-k="' + cmdEsc(k) + '">' + (on ? '▾' : '▸') + ' ' + (r.issues && r.issues.length ? '⚠' : '🔎') + ' <span class="t">' + cmdEsc(r.title || r.id) + ' <span class="m">' + cmdEsc([r.id, cmdAgo(revMs(r.updatedAt || r.at))].filter(Boolean).join(' · ')) + '</span></span>'
        + '<button class="act" data-ok="' + cmdEsc(k) + '" title="이 항목 확인함">✅ 확인함</button></div>' + (on ? '<div class="rb">' + revBody(r) + '</div>' : '') + '</div>'
    }).join('')
  }
  revRenderBox(dec, cur ? revSel(cur) : null, cur)
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
      said.innerHTML = revBody(r)
      said.onclick = (ev) => { const a = ev.target.closest('a[data-rlink], a[data-open]'); if (a) { ev.preventDefault(); revOpen(a.dataset.rlink || a.dataset.open, r) } }
    }
  }
  revRenderBox(dec, s, r)
}

// The box under an item (lone or unfolded in a row's list): 확인함 and 문제 있음.
function revRenderBox(dec, s, r) {
  const armed = !!s && !!cmd.armed && cmd.armed.review === s.review
  const key = JSON.stringify([r ? r.coord + '|' + r.id : null, armed])
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

// The view's keys on a picked item, or on the unfolded one of a row's list
// (commandKey asks after j/k): 1 arms 확인함, Enter sends it, m to the box
// (⌥M is commandKey's). `hit` is commandKey's.
function revKey(k, sel, hit) {
  const r = revCur(sel), s = r ? revSel(r) : null
  if (!s) return false
  if (k === '1') return hit(() => { cmd.armed = { review: s.review }; cmdRenderDoc(); toast('Enter로 「확인함」 보내기') })
  if (k === 'Enter' && cmd.armed && cmd.armed.review === s.review) return hit(() => revConfirm(s))
  if (k === 'm') return hit(revFocus)
  return false
}
function revFocus() { cmdEl.querySelector('.decide .note[data-review]')?.focus() }

// 확인함: off the list; then the row's next item, its next need, or the
// next row (table.js tblAfter).
async function revConfirm(s) {
  const j = await cmdPost({ kind: 'review_confirm', coord: s.coord, id: s.review })
  if (!j) return
  toast('✅ ' + (j.sent || '확인함'))
  revGone([s])
}

// 모두 확인함: every item of the row's list, one post each.
async function revConfirmAll(sel) {
  const rs = revRow(sel).map(revSel), done = []
  for (const s of rs) if (await cmdPost({ kind: 'review_confirm', coord: s.coord, id: s.review })) done.push(s)
  if (!done.length) return
  toast('✅ ' + done.length + '건 확인함')
  revGone(done)
}

// Out of the data first, then on. A lone item opened from a row's tab (its
// key in cmd.row) goes on as the row does.
function revGone(gone) {
  const out = new Set(gone.map((s) => s.coord + '|' + s.review))
  if (typeof tblMark === 'function') tblMark((R) => (R.row.reviews || []).some(([c, id]) => out.has(c + '|' + id)))
  if (cmd.data) cmd.data.reviews = revList().filter((r) => !out.has(r.coord + '|' + r.id))
  cmd.armed = null
  if (cmd.sel) cmd.sel.open = null
  if (typeof tblAfter === 'function' && cmd.row) tblAfter()
  else { cmdShut(); cmdRender() }
}

// 문제 있음: the words to the coordinator; the item stays, the words on it.
async function revIssue(s, text) {
  const j = await cmdPost({ kind: 'review_issue', coord: s.coord, id: s.review, value: text })
  if (!j) return
  toast('⚠ ' + (j.sent || '보냈습니다'))
  const r = revList().find((x) => x.coord === s.coord && x.id === s.review)
  if (r) r.issues = [...(r.issues || []), { text, at: Date.now() }]
  const note = cmdEl.querySelector('.decide .note[data-review]')
  if (note) note.value = ''
  cmd.armed = null
  cmdRender()
}

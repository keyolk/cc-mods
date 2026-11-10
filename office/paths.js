// File paths in what a session said become 👁 links that open the file in the
// office's own viewer (office.html viewFile, the 📎 tab's 👁), wherever the
// office draws a session's text: the card's answer and past turns, the 지휘
// view's last answer, btw replies, a brief's questions. A path written as
// `code`, as plain text, or already linked by linkify (which opens it in
// Finder) counts; absolute, ~/ and relative to the session's folder.
//
// Only a path the office would show becomes a link: the server answers which
// (POST /paths: one the session's own transcript names, under home, no
// credential, no symlink out, not too big; office/paths.py), and /file serves
// it with the same answer. Nothing here
// changes how the text is drawn: a MutationObserver finds each answer once it
// is on the page, so the files that draw them need no change. Loaded before
// command.js; viewFile, openLink, toast, cardSid and cmd are read when a link
// is pressed.

const PATHS_CSS = `
a.pv { color: #2f6fd6; text-decoration: underline dotted; cursor: pointer; }
a.pv code { text-decoration: inherit; color: inherit; }
a.pv::after { content: ' 👁'; font-size: 10px; }
#viewer .bar .cp { white-space: nowrap; }
`

// One path character: letters of any script (a Hangul file name), digits and
// what file names use. A path does not start right after one of these or ':'
// (the // of a URL), and ends before trailing punctuation.
const PC = '[\\p{L}\\p{N}_.@+~-]'
const ABS = new RegExp('(?<![\\p{L}\\p{N}_.@+~:/-])(?:~|/)' + PC + '*(?:/' + PC + '+)+(?::\\d+(?::\\d+)?)?', 'gu')
// A relative path in plain text needs a folder and an extension
// (office/paths.py), or "and/or" would be asked about.
const REL = new RegExp('(?<![\\p{L}\\p{N}_.@+~:/-])(?:\\.{1,2}/)?[\\p{L}\\p{N}_@+-]' + PC + '*(?:/' + PC + '+)+\\.[A-Za-z0-9]{1,8}(?::\\d+(?::\\d+)?)?(?![\\p{L}\\p{N}_@+~/:-]|\\.[\\p{L}\\p{N}])', 'gu')
const WHOLE = new RegExp('^(?:~|/|\\.{1,2}/)?' + PC + '+(?:/' + PC + '+)*/?(?::\\d+(?::\\d+)?)?$', 'u')

// The paths in a run of plain text, each with where it starts.
function pathCands(text) {
  const out = []
  for (const re of [ABS, REL]) {
    re.lastIndex = 0
    for (let m; (m = re.exec(text));) {
      const p = m[0].replace(/[.,;:)]+$/, '')
      if (p.length > 2 && !out.some((o) => m.index < o.at + o.p.length && o.at < m.index + p.length)) out.push({ p, at: m.index })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
// A `code` span that is a path and nothing else (README.md and other
// relative ones are read from the session's folder).
function codePath(text) {
  const t = String(text || '').trim()
  if (t.length < 3 || t.length > 400 || !WHOLE.test(t) || /^\d/.test(t) && !t.includes('/')) return null
  // A folder in it is not enough ("and/or"): it starts at ~, / or ./, or
  // names a file with an extension (README.md, office/paths.py:12).
  return /^(~|\.{0,2}\/)/.test(t) || /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?$/.test(t) ? t.replace(/\/$/, '') : null
}

// What a session said lives in these; nothing else on the page is read.
const PATH_ROOTS = '.said, .ask, .pastask, .it'
// Which session a root belongs to: relative paths are read from its folder.
function pathSid(el) {
  if (el.closest('#command')) return (typeof cmd !== 'undefined' && cmd.sel && cmd.sel.sid) || ''
  return (typeof cardSid !== 'undefined' && cardSid) || (typeof cmd !== 'undefined' && cmd.sel && cmd.sel.sid) || ''
}

// sid + path → its real path, or null when the office will not show it. The
// panes are drawn again on every poll; each path is asked about once.
const pathSeen = new Map()
const pathWait = new Map() // sid → Set of paths to ask about
let pathAsking = null
function pathAsk(sid, list) {
  for (const p of list) {
    if (pathSeen.has(sid + '\0' + p)) continue
    if (!pathWait.has(sid)) pathWait.set(sid, new Set())
    pathWait.get(sid).add(p)
  }
  if (!pathWait.size) return Promise.resolve()
  if (!pathAsking) pathAsking = Promise.resolve().then(async () => {
    const jobs = [...pathWait.entries()]; pathWait.clear()
    await Promise.all(jobs.map(async ([s, set]) => {
      const ps = [...set]
      let got = {}
      try {
        const r = await fetch('/paths', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN }, body: JSON.stringify({ sid: s, paths: ps }) })
        if (r.ok) got = await r.json()
        else if (r.status === 403) return // an older server's token: not worth a reload here
      } catch { return } // asked again on the next draw
      for (const p of ps) pathSeen.set(s + '\0' + p, got[p] || null)
    }))
    pathAsking = null
  })
  return pathAsking
}

// The links a root could hold: its `code` spans, linkify's path links and
// its plain text.
function pathScan(root) {
  const codes = [], opens = [], texts = []
  // A file shown in the viewer is not in the session's folder: a relative
  // path in it would name some other file.
  const rel = !root.closest('#viewer'), ok = (p) => rel || /^[~/]/.test(p)
  for (const c of root.querySelectorAll('code')) {
    if (c.closest('pre, a')) continue
    const p = codePath(c.textContent)
    if (p && ok(p)) codes.push([c, p])
  }
  for (const a of root.querySelectorAll('a[data-open]:not([data-view])')) {
    const v = a.dataset.open
    if (v && !/^[a-z][\w+.-]*:/i.test(v)) opens.push([a, v])
  }
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('a, code, pre, button, textarea, input') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
  for (let n; (n = walk.nextNode());) {
    const cs = pathCands(n.nodeValue).filter((c) => ok(c.p))
    if (cs.length) texts.push([n, cs])
  }
  return { codes, opens, texts }
}

async function pathLink(root) {
  if (!root.isConnected) return
  const sid = pathSid(root), s = pathScan(root)
  const all = [...s.codes.map((x) => x[1]), ...s.opens.map((x) => x[1]), ...s.texts.flatMap((x) => x[1].map((c) => c.p))]
  if (!all.length) return
  await pathAsk(sid, all)
  const real = (p) => pathSeen.get(sid + '\0' + p)
  for (const [c, p] of s.codes) {
    const r = real(p)
    if (!r || !c.isConnected || c.closest('a')) continue
    const a = pathAnchor(r, p); c.replaceWith(a); a.appendChild(c)
  }
  for (const [a, p] of s.opens) {
    const r = real(p)
    if (r && a.isConnected) { a.dataset.view = r; a.classList.add('pv'); a.title = pathTitle(r) }
  }
  for (const [n, cs] of s.texts) {
    if (!n.isConnected || !cs.some((c) => real(c.p))) continue
    const f = document.createDocumentFragment(), t = n.nodeValue
    let at = 0
    for (const c of cs) {
      const r = real(c.p)
      if (!r) continue
      f.append(t.slice(at, c.at))
      const a = pathAnchor(r, c.p); a.textContent = c.p; f.append(a)
      at = c.at + c.p.length
    }
    f.append(t.slice(at))
    n.replaceWith(f)
  }
}
function pathTitle(r) { return '👁 office 안에서 보기 · ⌥클릭: 밖으로 열기\n' + r }
function pathAnchor(r, raw) {
  const a = document.createElement('a')
  a.className = 'pv'; a.dataset.view = r; a.dataset.raw = raw; a.title = pathTitle(r)
  return a
}

// A press on a 👁 link opens the viewer, the 📎 tab's 👁 does; ⌥ opens it where
// files open outside. Taken in the capture phase, before the pane's own
// handler (which would reveal the file in Finder).
function pathPress(ev) {
  const a = ev.target.closest && ev.target.closest('a[data-view]')
  if (!a) return
  ev.preventDefault(); ev.stopPropagation()
  if (ev.altKey) return openLink(a.dataset.view)
  viewFile(a.dataset.view, pathSid(a))
}

// The viewer's bar gets a button that copies the path it shows.
async function pathCopy(p) {
  let ok = false
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(p); ok = true } } catch { /* the old way below */ }
  if (!ok) {
    const t = Object.assign(document.createElement('textarea'), { value: p })
    t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select()
    try { ok = document.execCommand('copy') } catch { ok = false }
    t.remove()
  }
  if (typeof toast === 'function') toast(ok ? '⧉ 경로를 복사했습니다: ' + p : '✕ 복사하지 못했습니다')
}
function pathViewerBar(v) {
  const bar = v.querySelector(':scope > .bar'), out = bar && bar.querySelector('.out')
  if (!out || bar.querySelector('.cp')) return
  const b = Object.assign(document.createElement('button'), { className: 'cp', textContent: '⧉ 경로', title: '이 파일의 경로를 복사합니다' })
  b.onclick = () => pathCopy(v.path || bar.querySelector('.m')?.textContent || '')
  out.before(b)
}

// Every root that changed is looked at once per frame.
const pathDirty = new Set()
let pathFrame = 0
function pathMutated(muts) {
  for (const m of muts) {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement
    if (!t) continue
    if (t.id === 'viewer' || t.closest('#viewer > .bar')) { const v = t.closest('#viewer'); if (v) pathViewerBar(v) }
    const r = t.closest(PATH_ROOTS)
    if (r) pathDirty.add(r)
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue
      if (n.matches(PATH_ROOTS)) pathDirty.add(n)
      for (const x of n.querySelectorAll(PATH_ROOTS)) pathDirty.add(x)
    }
  }
  if (pathDirty.size && !pathFrame) pathFrame = requestAnimationFrame(() => {
    pathFrame = 0
    const roots = [...pathDirty]; pathDirty.clear()
    // An outer root covers the ones inside it.
    for (const r of roots) if (!roots.some((o) => o !== r && o.contains(r))) pathLink(r)
  })
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: PATHS_CSS }))
  addEventListener('click', pathPress, true)
  new MutationObserver(pathMutated).observe(document.body || document.documentElement, { childList: true, subtree: true })
}

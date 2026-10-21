// The cockpit's Web tab: a TWeb page drawn in a region of this pane by
// bin/cc-browser. This file is the pure half: the marker the region draws so
// the bridge can find it, and the terminal bytes a click or key becomes on
// the way to the engine (which reads them as a tmux pane's input would be).

export type WebState = {
  running: boolean
  engine?: WebEngine
  url?: string
  asked?: string // the URL that was opened, before redirects or a data: page
  title?: string
  shown?: boolean
  floating?: boolean // TWeb float: the page shows as an OS window
  error?: string
}

export const WEB_IDLE: WebState = { running: false }

// The Web tab's field row (views/web.ts) is what bin/cc-browser finds the page
// by: the line holding "│ go:" right of the column the mod names (the docked
// cockpit's left edge, so transcript text never matches). The page starts two
// rows below it, past the field's bottom border, at the column of that border; its size comes from the mod
// (POST /region). Change the row and the bridge's ANCHOR together. A
// zero-width marker was tried first: Claude Code drops those characters
// before they reach the terminal (measured), so tmux never sees them.
export const WEB_ANCHOR = '│ go:'

// What the Web tab's address field sends to the page: a URL as typed when it
// has a scheme, https:// added when it looks like a host (http:// for a local
// dev server), a search otherwise.
export function urlFromInput(text: string): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (/\s/.test(t)) return 'https://www.google.com/search?q=' + encodeURIComponent(t)
  // host:port reads like a scheme, so only `x://` or a scheme without a host counts.
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|data|file|chrome|mailto):/i.test(t)) return t
  // A local dev server speaks plain http.
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(t)) return 'http://' + t
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return 'https://' + t
  return 'https://www.google.com/search?q=' + encodeURIComponent(t)
}

// Raw terminal bytes sent to the hosted TWeb engine.
export function toHex(s: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, '0')
  return out
}

export type PointerMsg = {
  t: 'p'
  type: 'down' | 'move' | 'up' | 'enter' | 'leave'
  x: number
  y: number
  button?: 'left' | 'middle' | 'right'
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

export type KeyMsg = { t: 'k'; key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }

const BUTTON = { left: 0, middle: 1, right: 2 } as const

// SGR mouse (CSI < b ; x ; y M/m), 1-based cells of the region. A hover move
// without a button reports button 3 with the motion bit, as xterm's
// any-event mode does; enter and leave have no terminal form.
export function sgrMouse(m: PointerMsg): string | undefined {
  if (m.type === 'enter' || m.type === 'leave') return undefined
  let b = m.button ? BUTTON[m.button] : 3
  if (m.type === 'move') b |= 32
  if (m.shift) b |= 4
  if (m.alt) b |= 8
  if (m.ctrl) b |= 16
  const end = m.type === 'up' ? 'm' : 'M'
  return '\x1b[<' + b + ';' + (Math.max(0, m.x) + 1) + ';' + (Math.max(0, m.y) + 1) + end
}

export function sgrWheel(up: boolean, x: number, y: number): string {
  return '\x1b[<' + (up ? 64 : 65) + ';' + (Math.max(0, x) + 1) + ';' + (Math.max(0, y) + 1) + 'M'
}

const SPECIAL: Record<string, string> = {
  return: '\r',
  enter: '\r',
  tab: '\t',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' ',
}

// A key as a terminal sends it in legacy encoding: what the engine's tmux-mode
// input decoder reads. Ctrl+letter is the C0 control; meta (alt) prefixes ESC.
export function keyBytes(k: KeyMsg): string | undefined {
  let s = SPECIAL[k.key.toLowerCase()]
  if (s === undefined) {
    if ([...k.key].length !== 1) return undefined
    s = k.key
    if (k.ctrl && /^[a-z@[\\\]^_]$/i.test(s)) s = String.fromCharCode(s.toUpperCase().charCodeAt(0) & 0x1f)
  } else if (k.shift && k.key.toLowerCase() === 'tab') {
    s = '\x1b[Z'
  }
  return k.meta ? '\x1b' + s : s
}

// TWeb's page engines: Electron (Chromium, its own profile), Chrome (the
// user's managed Chrome over CDP: Okta device trust, extensions) and WebKit
// (macOS WKWebView through tweb-webkit; tweb's `tauri` is the same engine).
export const WEB_ENGINES = ['electron', 'chrome', 'webkit'] as const
export type WebEngine = (typeof WEB_ENGINES)[number]
export const WEB_ENGINE_LABEL: Record<WebEngine, string> = { electron: 'Electron', chrome: 'Chrome', webkit: 'WebKit' }

// `tauri` is tweb's old name for webkit; anything else is not an engine.
export function parseEngine(s: unknown): WebEngine | undefined {
  const v = String(s ?? '').trim().toLowerCase()
  if (v === 'tauri' || v === 'safari') return 'webkit'
  return (WEB_ENGINES as readonly string[]).includes(v) ? (v as WebEngine) : undefined
}

// The engine a browser target draws with, and back: tweb → electron,
// tweb-chrome → chrome, tweb-webkit → webkit.
export function engineOfTarget(target: string): WebEngine {
  return target === 'tweb-chrome' ? 'chrome' : target === 'tweb-webkit' ? 'webkit' : 'electron'
}

// Which engine a page draws with, by its URL: `claude.ai=chrome` puts
// claude.ai (and its subdomains) on Chrome, where the person's login and
// device trust live. A pattern is a host (`*` matches any run of characters)
// with an optional path prefix (`github.com/acme`); the first rule that
// matches wins, and no match leaves the engine the tab would use anyway.
export type EngineRule = { pattern: string; engine: WebEngine }

// `claude.ai=chrome, *.okta.com chrome`: comma or newline separated, `=` or a
// space between the pattern and the engine. Entries naming no engine are
// dropped, so a typo never turns into a rule.
export function parseEngineRules(text: unknown): EngineRule[] {
  const out: EngineRule[] = []
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const m = /^\s*(\S+?)\s*(?:=|\s)\s*(\S+)\s*$/.exec(part)
    const engine = m ? parseEngine(m[2]) : undefined
    const pattern = m ? normalizePattern(m[1]!) : ''
    if (engine && pattern) out.push({ pattern, engine })
  }
  return out
}

export function formatEngineRules(rules: readonly EngineRule[]): string {
  return rules.map((r) => r.pattern + '=' + r.engine).join(', ')
}

function normalizePattern(p: string): string {
  return p.trim().toLowerCase().replace(/^[a-z][\w+.-]*:\/\//, '').replace(/\/+$/, '')
}

export function ruleMatches(pattern: string, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(u.protocol)) return false
  const p = normalizePattern(pattern)
  const slash = p.indexOf('/')
  const hostPat = slash < 0 ? p : p.slice(0, slash)
  const pathPat = slash < 0 ? '' : p.slice(slash)
  const host = u.hostname.toLowerCase()
  const hostOk = hostPat.includes('*')
    ? new RegExp('^' + hostPat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(host)
    : host === hostPat || host.endsWith('.' + hostPat)
  if (!hostOk) return false
  if (!pathPat) return true
  const path = u.pathname.toLowerCase()
  return path === pathPat || path.startsWith(pathPat.endsWith('/') ? pathPat : pathPat + '/')
}

export function engineForUrl(url: string, rules: readonly EngineRule[]): WebEngine | undefined {
  return rules.find((r) => ruleMatches(r.pattern, url))?.engine
}

// URLs this session has met, for the Web tab's go field: what it produced
// (PRs, artifacts, tickets, Slack threads, links), newest first, one per URL,
// narrowed by what is typed (every word, in the URL or the title).
export type UrlPick = { url: string; title: string; kind: string }

// Every URL in a text (answers, prompts) as a pick candidate, titled by its
// host and path; trailing punctuation and markdown brackets are not the URL's.
export function urlsIn(text: string, at: number): { url: string; title: string; kind: string; at: number }[] {
  const out: { url: string; title: string; kind: string; at: number }[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>()\[\]`'"|]+/g)) {
    const url = m[0].replace(/[.,;:!?*_]+$/, '')
    let title = url
    try {
      const u = new URL(url)
      title = u.host + (u.pathname.length > 1 ? u.pathname : '')
    } catch {
      continue
    }
    out.push({ url, title, kind: 'link', at })
  }
  return out
}

// Tickets, Slack threads and GitHub pages have their own tabs and buttons all
// over the cockpit; what the Web tab is for is the rest (docs, dashboards,
// consoles, the pages a session read), so those come first.
export function pickRank(o: { url?: string; kind: string }): number {
  const u = o.url ?? ''
  if (o.kind === 'ticket' || /atlassian\.net\/browse\//.test(u)) return 1
  if (o.kind === 'slack' || /\.slack\.com\//.test(u)) return 1
  if (o.kind === 'pr' || /^https?:\/\/(www\.)?github\.com\//.test(u)) return 1
  return 0
}

export function urlPicks(outputs: readonly { url?: string; title: string; kind: string; at: number }[], query: string, limit = 8): UrlPick[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const seen = new Set<string>()
  const out: UrlPick[] = []
  for (const o of [...outputs].sort((a, b) => pickRank(a) - pickRank(b) || b.at - a.at)) {
    if (!o.url || !/^https?:\/\//.test(o.url) || seen.has(o.url)) continue
    const hay = (o.url + ' ' + o.title).toLowerCase()
    if (!words.every((w) => hay.includes(w))) continue
    seen.add(o.url)
    out.push({ url: o.url, title: o.title, kind: o.kind })
    if (out.length >= limit) break
  }
  return out
}

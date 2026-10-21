// The TWeb pane beside this session (browserEmbed off, the default): pages
// open in a tmux pane right of Claude Code, and the Web tab shows that pane's
// state and drives it with `tweb <command> --pane`. TWeb's own pane UI does
// the drawing and takes the keys, so none of the docked page's keyboard
// juggling applies.

import type { WebEngine } from './web'

export type SideTab = { index: number; title: string; url: string; active: boolean }

export type SidePane = { pane: string; engine: WebEngine; tabs: SideTab[]; presence?: SidePresence }

// What the TWeb pane itself shows about who else is at it (tweb's status.presence): an agent
// driving it (any agent, not only this session's), the controller linked to it, and when the
// person last acted while an agent drove. Absent from a tweb that predates it.
export type SidePresence = { driving?: { method: string; at: number }; link?: { owner: string; expiresAt: number }; conflictAt?: number }

export type SideWeb = {
  pane?: string // the TWeb pane the tab drives, in this session's tmux window
  engine?: WebEngine
  tabs: SideTab[]
  others: number // more TWeb panes in the window, not driven
  floating?: boolean // floated by this tab; TWeb's status does not say
  error?: string // the last command that failed, for one line under the controls
  checked?: number // when the panes were last listed
  panel?: SidePanel // the DevTools-like panel shown under the tabs
  console?: ConsoleLine[] // the driven pane's latest console records, newest last
  network?: NetLine[] // its latest requests, newest last
  link?: TwebLink // whether the last listing reached tweb at all
  presence?: SidePresence // the driven pane's own account of who is at it
  linkedAt?: number // when this session last renewed its link to the driven pane
  linkUnsupported?: boolean // the installed tweb has no `tweb link`
}

// The mod's line to TWeb, as the last listing found it. `missing`: no tweb on
// PATH; `down`: tweb ran but its supervisor (twebd) did not answer. Without
// this an unreachable tweb draws the same as "no pane beside".
export type TwebLink = { state: 'ok' | 'down' | 'missing'; at: number; detail?: string; daemon?: TwebDaemon }

export type TwebDaemon = { pid?: number; uptimeMs?: number; panes?: number; protocol?: number; engine?: string }

export type SidePanel = 'console' | 'network' | 'auto'

export type ConsoleLine = { at: string; level: string; text: string }
export type NetLine = { at: string; method: string; status?: number; type: string; url: string; failed?: boolean }

// One browser command an agent ran (Bash `tweb …`, a tweb MCP tool): the Web
// tab's automation log, and the "Claude is driving" badge while recent.
export type AutoStep = { id: string; at: number; verb: string; detail: string; pane?: string; state: 'running' | 'ok' | 'failed' }

export const SIDE_EMPTY: SideWeb = { tabs: [], others: 0 }

function engineOf(browser: unknown): WebEngine {
  return browser === 'chrome' || browser === 'webkit' ? browser : 'electron'
}

// `tweb panes --json`, narrowed to the panes in `inWindow` (this session's
// tmux window). A pane TWeb still lists can be gone from tmux for a moment
// after it exits, so the window's own pane list is the liveness check too.
// The entry's own `pane` is the id: an Electron pane reports `status.pane`
// as null. `self` (this session's pane) is skipped: a page the cockpit hosts
// is listed under it, and it is not a pane beside.
export function parseTwebPanes(json: string, inWindow: ReadonlySet<string>, self?: string): SidePane[] {
  let list: any
  try {
    list = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: SidePane[] = []
  for (const p of list) {
    const id = typeof p?.pane === 'string' ? p.pane : undefined
    if (!id || id === self || !inWindow.has(id)) continue
    const tabs = Array.isArray(p.status?.tabs?.tabs) ? p.status.tabs.tabs : []
    out.push({
      pane: id,
      presence: presenceOf(p.status?.presence),
      engine: engineOf(p.status?.browser),
      tabs: tabs.map((t: any, i: number) => ({ index: Number(t?.index ?? i), title: String(t?.title ?? ''), url: String(t?.url ?? ''), active: !!t?.active })),
    })
  }
  return out
}

// `tweb daemon status`: one `key value` per line (it has no --json).
export function parseDaemonStatus(text: string): TwebDaemon | undefined {
  const kv = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)\s+(.+)$/.exec(line.trim())
    if (m) kv.set(m[1]!, m[2]!.trim())
  }
  if (!kv.size) return undefined
  const num = (k: string) => (kv.has(k) && Number.isFinite(Number(kv.get(k))) ? Number(kv.get(k)) : undefined)
  return { pid: num('pid'), uptimeMs: num('uptime_ms'), panes: num('panes'), protocol: num('protocol'), engine: kv.get('engine') }
}

// What one listing's `tweb panes --json` run says about the link. A spawn that
// throws, or a shell's 127, is a tweb that is not installed.
export function linkOf(run: { exitCode?: number; stdout?: string; stderr?: string } | Error, at: number): TwebLink {
  if (run instanceof Error) return /ENOENT|not found/i.test(run.message) ? { state: 'missing', at, detail: 'tweb is not on PATH' } : { state: 'down', at, detail: run.message.split('\n')[0] }
  if (run.exitCode === 127) return { state: 'missing', at, detail: 'tweb is not on PATH' }
  const last = (s?: string) => String(s ?? '').trim().split('\n').pop() ?? ''
  if (run.exitCode !== 0) return { state: 'down', at, detail: last(run.stderr) || last(run.stdout) || 'tweb panes exited ' + run.exitCode }
  try {
    if (Array.isArray(JSON.parse(String(run.stdout ?? '')))) return { state: 'ok', at }
  } catch {
    // falls through
  }
  return { state: 'down', at, detail: 'tweb panes printed no pane list' }
}

function presenceOf(x: any): SidePresence | undefined {
  if (!x || typeof x !== 'object') return undefined
  const out: SidePresence = {}
  if (x.driving && typeof x.driving.method === 'string') out.driving = { method: x.driving.method, at: Number(x.driving.at) || 0 }
  if (x.link && typeof x.link.owner === 'string') out.link = { owner: x.link.owner, expiresAt: Number(x.link.expiresAt) || 0 }
  if (typeof x.conflictAt === 'number') out.conflictAt = x.conflictAt
  return out
}

// How this session names itself to the pane (`tweb link --owner`): what the pane shows as ⇄.
export function linkOwner(self: string): string {
  return 'cc-mods ' + self
}

// Seconds a link lives, and how often it is renewed. The Web tab lists every few seconds, other
// tabs once a minute, so the ttl outlives the slowest renewal: the ⇄ badge must not blink off.
export const LINK_TTL_S = 90
export const LINK_RENEW_MS = 20_000

export function linkArgv(pane: string, self: string): string[] {
  return sideArgv(pane, ['link', '--owner', linkOwner(self), '--ttl', String(LINK_TTL_S)])
}

// The pane to drive: the one already driven while it lives, else one on the
// wanted engine, else the first. A URL meant for managed Chrome must not land
// in Electron (device trust fails), so `strict` refuses another engine.
export function pickSidePane(panes: readonly SidePane[], want?: { engine?: WebEngine; prefer?: string; strict?: boolean }): SidePane | undefined {
  const byEngine = want?.engine ? panes.filter((p) => p.engine === want.engine) : panes
  const pool = want?.strict ? byEngine : byEngine.length ? byEngine : panes
  return pool.find((p) => p.pane === want?.prefer) ?? pool[0]
}

// The argv that sends one `tweb` command to the pane.
export function sideArgv(pane: string, argv: readonly string[]): string[] {
  return ['tweb', ...argv, '--pane', pane]
}

// The tmux argv that opens a TWeb pane right of `beside`, taking the keyboard
// there (an open the person asked for is to use the page). -P prints its id.
export function splitArgv(beside: string, engine: WebEngine, url: string, cwd = ''): string[] {
  return ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', beside, ...(cwd ? ['-c', cwd] : []), 'tweb', 'open', '--engine', engine, url]
}

function parseList(json: string, key: string): any[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v?.[key]) ? v[key] : Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// `tweb console --json`: one line per record, the message's first line.
export function parseConsole(json: string): ConsoleLine[] {
  return parseList(json, 'messages').map((m: any) => ({
    at: String(m?.at ?? ''),
    level: String(m?.level ?? 'log'),
    text: String(m?.message ?? '').split('\n')[0]!.replace(/%c/g, '').trim(),
  }))
}

// `tweb network --json`.
export function parseNetwork(json: string): NetLine[] {
  return parseList(json, 'requests').map((r: any) => ({
    at: String(r?.timestamp ?? ''),
    method: String(r?.method ?? 'GET'),
    status: typeof r?.statusCode === 'number' ? r.statusCode : undefined,
    type: String(r?.resourceType ?? ''),
    url: String(r?.url ?? ''),
    failed: !!(r?.failed || r?.errorText),
  }))
}

// Verbs that only read TWeb's own setup, not a page: left out of the log.
const NOT_AUTOMATION = new Set(['help', 'config', 'daemon', 'doctor', 'skill', 'profile', 'engine-paths', 'engine-log', 'extensions', 'diag', 'mcp', 'chrome', 'resource', '--help', '-h', '--version', '-V'])

// The `tweb <verb> …` commands in a shell command line, with their --pane.
// Quoted arguments stay whole so `tweb fill e3 "a b"` reads as one value.
export function twebSteps(command: string): { verb: string; detail: string; pane?: string }[] {
  const out: { verb: string; detail: string; pane?: string }[] = []
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const words = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const at = words.findIndex((w) => w === 'tweb' || /\/tweb$/.test(w))
    if (at < 0) continue
    const rest = words.slice(at + 1).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'))
    const verb = rest[0]
    if (!verb || NOT_AUTOMATION.has(verb)) continue
    let pane: string | undefined
    const args: string[] = []
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--pane') pane = rest[++i]
      else if (rest[i] !== '--json') args.push(rest[i]!)
    }
    out.push({ verb, detail: args.join(' ').slice(0, 160), pane })
  }
  return out
}

// A tweb MCP tool (mcp__tweb__click and the like): its verb and arguments.
export function twebMcpStep(tool: string, input: unknown): { verb: string; detail: string; pane?: string } | undefined {
  const m = /^mcp__[^_]*tweb[^_]*__(.+)$/i.exec(tool)
  if (!m) return undefined
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pane = typeof o.pane === 'string' ? o.pane : undefined
  const detail = Object.entries(o)
    .filter(([k]) => k !== 'pane')
    .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' ')
    .slice(0, 160)
  return { verb: m[1]!.replace(/^browser_/, ''), detail, pane }
}

// Keep MCP servers connected. A server that dropped (a proxy reset, a sleep,
// an expired session on the server's side) often comes back on a plain
// reconnect, but Claude Code leaves it disconnected until someone opens /mcp.
// A server is retried by name (`/mcp reconnect <server>`): `reconnect all`
// also retries every server that needs sign-in and leaves a transcript row
// each time. Pure: register.ts decides when to run it.
//
// /mcp takes the server's own name, as `claude mcp list` prints it
// (`claude.ai Slack`), bare. The tool-name spelling (`claude_ai_Slack`) and a
// quoted name both answer "There's no MCP server named …" (checked
// 2026-11-11 with `claude -p "/mcp reconnect …"`). The context breakdown's
// serverName, which the watch reads, is the tool-name spelling: until this
// was resolved, every reconnect of a claude.ai connector was refused, three
// times in a row, and the person reconnected Slack by hand from /mcp.

// An MCP tool result that says the server, not the call, is the problem.
const DISCONNECT = /not connected|connection (closed|reset|refused|lost)|disconnected|server (is )?(not running|unavailable)|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|transport (closed|error)|session (not found|expired)|-32000/i

export function isMcpTool(tool: unknown): boolean {
  return typeof tool === 'string' && tool.startsWith('mcp__')
}

// The text of a tool result or a deny, whatever shape it came in.
export function resultText(r: unknown): string {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r !== 'object') return String(r)
  const o = r as Record<string, unknown>
  if (typeof o.deny === 'string') return o.deny
  const parts: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1)
  }
  walk(o.result ?? o, 0)
  return parts.join('\n').slice(0, 4000)
}

export function looksDisconnected(r: unknown): boolean {
  return DISCONNECT.test(resultText(r))
}

// Claude Code names a server's tools mcp__<server>__<tool>, the server name
// with every character outside [A-Za-z0-9_-] turned into "_".
export function normalizeServer(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function mcpServerKey(tool: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(tool)
  return m ? m[1] : undefined
}

// This session's own MCP connections, apart from sign-in (`claude mcp list`,
// the radar, is one answer for every session): a server whose tools were here
// and are gone dropped in this session alone. The servers live now come from
// the context breakdown's MCP tools, named as /mcp lists them, so a reconnect
// takes the name as is. A server never seen here is not counted: it may be
// one this project leaves off, or one that needs signing in.
export type McpDrop = { server: string; since: number }
export type McpWatch = { seen: string[]; live: string[]; dropped: McpDrop[] }

export const MCP_WATCH_EMPTY: McpWatch = { seen: [], live: [], dropped: [] }

export function liveServers(tools: readonly { serverName?: unknown }[] | undefined): string[] {
  return [...new Set((tools ?? []).map((t) => t.serverName).filter((s): s is string => typeof s === 'string' && !!s))].sort()
}

export function nextWatch(prev: McpWatch, live: readonly string[], now: number): McpWatch {
  const seen = [...new Set([...prev.seen, ...live])].sort()
  const since = new Map(prev.dropped.map((d) => [d.server, d.since]))
  const dropped = seen.filter((s) => !live.includes(s)).map((server) => ({ server, since: since.get(server) ?? now }))
  return { seen, live: [...live], dropped }
}

// The name /mcp knows a server by, from any spelling of it. `known`: the
// servers' own names (the radar's `claude mcp list` rows). The tool-name
// spelling maps back by normalizing both sides. With no known name, a
// claude.ai connector's name is rebuilt (`claude_ai_Google_Workspace_-_Sendbird`
// → `claude.ai Google Workspace - Sendbird`: connector names use spaces where
// the spelling has "_"), and any other name is kept as it is.
export function displayName(server: string, known: readonly string[]): string {
  if (known.includes(server)) return server
  const key = normalizeServer(server)
  const hit = known.find((k) => normalizeServer(k) === key)
  if (hit) return hit
  const m = /^claude_ai_(.+)$/.exec(server)
  return m ? 'claude.ai ' + m[1]!.replace(/_/g, ' ') : server
}

// What `/mcp reconnect` answered. `ok`: reconnected. `unknown`: no server by
// that name here; sending the same name again cannot help. `off`: the server
// is turned off here, or this session cannot reconnect (`claude -p`): left
// alone. `failed`: anything else (it did not come back, or the command threw).
export type ReconnectOutcome = 'ok' | 'unknown' | 'off' | 'failed'
export function reconnectOutcome(text: string): ReconnectOutcome {
  if (/no MCP server named|not found/i.test(text)) return 'unknown'
  if (/\bdisabled\b|aren't available in this session|not available in this session/i.test(text)) return 'off'
  if (/\breconnected\b/i.test(text) && !/not connected|failed|error|\b0 of\b/i.test(text)) return 'ok'
  return 'failed'
}

// One server's retries: a growing gap (1, 2, 4, 8, 16, then every 30
// minutes) in place of three tries 2 minutes apart and then silence. A
// server that is still down after NOTIFY_AFTER tries, or whose name /mcp
// does not know, is reported (the coordinator, the office); retries go on at
// the longest gap, since the server can still come back.
// `at`: the engine's clock (healDue's `now`); `wall`: epoch ms of the first
// failed try, for the office's "since".
export type HealTry = { at: number; n: number; last?: ReconnectOutcome; text?: string; wall?: number }
export const HEAL_GAPS_MS = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000, 30 * 60_000]
export const NOTIFY_AFTER = 3
// About 3.5 hours of tries (1+2+4+8+16 minutes, then 30 apart): past that
// each try is one more transcript row for a server that is not coming back
// on its own. It stays on the card, stuck; 다시 연결 there still runs.
export const HEAL_MAX_TRIES = 11

// `n` 0 with `last` ok: reconnected at `at`. A call failing again within
// the first gap waits it out: the reconnect did not hold, and retrying at
// every turn's end would fill the transcript.
//
// `seen`: the server was live in this session at some point. One never seen
// here (it failed at start, or this session never loads it) gets ONE try:
// live, 2026-11-11, "claude.ai Claude Data" was connected in the radar's
// `claude mcp list` and in some sessions, but other sessions never had it,
// and their `/mcp reconnect claude.ai Claude Data` answered "not found",
// three times each, while $.command.run's text was empty. Those sessions told
// the coordinator it was down. One try still brings back a connector that
// failed its first connect (the coordinator's claude.ai Slack, ECONNRESET);
// past that, the person's /mcp or the office card's 다시 연결 decides.
export function healDue(t: HealTry | undefined, now: number, seen = true): boolean {
  if (!t) return true
  if (!seen && t.n > 0) return false
  if (t.last === 'unknown' || t.last === 'off' || t.n >= HEAL_MAX_TRIES) return false
  return now - t.at >= HEAL_GAPS_MS[Math.min(Math.max(t.n - 1, 0), HEAL_GAPS_MS.length - 1)]!
}

// Whether a server is to be reported as down. `seen`: it was live in this
// session. One this session never had is never reported: nothing here says
// it is this session's (see healDue). One it had and cannot be named is a
// mapping bug: told, so it is not silent again.
export function healStuck(t: HealTry | undefined, seen: boolean): boolean {
  if (!t || !seen || t.last === 'ok' || t.last === 'off') return false
  if (t.last === 'unknown') return true
  return t.n >= NOTIFY_AFTER
}

// Whether a server belongs on the office card and in the coordinator's
// notice: one this session had, tried here and not left alone.
export function healShown(t: HealTry | undefined, seen: boolean): boolean {
  return seen && !!t && t.n > 0 && t.last !== 'ok' && t.last !== 'off'
}

// The servers to reconnect now. `dropped`: seen live in this session, gone.
// `expected`: connected by the radar's own `claude mcp list` (another
// process, so the server works from this machine) yet not in this session.
// That is a server that failed at this session's start (claude.ai Slack,
// ECONNRESET on the first connect, 2026-11-11): never live here, so never
// dropped, so never retried until now. Compared by normalized name; the
// result keeps the first spelling met.
export function healTargets(dropped: readonly string[], expected: readonly string[], live: readonly string[]): string[] {
  const here = new Set(live.map(normalizeServer))
  const out = new Map<string, string>()
  for (const s of [...dropped, ...expected]) {
    const k = normalizeServer(s)
    if (!here.has(k) && !out.has(k)) out.set(k, s)
  }
  return [...out.values()]
}

// The radar's MCP rows: every server's own name, and the connected ones.
export function radarNames(items: readonly { id: string; state: string }[]): { all: string[]; connected: string[] } {
  const mcp = items.filter((i) => i.id.startsWith('mcp:'))
  return { all: mcp.map((i) => i.id.slice(4)), connected: mcp.filter((i) => i.state === 'ok').map((i) => i.id.slice(4)) }
}

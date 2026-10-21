// Keep MCP servers connected. A server that dropped (a proxy reset, a sleep,
// an expired session on the server's side) often comes back on a plain
// reconnect, but Claude Code leaves it disconnected until someone opens /mcp.
// Only a server that was in use and then failed a call is retried, by name
// (`/mcp reconnect <server>`): `reconnect all` also retries every server that
// never connected (needs sign-in, unused) and leaves a transcript row each
// time. Pure: register.ts decides when to run it.

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

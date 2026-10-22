// Logging in to an MCP server from the cockpit, without /mcp. Two kinds:
//
// - A claude.ai connector ("claude.ai X"): authorized on claude.ai itself.
//   `claude mcp login --no-browser` prints the start-auth URL; the session
//   that is running picks the connector up only after a restart.
// - Any other HTTP/SSE server: its `authenticate` tool answers the OAuth URL,
//   Claude Code's localhost callback finishes it, and `complete_authentication`
//   takes a pasted callback URL when the browser could not reach localhost.
//
// Pure: parse and state.

export type McpLogin = {
  server: string // as /mcp lists it: "claude.ai Clay"
  status: 'starting' | 'waiting' | 'done' | 'failed'
  url?: string
  msg?: string
  at: number
  claudeAi?: boolean // a claude.ai connector: no callback to paste
}

export function isClaudeAi(server: string): boolean {
  return /^claude\.ai /.test(server)
}

// The URL `claude mcp login --no-browser` prints, out of its OSC 8 hyperlink.
export function connectorUrl(out: string): string | undefined {
  return /https:\/\/[^\s\x07\x1b\]]+/.exec(out)?.[0]
}

// The first http(s) URL in a tool result's text blocks.
export function authUrl(result: any): string | undefined {
  const text = textOf(result)
  return /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]
}

export function textOf(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}

// `authenticate` is missing because the server is not connected here: the
// login has to run in a terminal (register.ts startTerminalLogin).
export function needsTerminalLogin(err: unknown): boolean {
  return /no connected MCP tool/.test(String(err))
}

// A small pane under `self` running the login with a TTY. --no-browser: the
// URL is opened in the person's own Chrome by the mod (openLoginPage), not by
// whatever `open` picks. The pane closes itself when the login exits.
export function loginSplitArgv(self: string, server: string): string[] {
  return ['split-window', '-v', '-l', '6', '-d', '-P', '-F', '#{pane_id}', '-t', self, 'claude', 'mcp', 'login', '--no-browser', server]
}

// Why `authenticate` could not run. A server that needs login is not connected
// in this session, so its tool is not offered to the mod; `claude mcp login`
// cannot finish without a terminal, so the one way left is /mcp.
export function loginError(err: unknown, server: string): string {
  const text = String(err)
  return /no connected MCP tool/.test(text) ? 'not connected in this session, so it offers no login tool here: run /mcp, pick ' + server + ', then Authenticate' : text
}

// "already authenticated" / "connected": nothing to do.
export function alreadyIn(result: any): boolean {
  return /already (authenticated|connected|authorized)/i.test(textOf(result))
}

// A callback URL the browser landed on: localhost with a code.
export function isCallbackUrl(s: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*[?&]code=/.test(s.trim())
}

export function serverOf(itemId: string): string | undefined {
  return itemId.startsWith('mcp:') ? itemId.slice(4) : undefined
}

// A login that just finished outranks the last `claude mcp list`: that list
// runs at most every 10 minutes, is kept for 30, and can lag a fresh token.
export function markLoggedIn<T extends { id: string; state: string; detail?: string; fix?: unknown }>(items: readonly T[], server: string): T[] {
  return items.map((i) => (serverOf(i.id) === server ? { ...i, state: 'ok', detail: 'logged in', fix: undefined } : i))
}

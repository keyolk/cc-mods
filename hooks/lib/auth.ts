// Credential expiry radar: what is about to stop working, before a command
// fails on it.
//
// Each probe is cheap and reads metadata only. The AWS probe reads `expiresAt`
// from the SSO token cache — the file is named by sha1(start URL) — and never
// the token. gh is checked with `gh auth status`, MCP servers from the
// needs-auth cache Claude Code itself writes, the Claude daemon from its
// status file and log, and ArgoCD from the CLI's token `exp` claims. One radar result is shared by every session through $.store,
// so N sessions do not run N probes.

import { org } from './org'

export type AuthState = 'ok' | 'soon' | 'expired' | 'unknown'

export type AuthItem = {
  id: string
  label: string
  state: AuthState
  expiresAt?: number
  detail?: string
  // The command a person runs to fix it. Shown on a button; never run by Claude.
  fix?: string[]
  // A second way out, drawn as its own button (AWS: the access portal, where
  // signing out ends the session a login would otherwise reuse).
  alt?: { label: string; argv: string[] }
  // An MCP server the person set up (user or project scope), not one of the
  // org's claude.ai connectors: listed first, never folded.
  mine?: boolean
}

// `claude mcp list`: "name: target - ✔ Connected" / "! Needs authentication" /
// "✗ Failed to connect", one per line. The authority on a server's state: the
// needs-auth cache keeps a server until Claude Code restarts (gestalt sat in
// it while connected). A name without the "claude.ai " prefix is one the
// person configured.
export function parseMcpList(text: string): AuthItem[] {
  const out: AuthItem[] = []
  for (const line of text.split('\n')) {
    const m = /^(.+?): .* - (✔ Connected|! Needs authentication|✗ .+)$/.exec(line.trim())
    if (!m) continue
    const name = m[1]!
    const mine = !name.startsWith('claude.ai ')
    const st = m[2]!
    const state: AuthState = st.startsWith('✔') ? 'ok' : st.startsWith('!') ? (mine ? 'expired' : 'unknown') : mine ? 'expired' : 'unknown'
    out.push({
      id: 'mcp:' + name,
      label: 'MCP ' + name.replace(/^claude\.ai /, ''),
      state,
      detail: st.startsWith('✔') ? 'connected' : st.startsWith('!') ? 'needs auth' : st.replace(/^✗\s*/, '').toLowerCase(),
      fix: st.startsWith('✔') ? undefined : ['/mcp'],
      ...(mine ? { mine } : {}),
    })
  }
  return out
}

// `aws sso login` during a live access-portal session reuses that session: the
// new token expires when the old one did (IAM Identity Center docs, "Session
// duration considerations"). Seen live: a login at 02:19 left 17:45Z in place.
// The expiry moves only after the portal session ends, by its own clock or by
// signing out at the portal. So a login that leaves the expiry where it was
// says so, instead of looking like it did nothing.
export function awsLoginReused(before: number | undefined, after: number | undefined): boolean {
  return before !== undefined && after !== undefined && Math.abs(after - before) < 60_000
}

export function awsReusedItem(item: AuthItem, startUrl: string, endsAt: string): AuthItem {
  return {
    ...item,
    detail: 'login reused the portal session, which ends ' + endsAt + ' · sign out at the portal, then log in, for a new one',
    alt: { label: 'portal', argv: ['open', startUrl] },
  }
}

export type Radar = { at: number; items: AuthItem[] }

export const SOON_MS = 30 * 60_000

export function stateFor(expiresAt: number | undefined, now: number): AuthState {
  if (!expiresAt || Number.isNaN(expiresAt)) return 'unknown'
  if (expiresAt <= now) return 'expired'
  if (expiresAt - now <= SOON_MS) return 'soon'
  return 'ok'
}

// The first profile in ~/.aws/config that logs in through `startUrl`, either
// directly (sso_start_url) or through an [sso-session] block. `aws sso login`
// has no flag that takes the start URL itself, so the fix names a profile.
export function ssoProfile(configText: string | undefined, startUrl: string): string | undefined {
  if (!configText) return undefined
  const sections = new Map<string, Record<string, string>>()
  let cur: Record<string, string> | undefined
  for (const line of configText.split('\n')) {
    const head = line.match(/^\s*\[([^\]]+)\]/)
    if (head) {
      cur = {}
      sections.set(head[1]!.trim(), cur)
      continue
    }
    const kv = line.match(/^\s*([\w-]+)\s*=\s*(.*?)\s*$/)
    if (kv && cur) cur[kv[1]!] = kv[2]!
  }
  const norm = (u: string | undefined) => (u ?? '').replace(/\/+$/, '').replace(/#.*$/, '')
  for (const [name, kv] of sections) {
    const m = name.match(/^profile\s+(.+)$/) ?? (name === 'default' ? [name, 'default'] : null)
    if (!m) continue
    const url = kv.sso_session ? sections.get('sso-session ' + kv.sso_session)?.sso_start_url : kv.sso_start_url
    if (norm(url) === norm(startUrl)) return m[1]!.trim()
  }
  return undefined
}

export function awsItem(cacheJson: string | undefined, startUrl: string, now: number, profile?: string): AuthItem {
  let exp: number | undefined
  try {
    const raw = cacheJson ? JSON.parse(cacheJson) : undefined
    if (raw?.expiresAt) exp = Date.parse(raw.expiresAt)
  } catch {
    exp = undefined
  }
  return {
    id: 'aws-sso',
    label: 'AWS SSO',
    state: cacheJson === undefined ? 'expired' : stateFor(exp, now),
    expiresAt: exp,
    detail: startUrl.replace(/^https:\/\//, '').replace(/\/start$/, ''),
    // A press asks for a new session: sign out first. `aws sso logout` ends the
    // server-side Identity Center session, so the login that follows starts a
    // new one with its own full length; a login alone during a live session
    // reuses it and keeps its end (see awsLoginReused).
    fix: profile ? ['sh', '-c', 'aws sso logout --profile "$0"; aws sso login --profile "$0"', profile] : undefined,
  }
}

// `gh auth status` lists each account; a line with "X" or "Failed" means a
// token gh can no longer use.
export function ghItems(statusText: string): AuthItem[] {
  const items: AuthItem[] = []
  const re = /(✓|X|✗)\s+Logged in to github\.com account (\S+)|Failed to log in to github\.com account (\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(statusText))) {
    const user = m[2] ?? m[3]
    const ok = m[1] === '✓'
    items.push({
      id: 'gh:' + user,
      label: 'gh ' + user,
      state: ok ? 'ok' : 'expired',
      fix: ['gh', 'auth', 'login', '--hostname', 'github.com'],
    })
  }
  const active = /account (\S+)[^\n]*\n\s*- Active account: true/.exec(statusText)?.[1]
  return items.map((i) => (active && i.id === 'gh:' + active ? { ...i, detail: 'active' } : i))
}

export function mcpItems(cacheJson: string | undefined): AuthItem[] {
  let raw: Record<string, unknown> = {}
  try {
    raw = cacheJson ? JSON.parse(cacheJson) : {}
  } catch {
    raw = {}
  }
  return Object.keys(raw).map((name) => ({
    id: 'mcp:' + name,
    label: 'MCP ' + name.replace(/^claude\.ai /, ''),
    // Informational, not a failure: Claude Code lists every connector the org
    // offers here, used or not, so counting them kept the band red forever
    // (live: Model Council, Trumpet, Profound, Sentry — none in use).
    state: 'unknown' as const,
    detail: 'needs auth',
    fix: ['/mcp'], // runFix logs in from the cockpit (lib/mcpauth.ts)
  }))
}

// The status file is written when the daemon hits auth_required and is not
// rewritten when auth recovers, so on its own it stays red forever (live: a
// file from 10/12 05:36 while every later supervisor line said the token was
// valid). The supervisor's own auth lines in daemon.log are the newer word:
// one after `since` that is not a failure means the file is stale.
const AUTH_LINE = /^\[([^\]]+)\] \[supervisor\] auth: (.*)$/

export function daemonItem(statusJson: string | undefined, logText = ''): AuthItem | undefined {
  let raw: { status?: string; since?: number } | undefined
  try {
    raw = statusJson ? JSON.parse(statusJson) : undefined
  } catch {
    return undefined
  }
  if (!raw?.status) return undefined
  const base = { id: 'daemon', label: 'Claude daemon', fix: ['claude', 'auth', 'login'] }
  if (raw.status !== 'auth_required') return { ...base, state: 'ok', detail: raw.status }
  let last: { at: number; msg: string } | undefined
  for (const line of logText.split('\n').slice(-400)) {
    const m = AUTH_LINE.exec(line)
    if (m) last = { at: Date.parse(m[1]!), msg: m[2]! }
  }
  const since = typeof raw.since === 'number' ? raw.since : 0
  const failed = (msg: string) => /fail|required|invalid|expired/i.test(msg) && !/token still valid/i.test(msg)
  if (last && last.at > since && !failed(last.msg)) {
    return { ...base, state: 'ok', detail: 'auth ok; stale auth_required from ' + new Date(since).toISOString().slice(0, 16).replace('T', ' ') }
  }
  return { ...base, state: 'expired', detail: 'auth_required' }
}

// ArgoCD CLI logins (~/.config/argocd/config). Each SSO user holds a dex ID
// token; only its `exp` claim is decoded, and nothing of the token leaves
// this function. A login expired for over a week is an instance not in use
// (live: argocd-kb, expired since January), so it is listed but, like an
// unused MCP connector, does not turn the band red.
export const STALE_LOGIN_MS = 7 * 86_400_000

export function argocdItems(configYaml: string | undefined, now: number): AuthItem[] {
  if (!configYaml) return []
  const users = configYaml.split(/^users:\s*$/m)[1] ?? ''
  const items: AuthItem[] = []
  for (const block of users.split(/^- /m).slice(1)) {
    const name = /^\s*name:\s*(\S+)/m.exec(block)?.[1]
    const token = /^\s*auth-token:\s*(\S+)/m.exec(block)?.[1]
    if (!name || !token) continue
    const exp = jwtExp(token)
    const st = stateFor(exp, now)
    const stale = st === 'expired' && exp !== undefined && now - exp > STALE_LOGIN_MS
    items.push({
      id: 'argocd:' + name,
      label: 'ArgoCD ' + argocdLabel(name),
      state: stale ? 'unknown' : st,
      expiresAt: exp,
      detail: stale ? 'expired ' + new Date(exp!).toISOString().slice(0, 10) + ' · unused?' : name,
      fix: ['argocd', 'login', name, '--sso', '--grpc-web'],
    })
  }
  return items
}

function jwtExp(token: string): number | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const exp = JSON.parse(base64url(part))?.exp
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

// The module runs without Node or a DOM, so no Buffer and no promised atob.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function base64url(s: string): string {
  let bits = 0
  let acc = 0
  let out = ''
  for (const ch of s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new Error('bad base64')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 0xff)
    }
  }
  // Bytes as Latin-1: only the ASCII `exp` claim is read, so a non-ASCII name
  // claim mangling does not matter.
  return out
}

// ccproxy accounts, from `ccproxy status --offline --json` (ccproxy 47476f3+).
// Offline on purpose: the radar runs every few minutes in every session, and
// a live probe is an upstream call per account. Offline numbers are the last
// ones real traffic or a manual `ccproxy status` saw, and are marked so.
//
// State follows ccproxy's own bucket. Remaining quota is detail, not state: a
// weekly window at 7% can sit there for days, and a band that stays yellow
// that long stops being read (the MCP lesson above). Only an account that
// cannot serve now (cooldown, exhausted) is `soon`; a broken one is expired.
export function ccproxyItems(json: string | undefined): AuthItem[] {
  let raw: any
  try {
    raw = json ? JSON.parse(json) : undefined
  } catch {
    return []
  }
  if (!Array.isArray(raw?.accounts)) return []
  const pct = (w: any) => (typeof w?.left_pct === 'number' ? Math.round(w.left_pct) + '%' : '?')
  return raw.accounts.map((a: any): AuthItem => {
    const b = a.budget ?? {}
    const quota =
      b.kind === 'windows'
        ? '5h ' + pct(b.five_hour) + ' · 7d ' + pct(b.seven_day) + ' left'
        : b.kind === 'pool'
          ? (b.pool_name ? b.pool_name + ' ' : '') + 'pool ' + pct(b.pool) + ' left'
          : b.kind === 'spend_cap'
            ? b.capped ? 'spend cap hit' : 'not capped'
            : b.kind === 'requests'
              ? b.requests_remaining + '/' + b.requests_limit + ' req'
              : (b.reason ?? 'no usage API')
    const stale = a.stale_quota && (b.kind === 'windows' || b.kind === 'pool') ? ' (last known)' : ''
    const st: AuthState =
      a.state === 'expired' || a.state === 'auth-failed' ? 'expired' : a.state === 'cooldown' ? 'soon' : a.state === 'disabled' ? 'unknown' : 'ok'
    const why = a.state === 'ready' ? quota + stale : a.state + (a.cooldown ? ' · ' + a.cooldown : '') + ' · ' + quota + stale
    return { id: 'ccproxy:' + a.name, label: 'ccproxy ' + a.name, state: st, detail: why }
  })
}

export function worst(items: readonly AuthItem[]): AuthState {
  if (items.some((i) => i.state === 'expired')) return 'expired'
  if (items.some((i) => i.state === 'soon')) return 'soon'
  return 'ok'
}

// An ArgoCD server's label: its host with a configured domain suffix
// replaced by that domain's label (org.json's argocdDomains), so the main
// one reads as its short name and others say which they are.
export function argocdLabel(host: string): string {
  for (const [domain, label] of Object.entries(org().argocdDomains)) {
    if (host.endsWith('.' + domain)) return host.slice(0, -domain.length - 1) + label
  }
  return host
}

// Which credential a Bash command depends on, so tool.call can stop it before
// it fails. Only the probes this module can actually check are mapped.
export function credentialFor(command: string): string | undefined {
  const sso = org().awsSsoProfiles
  const profile = /\baws\b[^|;&]*--profile[ =](\S+)/.exec(command)?.[1]
  if (profile && sso.some((p) => profile.startsWith(p))) return 'aws-sso'
  if (/\bkubectl\b[^|;&]*--context[ =]/.test(command)) return 'aws-sso'
  return undefined
}

export const ICON: Record<AuthState, string> = { ok: '✓', soon: '⏳', expired: '✗', unknown: '?' }

// sha1 of a string as hex: the AWS CLI names a start URL's SSO token cache
// file <sha1(url)>.json. The mod runtime has no crypto module, and this runs
// once per session on a short string.
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const len = bytes.length
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16)
  for (let i = 0; i < len; i++) words[i >> 2]! |= bytes[i]! << (24 - (i % 4) * 8)
  words[len >> 2]! |= 0x80 << (24 - (len % 4) * 8)
  words[words.length - 1] = len * 8
  let [a, b, c, d, e] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Uint32Array(80)
  const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[i + t]! : rol(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1)
    let [A, B, C, D, E] = [a, b, c, d, e]
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (B & C) | (~B & D) : t < 40 ? B ^ C ^ D : t < 60 ? (B & C) | (B & D) | (C & D) : B ^ C ^ D
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const tmp = (rol(A, 5) + f + E + k + w[t]!) >>> 0
      E = D
      D = C
      C = rol(B, 30) >>> 0
      B = A
      A = tmp
    }
    a = (a + A) >>> 0
    b = (b + B) >>> 0
    c = (c + C) >>> 0
    d = (d + D) >>> 0
    e = (e + E) >>> 0
  }
  return [a, b, c, d, e].map((x) => x.toString(16).padStart(8, '0')).join('')
}

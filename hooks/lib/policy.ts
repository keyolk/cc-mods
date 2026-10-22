// Session policy as the mod sees it.
//
// The source of truth stays ~/.claude/state/session_policy/<sid>.json, written
// by ~/.claude/hooks/session_policy.py. The mod reads that file to draw the
// policy and changes it only by running the same CLI with the session id in
// the environment, so the scope normalization, modes and the settings-hook
// guard keep a single implementation.
//
// What the mod adds is *who* may change it: only a person, through /policy or
// a pane button. A Bash call from Claude that runs session_policy.py with a
// mutating verb is refused in tool.call (see isSelfGrant) — before this mod,
// the guard's own deny message told Claude the exact command that lifts it.

import { org } from './org'

export const CAPS = ['gh_merge', 'prod_eks_access', 'prod_eks_write', 'slack_send', 'auto_continue', 'auto_effort', 'auto_model', 'tmux_window_escape'] as const
export type Cap = (typeof CAPS)[number]
export type CapValue = 'allow' | 'block' | 'inherit'

export const DEFAULTS: Record<Cap, CapValue> = {
  gh_merge: 'block',
  prod_eks_access: 'inherit',
  prod_eks_write: 'inherit',
  auto_continue: 'inherit',
  auto_effort: 'inherit',
  auto_model: 'inherit',
  tmux_window_escape: 'block',
  slack_send: 'inherit',
}

export const MODES = ['default', 'locked', 'autopilot', 'pr-merge', 'prod-readonly', 'prod-write', 'rca', 'release'] as const

export const SCOPE_KEYS: Partial<Record<Cap, string>> = {
  gh_merge: 'gh_merge_repos',
  prod_eks_access: 'prod_eks_access_ctxs',
  prod_eks_write: 'prod_eks_write_scopes',
  slack_send: 'slack_send_targets',
}

// Slack targets every session may send to without asking (org.json's
// slack.defaultTargets). session_policy.py, which enforces it, keeps its
// own list: the two must name the same channels.
export function slackDefaultTargets(): Record<string, string> {
  return org().slack.defaultTargets
}

export type Policy = {
  mode: string
  caps: Record<Cap, CapValue>
  explicit: Partial<Record<Cap, CapValue>>
  scopes: Partial<Record<Cap, string[]>>
}

export function parsePolicy(json: string | undefined): Policy {
  let raw: any = {}
  try {
    raw = json ? JSON.parse(json) : {}
  } catch {
    raw = {}
  }
  const explicit = (raw.capabilities ?? {}) as Partial<Record<Cap, CapValue>>
  const caps = { ...DEFAULTS }
  for (const c of CAPS) if (explicit[c]) caps[c] = explicit[c] as CapValue
  const scopes: Partial<Record<Cap, string[]>> = {}
  for (const c of CAPS) {
    const k = SCOPE_KEYS[c]
    if (k && Array.isArray(raw[k]) && raw[k].length) scopes[c] = raw[k]
  }
  return { mode: raw.mode ?? 'custom', caps, explicit, scopes }
}

const SHORT: Record<Cap, string> = {
  gh_merge: 'merge',
  prod_eks_access: 'prod',
  prod_eks_write: 'prod-w',
  auto_continue: 'auto',
  auto_effort: 'effort',
  auto_model: 'model',
  tmux_window_escape: 'tmux',
  slack_send: 'slack',
}

// One compact label for the footer, e.g. "merge🔒 prod:ro tmux🔒 auto▶".
export function badge(p: Policy): string {
  const parts: string[] = []
  const v = p.caps
  parts.push(v.gh_merge === 'allow' ? 'merge🔓' : p.scopes.gh_merge ? 'merge(' + p.scopes.gh_merge.length + ')' : 'merge🔒')
  if (v.prod_eks_write === 'allow') parts.push('prod:rw')
  else if (v.prod_eks_access === 'allow') parts.push('prod:ro')
  else if (v.prod_eks_access === 'block') parts.push('prod🔒')
  else if (p.scopes.prod_eks_access || p.scopes.prod_eks_write) parts.push('prod(scoped)')
  if (v.slack_send === 'allow') parts.push('slack🔓')
  else if (p.scopes.slack_send) parts.push('slack(' + p.scopes.slack_send.length + ')')
  if (v.tmux_window_escape === 'allow') parts.push('tmux🔓')
  if (v.auto_continue === 'allow') parts.push('auto▶')
  if (v.auto_effort === 'allow') parts.push(v.auto_model === 'allow' ? 'route⚙+m' : 'route⚙')
  return parts.join(' ')
}

export function shortName(c: Cap): string {
  return SHORT[c]
}

// argv for session_policy.py for a person's /policy arguments, or an error.
// Accepted: show | mode <m> | clear | allow|block|inherit <cap> [scope] [ttl]
export type PolicyCommand = { argv: string[]; ttlMs?: number; revert?: string[] } | { error: string }

export function parsePolicyArgs(args: string): PolicyCommand {
  const w = args.trim().split(/\s+/).filter(Boolean)
  if (w.length === 0 || w[0] === 'show') return { argv: ['show'] }
  const [verb, a, b, c] = w
  if (verb === 'clear') return { argv: ['clear'] }
  if (verb === 'mode') {
    if (!a || !(MODES as readonly string[]).includes(a)) return { error: 'mode: one of ' + MODES.join(', ') }
    return { argv: ['mode', a] }
  }
  if (verb === 'allow' || verb === 'block' || verb === 'inherit') {
    const cap = resolveCap(a)
    if (!cap) return { error: verb + ': capability is one of ' + CAPS.join(', ') }
    let scope: string | undefined
    let ttlMs: number | undefined
    for (const x of [b, c]) {
      if (!x) continue
      const t = parseTtl(x)
      if (t) ttlMs = t
      else scope = x
    }
    const argv = [verb, cap]
    if (scope) argv.push(cap === 'gh_merge' ? '--repo' : '--scope', scope)
    // A timed grant reverts to `inherit` for the same target when it expires.
    const revert = ttlMs && verb === 'allow' ? (scope ? ['inherit', cap, cap === 'gh_merge' ? '--repo' : '--scope', scope] : ['inherit', cap]) : undefined
    return { argv, ttlMs, revert }
  }
  return { error: 'usage: /policy [show | mode <m> | clear | allow|block|inherit <cap> [scope] [15m]]' }
}

export function resolveCap(s: string | undefined): Cap | undefined {
  if (!s) return undefined
  if ((CAPS as readonly string[]).includes(s)) return s as Cap
  const byShort = CAPS.find((c) => SHORT[c] === s)
  return byShort
}

export function parseTtl(s: string): number | undefined {
  const m = /^(\d+)(s|m|h)$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000)
}

// True when a Bash command would change session policy (or another guard's
// unlock) from Claude's side. Reads (`show`, `--status`) stay allowed.
//
// Same rule as ~/.claude/hooks/session_policy.py's is_self_grant (keep them in
// step; tests on both sides pin the same cases): match an invocation in
// command position, after dropping heredoc bodies that do not feed a shell, so
// a heredoc or echo that merely *mentions* the command is not refused.
const CMD_POS = String.raw`(?:^|[;&|(\x60]|\b(?:bash|sh|zsh|fish)\s+-c\s+['"]?)\s*(?:exec\s+)?(?:\w+=\S+\s+)*(?:python3?\s+)?\S*`
const POLICY_RE = new RegExp(CMD_POS + String.raw`session_policy\.py\s+(?:allow|block|inherit|mode|clear)\b`, 'm')
const UNLOCK_RE = new RegExp(CMD_POS + String.raw`((?:secret_read|kubectl_prod|ecr_push)_unlock\.py)\b(?![^;&|\n]*--(?:status|revoke))`, 'm')
const HEREDOC_RE = /^([^\n]*?)<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?^\s*\2\s*$/gm

export function executedText(command: string): string {
  return command.replace(HEREDOC_RE, (whole, cmd: string) => (/\b(bash|sh|zsh|fish)\b\s*(-s)?\s*$/.test(cmd.split('<<')[0] ?? '') ? whole : cmd))
}

export function isSelfGrant(command: string): string | undefined {
  const text = executedText(command)
  if (POLICY_RE.test(text)) return 'session_policy.py'
  return UNLOCK_RE.exec(text)?.[1]
}

// Scopes this session is likely to need, so the person grants one with a
// press instead of typing `owner/repo` or `ctx/ns`. Sources, most useful first:
// what the policy guard just blocked (its message names the exact scope), the
// prod kubectl targets and merge repos in this session's commands, the repos
// of this session's PRs, and the working directory's repo.
export type ScopeHint = { cap: Cap; scope: string; why: 'blocked' | 'used' | 'pr' | 'thread' | 'cwd' | 'known' }

const HINT_CAP: Record<string, Cap> = { merge: 'gh_merge', prod: 'prod_eks_access', 'prod-w': 'prod_eks_write', slack: 'slack_send' }

// The guard's deny names the grant it would take: "/policy allow prod-w ctx/ns 15m".
export function hintsFromBlock(text: string): ScopeHint[] {
  const out: ScopeHint[] = []
  for (const m of text.matchAll(/\/policy allow (merge|prod-w|prod|slack) ([^\s`'")]+)/g)) {
    if (m[2] === 'owner/repo') continue
    out.push({ cap: HINT_CAP[m[1]!]!, scope: m[2]!, why: 'blocked' })
  }
  return out
}

// Mirrors session_policy.py: a prod context has "-prod-" or ends "-prod" and is
// not preprod/nonprod; its scope is ctx or ctx/ns.
export function isProdContext(ctx: string): boolean {
  const c = ctx.toLowerCase()
  if (['preprod', 'prerelease', 'nonprod', 'non-prod'].some((x) => c.includes(x))) return false
  return c.includes('-prod-') || c.endsWith('-prod')
}

export function hintsFromCommand(command: string, repoFromGh: (c: string) => string | undefined): ScopeHint[] {
  const out: ScopeHint[] = []
  if (/(^|\s|;|&&|\|\|)(rtk\s+)?kubectl\s/.test(command)) {
    const ns = /(?:-n|--namespace)(?:=|\s+)([^\s]+)/.exec(command)?.[1]?.replace(/['"]/g, '')
    for (const m of command.matchAll(/--context(?:=|\s+)([^\s]+)/g)) {
      const ctx = m[1]!.replace(/['"]/g, '')
      if (!isProdContext(ctx)) continue
      const scope = ns ? ctx + '/' + ns : ctx
      out.push({ cap: 'prod_eks_access', scope, why: 'used' }, { cap: 'prod_eks_write', scope, why: 'used' })
    }
  }
  if (/\bgh\s+pr\s+merge\b/.test(command)) {
    const r = repoFromGh(command)
    if (r) out.push({ cap: 'gh_merge', scope: r, why: 'used' })
  }
  return out
}

const WHY_RANK = { blocked: 0, used: 1, pr: 2, thread: 2, cwd: 3, known: 4 } as const

// Dedupe by cap+scope keeping the best reason, drop what the policy already
// allows (globally or by that exact scope), newest first within a reason.
export function scopeHints(hints: readonly ScopeHint[], policy: Policy, limit = 80): ScopeHint[] {
  const best = new Map<string, { h: ScopeHint; i: number }>()
  hints.forEach((h, i) => {
    const key = h.cap + ' ' + h.scope.toLowerCase()
    const cur = best.get(key)
    if (!cur || WHY_RANK[h.why] < WHY_RANK[cur.h.why] || (WHY_RANK[h.why] === WHY_RANK[cur.h.why] && i > cur.i)) best.set(key, { h, i })
  })
  return [...best.values()]
    .filter(({ h }) => policy.caps[h.cap] !== 'allow' && !(h.cap === 'slack_send' && slackDefaultTargets()[h.scope.toUpperCase()]) && !(policy.scopes[h.cap] ?? []).some((s) => s.toLowerCase() === h.scope.toLowerCase()))
    .sort((a, b) => WHY_RANK[a.h.why] - WHY_RANK[b.h.why] || b.i - a.i)
    .slice(0, limit)
    .map(({ h }) => h)
}

// The capabilities that hold a list of allowed targets, in the order the
// Policy tab draws them, and what a target looks like for each.
export const SCOPED: readonly { cap: Cap; example: string }[] = [
  { cap: 'gh_merge', example: 'owner/repo' },
  { cap: 'prod_eks_access', example: 'ctx[/ns]' },
  { cap: 'prod_eks_write', example: 'ctx[/ns]' },
  { cap: 'slack_send', example: '#channel or @person' },
]

// What `slack <x>` names: an id passes as is; a #channel or @person needs a
// lookup (register.ts asks the Slack MCP server).
export function slackTargetKind(s: string): 'id' | 'channel' | 'person' | undefined {
  // An id has a digit: `general` is a word, `C0123ABCD45` an id.
  if (/^[CDGU](?=[A-Z]*\d)[A-Z0-9]{6,}$/i.test(s)) return 'id'
  if (/^#[\w.-]+$/.test(s)) return 'channel'
  if (/^@.+/.test(s)) return 'person'
  return undefined
}

// "1. #team-pr-review (C0123ABCD45) - private_channel - …"
export function parseChannelSearch(text: string, name: string): string | undefined {
  const want = name.replace(/^#/, '').toLowerCase()
  for (const m of text.matchAll(/#([\w.-]+) \(([CG][A-Z0-9]+)\)/g)) if (m[1]!.toLowerCase() === want) return m[2]
  return undefined
}

// "1. Jane Doe - U0123ABCD45 - jane@example.com": the first match, with its name.
export function parseUserSearch(text: string): { id: string; name: string } | undefined {
  const m = /^\d+\. (.+?) - (U[A-Z0-9]+)/m.exec(text)
  return m ? { id: m[2]!, name: m[1]! } : undefined
}

// God mode: every capability allowed at once, from one press of the person's
// (the Policy tab, the palette). Never a mode in session_policy.py: it is the
// same per-capability `allow` calls a person could make row by row, so the
// guards and their audit stay as they are. It always ends: GOD_MS after the
// press, or on the same button, the policy from before is put back.
export const GOD_MS = 30 * 60_000
export const GOD_MINUTES = [15, 30, 60] as const

export function godArgvs(): string[][] {
  return CAPS.map((cap) => ['allow', cap])
}

// On while every capability is allowed outright.
export function isGod(p: Pick<Policy, 'caps'>): boolean {
  return CAPS.every((cap) => p.caps[cap] === 'allow')
}

// Calls a session-policy guard refused, and when a later policy lets them
// through. The person grants with /policy (or the Policy tab); this is what
// lets the stalled work go on without them also typing "try again".

import { type Cap, type Policy } from './policy'

export type Blocked = {
  cap: Cap
  scope?: string // the target the guard named (repo, ctx[/ns], channel id)
  scopesAtBlock: number // how many scoped grants the cap had when it was refused
  what: string // the refused call, short: the command or the tool and target
  at: number
  turnId: string
  // Recorded from a guard's deny (the only source since 30e3dd0). Entries
  // without it came from older code that read any output quoting a block
  // message, and outlive a reload in $.state: they are dropped, not resumed.
  fromDeny?: true
}

// Blocks older than this are history: the work has moved on.
export const BLOCK_TTL_MS = 2 * 60 * 60_000

const CAP_OF: Record<string, Cap> = { gh_merge: 'gh_merge', prod_eks_access: 'prod_eks_access', prod_eks_write: 'prod_eks_write', slack_send: 'slack_send' }

// "BLOCKED by session policy: gh_merge is not allowed" / "...: prod_eks_write=block."
// The self-grant refusal ("only the user may change session policy") names
// no capability and is not a block a grant should resume.
export function blockOf(text: string, policy: Policy | null, what: string, turnId: string, at: number): Blocked | undefined {
  const m = /BLOCKED by session policy: (gh_merge|prod_eks_access|prod_eks_write|slack_send)\b/.exec(text)
  if (!m) return undefined
  const cap = CAP_OF[m[1]!]!
  const hint = /\/policy allow (?:merge|prod-w|prod|slack) ([^\s`'")\\]+)/.exec(text)?.[1]
  const scope = hint && hint !== 'owner/repo' ? hint : undefined
  return { cap, scope, scopesAtBlock: (policy?.scopes[cap] ?? []).length, what, at, turnId, fromDeny: true }
}

// Would the guard let it through now? A named target: the cap allowed, or that
// target in its list. No target (a merge whose repo the guard could not tell):
// the cap allowed, or a target added to the list since.
export function nowAllowed(b: Blocked, p: Policy): boolean {
  if (p.caps[b.cap] === 'allow') return true
  const scopes = p.scopes[b.cap] ?? []
  if (b.scope) {
    const s = b.scope.toLowerCase()
    // prod scopes are ctx or ctx/ns: a ctx grant covers its namespaces.
    return scopes.some((x) => x.toLowerCase() === s || (b.cap.startsWith('prod_') && s.startsWith(x.toLowerCase() + '/')))
  }
  return scopes.length > b.scopesAtBlock
}

export function grantLabel(b: Blocked): string {
  return b.cap + (b.scope ? ' ' + b.scope : '')
}

// The prompt that picks the work back up: what is allowed now and the call
// that was refused, to run again from that step.
export function resumePrompt(bs: readonly Blocked[]): string {
  const lines = bs.map((b) => '- ' + grantLabel(b) + ': `' + b.what + '`')
  return (
    '세션 정책이 바뀌어, 앞서 막혔던 작업이 이제 허용됩니다.\n' +
    lines.join('\n') +
    '\n막혔던 그 단계부터 이어서 진행하세요. 이미 다른 방법으로 끝냈다면 확인만 하고 넘어가세요.'
  )
}

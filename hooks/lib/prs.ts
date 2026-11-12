// Pull request state for the PR band and the outputs pane.
//
// One GraphQL query per poll fetches every tracked PR at once (checks, review
// decision, unresolved threads, mergeability), instead of the per-PR
// `gh pr view` / `gh pr checks` calls that showed up ~1,300 times in a month
// of transcripts. The result lands in $.store so every session shares it.

import { ghAccountFor } from './org'
import { iacDetail, iacKind, iacLine, iacState, parseArgoDiff, parseCodex, type IacState } from './iac'

export type PrRef = { repo: string; number: number }

export type PrStatus = {
  key: string // owner/repo#123
  url: string
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  checks: 'pass' | 'fail' | 'pending' | 'none'
  review: string // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  approvals: number
  unresolved: number
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  mergeState: string // CLEAN | BLOCKED | BEHIND | UNSTABLE | ...
  failing?: string[] // names of the checks that failed, policy check excluded
  policy?: 'fail' | 'pass' | 'pending' // atlantis/policy_check, for *-nest PRs
  iac?: IacState // plan/apply/window (atlantis) or argodiff/codex (gitops), lib/iac.ts
  head?: string // head commit, to know when the gitops comments need a re-read
  at: number
}

export function parsePrKey(key: string): PrRef | undefined {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key)
  return m && m[1] ? { repo: m[1], number: Number(m[2]) } : undefined
}

export function graphqlQuery(refs: readonly PrRef[]): string {
  const parts = refs.map((r, i) => {
    const [owner, name] = r.repo.split('/')
    return (
      `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
      ` pullRequest(number: ${r.number}) { url title state isDraft mergeable mergeStateStatus reviewDecision headRefOid labels(first: 20) { nodes { name } }` +
      // Comment bodies are not fetched here: one ArgoDiff comment carries a
      // whole diff (779 KB on one infra PR), and a batch past the 4 MiB
      // process output cap stops every PR's update. gitopsComments() reads
      // the few lines that matter, separately.
      (iacKind(r.repo) ? ` files(first: 80) { nodes { path } }` : '') +
      ` reviews(states: APPROVED, first: 20) { totalCount }` +
      ` reviewThreads(first: 100) { nodes { isResolved } }` +
      ` commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 80) { nodes {` +
      ` ... on StatusContext { context state description } ... on CheckRun { name status conclusion } } } } } } } } }`
    )
  })
  return 'query { ' + parts.join(' ') + ' }'
}

export function parseGraphql(json: string, refs: readonly PrRef[], now: number): PrStatus[] {
  let data: any
  try {
    data = JSON.parse(json)?.data
  } catch {
    return []
  }
  if (!data) return []
  const out: PrStatus[] = []
  refs.forEach((r, i) => {
    const pr = data['p' + i]?.pullRequest
    if (!pr) return
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup
    const verdict = checkVerdict(rollup?.contexts?.nodes, rollup?.state)
    out.push({
      key: r.repo + '#' + r.number,
      url: pr.url,
      title: pr.title,
      state: pr.state,
      isDraft: !!pr.isDraft,
      checks: verdict.checks,
      failing: verdict.failing,
      policy: verdict.policy,
      iac: iacState(r.repo, pr),
      head: pr.headRefOid ?? undefined,
      review: pr.reviewDecision ?? '',
      approvals: pr.reviews?.totalCount ?? 0,
      unresolved: (pr.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length,
      mergeable: pr.mergeable ?? 'UNKNOWN',
      mergeState: pr.mergeStateStatus ?? '',
      at: now,
    })
  })
  return out
}

// The rollup alone misreads infra PRs: a CANCELLED run (SOC2 is cancelled on
// every PR of one infra repo) makes it FAILURE while nothing failed, and a failed
// atlantis/policy_check is not a broken change but a wait for
// `atlantis approve_policies`. So the verdict comes from the contexts:
// cancelled, skipped and neutral runs count for nothing, the policy check is
// its own field, and the rollup is the fallback when no contexts came back.
const POLICY_CHECK = 'atlantis/policy_check'

export function checkVerdict(contexts: any[] | undefined, rollup?: string): { checks: PrStatus['checks']; failing: string[]; policy?: PrStatus['policy'] } {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    const checks: PrStatus['checks'] = rollup === 'SUCCESS' ? 'pass' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'fail' : rollup ? 'pending' : 'none'
    return { checks, failing: [] }
  }
  const failing: string[] = []
  let pending = false
  let counted = 0
  let policy: PrStatus['policy']
  for (const c of contexts) {
    const name = String(c?.context ?? c?.name ?? '')
    // A status context has `state`; a check run has `status` and, once
    // completed, `conclusion`.
    const raw = String(c?.state ?? (c?.status === 'COMPLETED' ? c?.conclusion : c?.status) ?? '')
    const result = /^(FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/.test(raw)
      ? 'fail'
      : /^(SUCCESS)$/.test(raw)
        ? 'pass'
        : /^(CANCELLED|SKIPPED|NEUTRAL|STALE)$/.test(raw)
          ? 'none'
          : 'pending'
    if (name === POLICY_CHECK) {
      policy = result === 'none' ? policy : result
      continue
    }
    if (result === 'none') continue
    counted++
    if (result === 'fail') failing.push(name)
    else if (result === 'pending') pending = true
  }
  const checks: PrStatus['checks'] = failing.length ? 'fail' : pending ? 'pending' : counted ? 'pass' : 'none'
  return { checks, failing, policy }
}

// Maintenance windows by sbregion (a region file (org.json regionFiles)), set by
// register.ts once it has read the file.
let iacWindows: Record<string, import('./iac').SyncWindow> = {}
export function setIacWindows(w: Record<string, import('./iac').SyncWindow>): void {
  iacWindows = w
}
export function prIacDetail(s: PrStatus): string[] {
  return s.iac ? iacDetail(s.iac, iacWindows, Date.now()) : []
}

export function prLine(s: PrStatus): string {
  if (s.state === 'MERGED') return '✅ merged'
  if (s.state === 'CLOSED') return '⨯ closed'
  const bits: string[] = []
  const failed = s.failing?.length ? ': ' + s.failing.slice(0, 2).join(', ') + (s.failing.length > 2 ? ' +' + (s.failing.length - 2) : '') : ''
  bits.push(s.checks === 'pass' ? '✓ checks' : s.checks === 'fail' ? '✗ checks' + failed : s.checks === 'pending' ? '⏳ checks' : '· no checks')
  if (s.policy === 'fail') bits.push('⚖ needs atlantis approve_policies')
  if (s.approvals) bits.push(s.approvals + ' approve')
  if (s.review === 'CHANGES_REQUESTED') bits.push('changes requested')
  if (s.unresolved) bits.push('💬 ' + s.unresolved)
  if (s.mergeable === 'CONFLICTING') bits.push('conflict')
  else if (s.mergeState === 'BEHIND') bits.push('behind base')
  // BLOCKED says only that a rule holds it. With threads open or approvals in,
  // review is not what is missing; reviewDecision is null on repos whose
  // ruleset (not branch protection) requires the review.
  else if (s.mergeState === 'BLOCKED') bits.push(s.unresolved ? 'blocked' : s.review === 'APPROVED' || s.approvals > 0 ? 'blocked' : 'needs review')
  else if (s.mergeState && s.mergeState !== 'UNKNOWN') bits.push(s.mergeState.toLowerCase())
  if (s.isDraft) bits.push('draft')
  if (s.iac) {
    const line = iacLine(s.iac, iacWindows, Date.now())
    if (line) bits.push(line)
  }
  return bits.join(' · ')
}

// What, if anything, needs the person or Claude now. Not mergeable is the
// point: a PR that is behind its base, waiting on a policy approval or on a
// review is stuck as surely as one with failing checks.
export type PrNeed = 'fail' | 'conflict' | 'policy' | 'threads' | 'behind' | 'review' | 'ready'

export function needsAttention(s: PrStatus): PrNeed | undefined {
  if (s.state !== 'OPEN') return undefined
  if (s.checks === 'fail' || s.iac?.apply === 'fail') return 'fail'
  if (s.mergeable === 'CONFLICTING' || s.mergeState === 'DIRTY') return 'conflict'
  if (s.policy === 'fail') return 'policy'
  if (s.unresolved > 0) return 'threads'
  if (s.mergeState === 'BEHIND') return 'behind'
  if (s.mergeState === 'BLOCKED' && s.checks !== 'pending' && s.review !== 'APPROVED' && s.approvals === 0) return 'review'
  if (s.mergeState === 'CLEAN' && s.checks !== 'pending') return 'ready'
  return undefined
}

// The one reason a stuck PR is stuck, for a row that has room for one.
export function needLabel(s: PrStatus): string | undefined {
  const need = needsAttention(s)
  if (need === 'fail') return '✗ ' + (s.iac?.apply === 'fail' ? 'apply' : (s.failing?.[0] ?? 'checks'))
  if (need === 'conflict') return 'conflict'
  if (need === 'policy') return '⚖ approve_policies'
  if (need === 'threads') return '💬 ' + s.unresolved
  if (need === 'behind') return 'behind base'
  if (need === 'review') return 'needs review'
  return undefined
}

// The needs a person acts on, as the Now tab's "Needs you" card lists them.
export const STUCK: readonly PrNeed[] = ['fail', 'conflict', 'policy', 'threads', 'behind', 'review']

// Which gh account owns a repo: org.json's github.accounts, by owner
// (lib/org.ts). Re-exported here, where the PR code has always found it.
export { ghAccountFor } from './org'


export function repoFromRemote(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(url.trim())
  return m?.[1]
}

// The repo a gh command line names: `--repo owner/name` / `-R owner/name`, a
// pull/issues URL, a `gh api repos/<owner>/<name>` path (leading `/` or not),
// or a graphql `repository(owner:"o", name:"n")`.
export function repoFromGh(command: string): string | undefined {
  return (
    /(?:--repo|-R)[ =]([\w.-]+\/[\w.-]+)/.exec(command)?.[1] ??
    /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\//.exec(command)?.[1] ??
    /\bgh\s+api\b[^|;&]*?(?:^|\s)["']?\/?repos\/([\w.-]+\/[\w.-]+)/.exec(command)?.[1] ??
    graphqlRepo(command)
  )
}

function graphqlRepo(command: string): string | undefined {
  const m = /repository\(\s*owner:\s*\\?["']([\w.-]+)\\?["']\s*,\s*name:\s*\\?["']([\w.-]+)\\?["']/.exec(command)
  return m ? m[1] + '/' + m[2] : undefined
}

// A `gh api` call whose target repo the line does not show (`gh api user`,
// `orgs/<o>/...`): the session's repo says nothing about which account it
// needs, so the caller must not fall back to it. `repos/{owner}/{repo}`
// placeholders do mean the current repo, so those keep the fallback.
function apiWithoutRepo(command: string): boolean {
  return /^\s*(\w+=\S+\s+)*gh\s+api\b/.test(command) && !/\{owner\}/.test(command)
}

// A Bash `gh` call that must run as another login than gh's active one: the
// login org.json maps the target repo's owner to (the -R/URL repo, else the
// session's), and the command to run instead, with that login's token in
// front. Undefined when the call names its own GH_TOKEN, is `gh auth`, needs
// no token (--version, help), or the owner maps to no login.
//
// The guard refuses such a call and hands this command back for the model to
// run itself; it does not rewrite the call. Observed in auto mode: with the
// old rewrite, `gh --version` and `gh api user` reached the classifier as
// `GH_TOKEN="$(gh auth token --user keyolk)" gh ...` and were refused as
// [Credential Exploration] (workers stopped at a permission prompt), while the
// same prefixed command written by the model ran with no prompt.
export function ghAsAccount(command: string, sessionRepo: string | undefined): { account: string; prefix: string; rerun: string } | undefined {
  if (!/^\s*(\w+=\S+\s+)*gh\s/.test(command) || /\bGH_TOKEN=/.test(command) || /\bgh\s+auth\b/.test(command)) return undefined
  if (/^\s*(\w+=\S+\s+)*gh\s+(--version|version|help|--help)\b/.test(command)) return undefined
  const account = ghAccountFor(repoFromGh(command) ?? (apiWithoutRepo(command) ? undefined : sessionRepo))
  if (!account) return undefined
  const prefix = 'GH_TOKEN="$(gh auth token --user ' + account + ')" '
  return { account, prefix, rerun: prefix + command.trimStart() }
}

// What the model reads when ghAsAccount refuses a call: the whole command to
// run when it is short, only the prefix for a long or multi-line one (a
// `gh pr create` with its body would be echoed back in full).
export function ghAsAccountDeny(need: { account: string; prefix: string; rerun: string }): string {
  const head = 'This repo\'s owner maps to the gh login ' + need.account + ' (org.json). Run the same command again with its token in front'
  const tail = '\n(cc-mods does not add the token itself: auto mode refused calls the hook had rewritten that way.)'
  if (need.rerun.length <= 300 && !need.rerun.includes('\n')) return head + ', exactly:\n' + need.rerun + tail
  return head + ': put this before `gh`, the rest unchanged:\n' + need.prefix.trimEnd() + tail
}

// The lines of a GitOps PR's comments that the ArgoDiff and Codex summaries
// need, cut down by gh's own jq so the mod receives a few hundred bytes
// instead of every diff. argv for `gh`; parse the output with gitopsFromComments.
export function gitopsCommentsArgv(ref: PrRef): string[] {
  const keep = 'application|^- `|</details>|<summary>|codex-pull-request-review-summary|Code Review|argodiff:comment'
  return ['api', '--paginate', 'repos/' + ref.repo + '/issues/' + ref.number + '/comments', '--jq', '.[] | .body | split("\\n") | map(select(test("' + keep + '"))) | join("\\n") + "\\n<<<END>>>"']
}

export function gitopsFromComments(out: string, headOid: string | undefined): Pick<IacState, 'argodiff' | 'codex'> {
  const bodies = out.split('<<<END>>>').map((b) => b.trim()).filter(Boolean)
  const argo = [...bodies].reverse().find((b) => /argodiff:comment/.test(b) && /application\(s\) with changes|Application Diff/.test(b))
  const codex = [...bodies].reverse().find((b) => /codex-pull-request-review-summary/.test(b))
  return { argodiff: argo ? parseArgoDiff(argo) : undefined, codex: codex ? parseCodex(codex, headOid) : undefined }
}

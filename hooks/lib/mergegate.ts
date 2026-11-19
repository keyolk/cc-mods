// The coordinator's merge rule as a check, not only a sentence in its prompt.
//
// coordRules says: merge only when the head equals the READY sha
// (--match-head-commit), CI passed on that sha, no unresolved threads, and the
// head contains the base branch. Those were prose the model had to remember
// at the moment of merging; one missed clause merged a PR whose head had
// moved or whose CI was still running. This module reads the PR once, right
// before `gh pr merge` runs, and refuses the call with the clause that failed.
//
// `--admin` is the person's typed order to bypass branch protection (the rule
// allows it only then), so it skips the CI, thread and up-to-date clauses but
// still needs --match-head-commit: an admin merge of a head nobody verified
// is the case the rule exists for.

import { checkVerdict, type PrRef } from './prs'

export type MergeCall = PrRef & { matchHead?: string; admin: boolean }

// `gh pr merge` with its PR named (number or URL) and the repo it targets.
// Undefined for any other command. A merge that names no PR (the current
// branch's) or no repo yields { number: 0 } / repo '' so the caller can ask
// for it to be named instead of guessing.
export function parseMerge(command: string, sessionRepo: string | undefined): MergeCall | undefined {
  // A quoted token with no space is just that token (--match-head-commit "abc");
  // a quoted string with spaces is an argument such as a grep pattern or a
  // commit message, not a gh call, so it is dropped before looking.
  const bare = command.replace(/(['"])([^\s'"]*)\1/g, '$2').replace(/'[^']*'|"[^"]*"/g, "''")
  // A merge buried in a pipeline or after `&&` is found too.
  const m = /(?:^|[;&|(]\s*|\s)gh\s+pr\s+merge\b([^;&|\n]*)/.exec(bare)
  if (!m) return undefined
  const args = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
  let number = 0
  let repo = ''
  let matchHead: string | undefined
  let admin = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = args[i + 1]
    const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(a)
    if (url) {
      repo = url[1]!
      number = Number(url[2])
    } else if (/^#?\d+$/.test(a)) number = Number(a.replace('#', ''))
    else if (a === '--admin') admin = true
    else if (a === '--match-head-commit' && next) (matchHead = next.replace(/['"]/g, '')), i++
    else if (a.startsWith('--match-head-commit=')) matchHead = a.slice('--match-head-commit='.length).replace(/['"]/g, '')
    else if ((a === '-R' || a === '--repo') && next) (repo = next), i++
    else if (a.startsWith('--repo=')) repo = a.slice('--repo='.length)
  }
  return { repo: repo || sessionRepo || '', number, matchHead, admin }
}

// What the check reads about the PR: one GraphQL query.
export function mergeQuery(ref: PrRef): string {
  const [owner, name] = ref.repo.split('/')
  return (
    `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
    ` pullRequest(number: ${ref.number}) { state isDraft mergeable headRefOid baseRefName` +
    ` reviewThreads(first: 100) { nodes { isResolved } }` +
    ` commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 80) { nodes {` +
    ` ... on StatusContext { context state description isRequired(pullRequestNumber: ${ref.number}) }` +
    ` ... on CheckRun { name status conclusion isRequired(pullRequestNumber: ${ref.number}) } } } } } } } } } }`
  )
}

export type MergeFacts = {
  state: string
  isDraft: boolean
  mergeable: string
  head: string
  base: string
  unresolved: number
  // The CI clause's verdict: over the required checks when branch protection
  // names any, over every check otherwise (a repo with no required checks).
  checks: 'pass' | 'fail' | 'pending' | 'none'
  failing: string[]
  // Checks that failed but are not required (a repo-wide failing linter, a
  // flaky scanner), and, in a repo that requires none, runs stuck QUEUED past
  // STUCK_QUEUED_MS: reported beside a refusal, never a reason for one.
  advisory: string[]
  requiredOnly: boolean // the verdict above is over required checks only
}

// A check run that never left QUEUED this long after the head commit is a
// stalled runner or app, not CI still working: sendbird/ops-k8s#10926 sat on
// "Hawkman: Find and verify secrets" queued for 50 minutes (2026-11-19) while
// every other check had finished, and the rule held the merge the whole time.
export const STUCK_QUEUED_MS = 30 * 60 * 1000

export function parseMergeFacts(json: string, now: number = Date.now()): MergeFacts | undefined {
  let pr: any
  try {
    pr = JSON.parse(json)?.data?.repository?.pullRequest
  } catch {
    return undefined
  }
  if (!pr?.headRefOid) return undefined
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const nodes: any[] = Array.isArray(rollup?.contexts?.nodes) ? rollup.contexts.nodes : []
  const required = nodes.filter((n) => n?.isRequired === true)
  // Branch protection decides which failed check blocks a merge, as it does
  // for GitHub itself (a failed optional check is mergeStateStatus UNSTABLE,
  // still mergeable). A failure outside it is advisory: Gordon fails on every
  // sendbird/context PR (no catalog-info.yaml) and that repo requires no
  // check, so counting every failure there would leave only --admin.
  // A check still running holds the merge either way: waiting is cheap, and
  // with nothing required it is the only CI signal the rule keeps.
  let v: ReturnType<typeof checkVerdict>
  let advisory: string[]
  if (required.length) {
    v = checkVerdict(required)
    advisory = checkVerdict(nodes.filter((n) => n?.isRequired !== true)).failing
  } else {
    // Nothing required: a run still QUEUED long after the head was committed
    // is set aside like an optional failure, so it cannot hold the merge
    // forever. A run IN_PROGRESS still holds it.
    const committed = Date.parse(pr.commits?.nodes?.[0]?.commit?.committedDate ?? '')
    const stale = Number.isFinite(committed) && now - committed > STUCK_QUEUED_MS
    const stuck = stale ? nodes.filter((n) => n?.status === 'QUEUED').map((n) => String(n?.name ?? '')) : []
    const live = nodes.filter((n) => !stuck.includes(String(n?.name ?? n?.context ?? '')))
    const all = checkVerdict(live, stuck.length ? undefined : rollup?.state)
    advisory = all.failing
    const rest = live.filter((n) => !advisory.includes(String(n?.name ?? n?.context ?? '')))
    // No named failure (only the rollup said FAILURE): keep that verdict.
    v = advisory.length ? checkVerdict(rest) : all
    advisory = [...advisory, ...stuck.map((n) => n + ' (queued 30m+)')]
  }
  return {
    state: pr.state ?? '',
    isDraft: !!pr.isDraft,
    mergeable: pr.mergeable ?? 'UNKNOWN',
    head: pr.headRefOid,
    base: pr.baseRefName ?? '',
    unresolved: (pr.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length,
    checks: v.checks,
    failing: v.failing,
    advisory,
    requiredOnly: required.length > 0,
  }
}

// The clauses that fail, in the rule's order; empty when the merge may run.
// `behindBy` is how many base-branch commits the head lacks (REST compare);
// undefined when it could not be read, which fails the clause.
export function mergeProblems(call: MergeCall, f: MergeFacts, behindBy: number | undefined): string[] {
  const out: string[] = []
  if (f.state !== 'OPEN') return ['the PR is ' + f.state.toLowerCase() + ', not open']
  if (!call.matchHead) out.push('no --match-head-commit <READY sha>: name the sha the worker reported READY, so a later push cannot slip in')
  else if (!f.head.startsWith(call.matchHead.toLowerCase()) || call.matchHead.length < 7)
    out.push('--match-head-commit ' + call.matchHead + ' is not the head (' + f.head.slice(0, 9) + '): the branch moved after READY; verify the new head first')
  if (call.admin) return out
  if (f.isDraft) out.push('the PR is a draft')
  const what = f.requiredOnly ? 'a required check' : 'CI'
  if (f.checks === 'fail') out.push(what + ' failed on the head' + (f.failing.length ? ': ' + f.failing.slice(0, 5).join(', ') : ''))
  else if (f.checks === 'pending') out.push(what + ' is still running on the head')
  if (f.unresolved > 0) out.push(f.unresolved + ' unresolved review thread' + (f.unresolved > 1 ? 's' : ''))
  if (f.mergeable === 'CONFLICTING') out.push('the head conflicts with ' + (f.base || 'the base'))
  if (behindBy === undefined) out.push('could not read whether the head contains ' + (f.base || 'the base') + ' (compare failed)')
  else if (behindBy > 0) out.push('the head lacks ' + behindBy + ' commit' + (behindBy > 1 ? 's' : '') + ' of ' + f.base + ': update the branch and let CI run again')
  return out
}

export function mergeDeny(call: MergeCall, problems: readonly string[], advisory: readonly string[] = []): string {
  return (
    'BLOCKED by the cc-mods merge check (' + call.repo + '#' + call.number + '):\n' +
    problems.map((p) => '  - ' + p).join('\n') +
    (advisory.length ? '\nNot required, so not a reason (failed or stuck): ' + advisory.slice(0, 5).join(', ') : '') +
    '\nThe coordinator merge rule: head = READY sha (--match-head-commit), required checks passed on that sha (all checks when none is required), no unresolved threads, head contains the base. ' +
    '--admin (only on the person\'s typed order) skips all but the head match.'
  )
}

// argv for `gh` that prints how many base commits the head lacks.
export function compareArgv(repo: string, base: string, head: string): string[] {
  return ['api', 'repos/' + repo + '/compare/' + encodeURIComponent(base) + '...' + head, '--jq', '.behind_by']
}

// A repo the query can name. `-R $R` leaves the shell variable unexpanded in
// the command text the hook sees, so the query got owner "$R" and no name
// ("Argument 'name' ... invalid value (undefined)"): refuse that call with a
// message that says to write owner/repo out, instead of a GraphQL error.
export const validRepo = (repo: string): boolean => /^[\w.-]+\/[\w.-]+$/.test(repo)

export const REPO_LITERAL_HINT = 'name the repo literally as -R owner/repo (the hook reads the command text; it does not expand a shell variable such as $R)'

// The gh logins `gh auth status` lists, in its order.
export function ghLogins(statusText: string): string[] {
  const out: string[] = []
  const re = /Logged in to github\.com account (\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(statusText))) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

// The order to try logins in for one repo: the one org.json maps its owner to
// (or the one that read it last), then every other login gh knows. The mapped
// login may be missing (org.json absent, a stale copy loaded at session
// start) or wrong, and the active login may not see the repo ("Could not
// resolve to a Repository"), so the read tries the rest instead of failing.
export function readOrder(preferred: readonly (string | undefined)[], logins: readonly string[]): string[] {
  return [...new Set([...preferred, ...logins].filter((a): a is string => !!a))]
}

type Run = (account: string | undefined, argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// Read the PR as each login in turn until one can. `account` is the login
// that read it; `errors` holds why each login before it could not. An empty
// order reads once as gh's active login (account undefined).
export async function readMergeFacts(
  run: Run,
  call: PrRef,
  order: readonly string[],
): Promise<{ facts?: MergeFacts; account?: string; errors: string[] }> {
  const errors: string[] = []
  for (const account of order.length ? order : [undefined]) {
    const q = await run(account, ['api', 'graphql', '-f', 'query=' + mergeQuery(call)])
    const facts = q.exitCode === 0 ? parseMergeFacts(q.stdout) : undefined
    if (facts) return { facts, account, errors }
    errors.push((account ? account + ': ' : 'active login: ') + 'gh api graphql exit ' + q.exitCode + ': ' + String(q.stderr ?? '').trim().slice(0, 160))
  }
  return { errors }
}

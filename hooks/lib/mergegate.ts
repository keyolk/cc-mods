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
    ` commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 80) { nodes {` +
    ` ... on StatusContext { context state description } ... on CheckRun { name status conclusion } } } } } } } } } }`
  )
}

export type MergeFacts = {
  state: string
  isDraft: boolean
  mergeable: string
  head: string
  base: string
  unresolved: number
  checks: 'pass' | 'fail' | 'pending' | 'none'
  failing: string[]
}

export function parseMergeFacts(json: string): MergeFacts | undefined {
  let pr: any
  try {
    pr = JSON.parse(json)?.data?.repository?.pullRequest
  } catch {
    return undefined
  }
  if (!pr?.headRefOid) return undefined
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const v = checkVerdict(rollup?.contexts?.nodes, rollup?.state)
  return {
    state: pr.state ?? '',
    isDraft: !!pr.isDraft,
    mergeable: pr.mergeable ?? 'UNKNOWN',
    head: pr.headRefOid,
    base: pr.baseRefName ?? '',
    unresolved: (pr.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length,
    checks: v.checks,
    failing: v.failing,
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
  if (f.checks === 'fail') out.push('CI failed on the head' + (f.failing.length ? ': ' + f.failing.slice(0, 5).join(', ') : ''))
  else if (f.checks === 'pending') out.push('CI is still running on the head')
  if (f.unresolved > 0) out.push(f.unresolved + ' unresolved review thread' + (f.unresolved > 1 ? 's' : ''))
  if (f.mergeable === 'CONFLICTING') out.push('the head conflicts with ' + (f.base || 'the base'))
  if (behindBy === undefined) out.push('could not read whether the head contains ' + (f.base || 'the base') + ' (compare failed)')
  else if (behindBy > 0) out.push('the head lacks ' + behindBy + ' commit' + (behindBy > 1 ? 's' : '') + ' of ' + f.base + ': update the branch and let CI run again')
  return out
}

export function mergeDeny(call: MergeCall, problems: readonly string[]): string {
  return (
    'BLOCKED by the cc-mods merge check (' + call.repo + '#' + call.number + '):\n' +
    problems.map((p) => '  - ' + p).join('\n') +
    '\nThe coordinator merge rule: head = READY sha (--match-head-commit), CI passed on that sha, no unresolved threads, head contains the base. ' +
    '--admin (only on the person\'s typed order) skips all but the head match.'
  )
}

// argv for `gh` that prints how many base commits the head lacks.
export function compareArgv(repo: string, base: string, head: string): string[] {
  return ['api', 'repos/' + repo + '/compare/' + encodeURIComponent(base) + '...' + head, '--jq', '.behind_by']
}

// What this mod knows about the organisation it runs in, from a file the
// person keeps outside the repository: ~/.config/cc-mods/org.json.
//
// Slack team and the review channel a send needs no grant for, Jira's site
// and project keys, which GitHub login serves which owner, how kubectl
// contexts and AWS profiles group into stacks, which AWS profiles are SSO,
// the SSO start URL, what ArgoCD hosts are called, and where region maintenance windows are
// kept. These were constants in the code, which put one company's channel
// ids and hostnames into every copy of it. With no file, each feature that
// needs one of them is off — no Jira links, no stack labels, no default
// Slack target — and nothing else changes.
//
// Loaded once at session start (register.ts) and read through org(); the
// pure functions here and in the other libs take it from there, so tests
// set it with setOrg().

export type Stack = {
  name: string
  // A kubectl context or AWS profile starting with one of these is in it.
  prefixes: string[]
}

export type Org = {
  slack: {
    // The workspace name in slack.com URLs (<team>.slack.com).
    team?: string
    // Channel id -> label: sends here go without asking (session policy).
    defaultTargets: Record<string, string>
  }
  jira: {
    // https://<site>.atlassian.net; tickets link to <baseUrl>/browse/<key>.
    baseUrl?: string
    // Project keys whose tickets are recognised in text (ABC-123).
    projects: string[]
  }
  github: {
    // owner -> gh login to use for it. An owner not listed uses gh's own
    // active account, as does one mapped to "" — no token is passed.
    accounts: Record<string, string>
  }
  // Stacks never to be mixed, by context/profile prefix; the first match wins.
  stacks: Stack[]
  // AWS profile prefixes that sign in through SSO, for the expiry pre-check.
  awsSsoProfiles: string[]
  // The IAM Identity Center start URL whose session the Auth tab watches.
  awsSsoStartUrl?: string
  // ArgoCD host suffix -> label suffix ("" for the main one).
  argocdDomains: Record<string, string>
  // Region maintenance-window files (YAML), ~ expanded.
  regionFiles: string[]
}

export const EMPTY_ORG: Org = {
  slack: { defaultTargets: {} },
  jira: { projects: [] },
  github: { accounts: {} },
  stacks: [],
  awsSsoProfiles: [],
  argocdDomains: {},
  regionFiles: [],
}

let current: Org = EMPTY_ORG

export function org(): Org {
  return current
}

export function setOrg(o: Org) {
  current = o
}

export const ORG_PATH = '/.config/cc-mods/org.json' // under $HOME

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s !== '') : [])
const record = (x: unknown): Record<string, string> =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}

// parseOrg reads the file's text, keeping what is well-formed and dropping
// the rest: a typo in one field does not turn every feature off.
export function parseOrg(text: string | undefined): Org {
  if (!text) return EMPTY_ORG
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return EMPTY_ORG
  }
  if (!j || typeof j !== 'object') return EMPTY_ORG
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined)
  return {
    slack: { team: str(j.slack?.team), defaultTargets: record(j.slack?.defaultTargets) },
    jira: { baseUrl: str(j.jira?.baseUrl)?.replace(/\/+$/, ''), projects: strings(j.jira?.projects).filter((p) => /^[A-Z][A-Z0-9]+$/.test(p)) },
    github: { accounts: record(j.github?.accounts) },
    stacks: (Array.isArray(j.stacks) ? j.stacks : [])
      .map((s: any) => ({ name: str(s?.name) ?? '', prefixes: strings(s?.prefixes) }))
      .filter((s: Stack) => s.name && s.prefixes.length),
    awsSsoProfiles: strings(j.awsSsoProfiles),
    awsSsoStartUrl: str(j.awsSsoStartUrl),
    argocdDomains: record(j.argocdDomains),
    regionFiles: strings(j.regionFiles),
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// jiraKeyPattern matches a ticket key of a configured project, or nothing.
export function jiraKeyPattern(o: Org = current): RegExp | undefined {
  if (!o.jira.projects.length) return undefined
  return new RegExp('\\b(' + o.jira.projects.map(escape).join('|') + ')-\\d{2,6}\\b', 'g')
}

// stackOf is the stack a context or profile name belongs to, or ''.
export function stackOf(name: string, o: Org = current): string {
  return o.stacks.find((s) => s.prefixes.some((p) => name.startsWith(p)))?.name ?? ''
}

// ghAccountFor is the gh login to use for a repository's owner, or
// undefined to use gh's active account.
export function ghAccountFor(repo: string | undefined, o: Org = current): string | undefined {
  const owner = repo?.split('/')[0]?.toLowerCase()
  if (!owner) return undefined
  const entry = Object.entries(o.github.accounts).find(([k]) => k.toLowerCase() === owner)
  return entry?.[1] || undefined
}

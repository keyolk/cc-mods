// Whether Claude Code will start in a folder without its "Quick safety check:
// Is this a project you created or one you trust?" dialog. A worker window
// stopped there never runs its brief (the default answer exits), so the
// coordinator checks first. Only the person accepts that dialog: this reads
// ~/.claude.json, it never writes it.
//
// The rule, as Claude Code 2.x decides it (Ax / r_ / o_ in its bundle):
//   1. projects[<canonical root>].hasTrustDialogAccepted, where the canonical
//      root is the main checkout of the folder's git repository (a worktree
//      shares its main checkout's), or the folder itself outside git.
//   2. Else the folder or a parent of it, but inside a git repository only up
//      to its toplevel: a trusted home directory does not cover a repository
//      under it. Outside git, any parent up to /.
// Pure: the mod reads the file and asks git.

export type TrustPlace = { dir: string; top?: string; canonical?: string }

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const parent = (p: string) => norm(p).replace(/\/[^/]*$/, '') || '/'

export function parseProjects(json: string | undefined): Record<string, unknown> {
  try {
    const raw = json ? JSON.parse(json) : undefined
    return raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {}
  } catch {
    return {}
  }
}

const accepted = (projects: Record<string, unknown>, p: string) => {
  const v = projects[p] as { hasTrustDialogAccepted?: unknown } | undefined
  return !!v && typeof v === 'object' && v.hasTrustDialogAccepted === true
}

// The trusted path that covers the folder, or undefined when Claude Code
// would ask.
export function trustedBy(projects: Record<string, unknown>, at: TrustPlace): string | undefined {
  const dir = norm(at.dir)
  const canonical = at.canonical ? norm(at.canonical) : at.top ? undefined : dir
  if (canonical && accepted(projects, canonical)) return canonical
  const top = at.top ? norm(at.top) : undefined
  for (let p = dir; ; p = parent(p)) {
    if (top && p !== top && !p.startsWith(top + '/')) return undefined
    if (accepted(projects, p)) return p
    if (p === top || p === '/') return undefined
  }
}

// The folder whose trust would cover the place: the main checkout for a
// repository, else the folder itself. What the person is told to open.
export function trustTarget(at: TrustPlace): string {
  return norm(at.canonical ?? at.top ?? at.dir)
}

// `git rev-parse --git-common-dir` (absolute) to the main checkout: the
// parent of its .git, or the bare repository itself.
export function canonicalOf(common: string | undefined): string | undefined {
  if (!common) return undefined
  const c = norm(common)
  return c.endsWith('/.git') ? c.slice(0, -5) || '/' : c
}

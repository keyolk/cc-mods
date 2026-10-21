// What an infrastructure PR is waiting on, beyond checks and reviews.
//
// Atlantis repos (*-nest): each project's plan (from the per-project
// `atlantis/plan: <dir>` status), whether policies need `atlantis
// approve_policies`, the apply's state, labels that change what apply does
// (timewindow-bypass, DO NOT APPLY, emergency, auto-atlantis-apply), and the
// sbregion's maintenance window from a region file (org.json regionFiles), since an
// apply outside it is refused unless the bypass label is on.
//
// GitOps repos (*-k8s): the ArgoDiff comment (which apps change), the Codex
// review summary (done, and on which commit), and the claude-review check.
//
// Both: the auto reviewer's label (auto-review/approved | needs-human | skipped).
// Pure: lib/prs.ts feeds it the GraphQL nodes; register.ts reads the yaml.

export type PlanCount = { add: number; change: number; destroy: number }

export type IacState = {
  kind: 'atlantis' | 'gitops'
  // atlantis
  projects?: { dir: string; state: 'pass' | 'fail' | 'pending'; plan?: PlanCount; region?: string }[]
  apply?: 'pass' | 'fail' | 'pending'
  bypass?: boolean // timewindow-bypass label
  hold?: string // DO NOT APPLY, emergency, auto-atlantis-apply, ApplyOnReview
  // gitops
  argodiff?: { changed: number; checked: number; apps: string[] }
  codex?: { state: 'done' | 'running' | 'stale'; commit?: string }
  claudeReview?: 'pass' | 'fail' | 'pending'
  // both: where it lands, from the changed paths (regions or clusters);
  // `broad` when a shared file (a chart's base values, templates) changes,
  // since then it lands everywhere and naming a few would mislead.
  scope?: { names: string[]; broad: boolean }
  autoReview?: 'approved' | 'needs-human' | 'skipped' | 'pending'
}

export function iacKind(repo: string): IacState['kind'] | undefined {
  const name = repo.split('/')[1] ?? ''
  if (/-nest$/.test(name)) return 'atlantis'
  if (/-k8s$/.test(name)) return 'gitops'
  return undefined
}

const RESULT = (raw: string): 'pass' | 'fail' | 'pending' | undefined =>
  /^(SUCCESS)$/.test(raw) ? 'pass' : /^(FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED)$/.test(raw) ? 'fail' : /^(CANCELLED|SKIPPED|NEUTRAL|STALE)$/.test(raw) ? undefined : 'pending'

// "Plan: 2 to add, 0 to change, 1 to destroy." | "No changes. …"
export function parsePlan(desc: string | undefined): PlanCount | undefined {
  if (!desc) return undefined
  if (/No changes/i.test(desc)) return { add: 0, change: 0, destroy: 0 }
  const m = /Plan: (\d+) to add, (\d+) to change, (\d+) to destroy/.exec(desc)
  return m ? { add: Number(m[1]), change: Number(m[2]), destroy: Number(m[3]) } : undefined
}

// aws/chat-prod/use1/us3/30-service/common-gateway → us3 (the sbregion).
export function regionOfDir(dir: string): string | undefined {
  const parts = dir.split('/')
  return parts[0] === 'aws' && parts.length >= 4 ? parts[3] : undefined
}

// "### 1 application(s) with changes (out of 1 checked)" and the list after
// "applications with changes".
export function parseArgoDiff(body: string): IacState['argodiff'] {
  const m = /(\d+) application\(s\) with changes \(out of (\d+) checked\)/.exec(body)
  if (!m) return /No (application )?changes|no applications? (with|have) changes/i.test(body) ? { changed: 0, checked: 0, apps: [] } : undefined
  const list = body.split(/applications with changes/)[1]?.split('</details>')[0] ?? ''
  const apps = [...list.matchAll(/^- `([^`]+)`/gm)].map((x) => x[1]!)
  return { changed: Number(m[1]), checked: Number(m[2]), apps }
}

// The Codex summary table: "| 📝 **Code Review** | ✅ **Completed** … | `4856db1` | …"
export function parseCodex(body: string, headOid: string | undefined): IacState['codex'] {
  const row = /\*\*Code Review\*\*\s*\|\s*([^|]+)\|\s*`([0-9a-f]{7,40})`/.exec(body)
  if (!row) return undefined
  const commit = row[2]!
  const done = /Completed/i.test(row[1]!)
  if (headOid && !headOid.startsWith(commit)) return { state: 'stale', commit }
  return { state: done ? 'done' : 'running', commit }
}

// Where a changed file lands. GitOps values: charts/<chart>/values/<env>/<region>[...].yaml;
// core-k8s cluster configs: …/config/cluster/<cluster>.yaml; atlantis:
// aws/<account>/<aws-region>/<sbregion>/…. undefined for a shared file
// (it applies to every target), null for one that deploys nothing (CI, docs).
export function scopeOfPath(path: string): string | null | undefined {
  if (/^(\.github\/|docs?\/|README|\.pre-commit|Makefile|scripts\/)/i.test(path) || /\/tests?\//.test(path)) return null
  const v = /^charts\/[^/]+\/values\/[^/]+\/([^/.]+)/.exec(path)
  if (v) return v[1]!
  const c = /\/config\/cluster\/([^/]+)\.ya?ml$/.exec(path)
  if (c) return c[1]!
  const a = /^aws\/[^/]+\/[^/]+\/([^/]+)\//.exec(path)
  if (a && !a[1]!.startsWith('_')) return a[1]!
  return undefined
}

export function scopeOf(paths: readonly string[], kind?: IacState['kind']): IacState['scope'] {
  const names = new Set<string>()
  let broad = false
  let shared = false
  for (const p of paths) {
    const s = scopeOfPath(p)
    if (s === undefined) {
      // An atlantis repo's shared code (_snippet, _modules) reaches only the
      // region dirs that use it; those dirs are what plans and applies. It is
      // broad only when no region dir changed with it (autoplan then plans
      // nothing, and every region using it is affected later).
      if (kind === 'atlantis' && /^_/.test(p)) shared = true
      else broad = true
    } else if (s) names.add(s)
  }
  if (shared && !names.size) broad = true
  if (!names.size && !broad) return undefined
  return { names: [...names].sort(), broad }
}

export function iacState(repo: string, pr: any): IacState | undefined {
  const kind = iacKind(repo)
  if (!kind) return undefined
  const labels: string[] = (pr.labels?.nodes ?? []).map((l: any) => String(l.name))
  const contexts: any[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const st: IacState = { kind }
  const paths: string[] = (pr.files?.nodes ?? []).map((f: any) => String(f.path))
  st.scope = scopeOf(paths, kind)
  const auto = labels.find((l) => l.startsWith('auto-review/') && l !== 'auto-review/skipped') ?? labels.find((l) => l === 'auto-review/skipped')
  if (auto) st.autoReview = auto.slice('auto-review/'.length) as IacState['autoReview']
  if (kind === 'atlantis') {
    const projects: NonNullable<IacState['projects']> = []
    for (const c of contexts) {
      const name = String(c?.context ?? '')
      const raw = String(c?.state ?? '')
      if (name.startsWith('atlantis/plan: ')) {
        const dir = name.slice('atlantis/plan: '.length).replace(/\/default$/, '')
        projects.push({ dir, state: RESULT(raw) ?? 'pending', plan: parsePlan(c?.description), region: regionOfDir(dir) })
      }
      if (name === 'atlantis/apply') st.apply = RESULT(raw)
    }
    st.projects = projects
    // Planned projects name their sbregion even when files were not fetched.
    const fromDirs = projects.map((p) => p.region).filter((r): r is string => !!r)
    if (fromDirs.length) st.scope = { names: [...new Set([...(st.scope?.names ?? []), ...fromDirs])].sort(), broad: st.scope?.broad ?? false }
    st.bypass = labels.includes('timewindow-bypass')
    st.hold = labels.find((l) => /^(DO NOT APPLY|emergency|auto-atlantis-apply|ApplyOnReview)$/.test(l))
  } else {
    const comments: any[] = pr.comments?.nodes ?? []
    const argo = [...comments].reverse().find((c) => /argodiff:comment/.test(c?.body ?? '') && /application\(s\) with changes|Application Diff/.test(c?.body ?? ''))
    if (argo) st.argodiff = parseArgoDiff(argo.body)
    const codex = [...comments].reverse().find((c) => /codex-pull-request-review-summary/.test(c?.body ?? ''))
    if (codex) st.codex = parseCodex(codex.body, pr.headRefOid)
    const claude = contexts.find((c) => String(c?.name ?? '') === 'claude-review')
    if (claude) st.claudeReview = RESULT(String(claude.status === 'COMPLETED' ? claude.conclusion : claude.status))
  }
  return st
}

// ---- maintenance windows (a region file (org.json regionFiles)) ----

export type SyncWindow = { minute: number; hour: number; durationMin: number }

// The yaml's sbregion entries with a daily `sync_window` ("M H * * *").
// A small line reader, not a YAML parser: the file's shape is fixed.
export function parseWindows(yaml: string | undefined): Record<string, SyncWindow> {
  const out: Record<string, SyncWindow> = {}
  if (!yaml) return out
  let region: string | undefined
  let schedule: string | undefined
  for (const line of yaml.split('\n')) {
    const r = /^\s*-\s*sbregion:\s*['"]?([\w-]+)/.exec(line)
    if (r) {
      region = r[1]
      schedule = undefined
      continue
    }
    const s = /^\s*schedule:\s*['"]?([^'"]+)['"]?/.exec(line)
    if (s && region) schedule = s[1]!.trim()
    const d = /^\s*duration:\s*['"]?([\dhm]+)/.exec(line)
    if (d && region && schedule) {
      const cron = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(schedule)
      const h = Number(/(\d+)h/.exec(d[1]!)?.[1] ?? 0)
      const m = Number(/(\d+)m/.exec(d[1]!)?.[1] ?? 0)
      if (cron) out[region] = { minute: Number(cron[1]), hour: Number(cron[2]), durationMin: h * 60 + m }
      schedule = undefined
    }
  }
  return out
}

// Open now, or how long until it opens / closes. UTC, daily.
export function windowState(w: SyncWindow, nowMs: number): { open: boolean; minutes: number } {
  const day = 1440
  const now = Math.floor(nowMs / 60000) % day
  const start = w.hour * 60 + w.minute
  const since = (now - start + day) % day
  if (since < w.durationMin) return { open: true, minutes: w.durationMin - since }
  return { open: false, minutes: (start - now + day) % day }
}

const hm = (min: number) => (min >= 60 ? Math.floor(min / 60) + 'h' + (min % 60 ? (min % 60) + 'm' : '') : min + 'm')

// One line for the PR row: what the infra side is waiting on, most urgent first.
// "📍 ap1, us3" for a few targets, "📍 7 regions" for many, nothing when it
// lands everywhere.
export function scopeLabel(sc: IacState['scope']): string | undefined {
  if (!sc || sc.broad || !sc.names.length) return undefined
  return '📍 ' + (sc.names.length <= 3 ? sc.names.join(', ') : sc.names.length + ' targets')
}

export function iacLine(st: IacState, windows: Record<string, SyncWindow>, nowMs: number): string {
  const bits: string[] = []
  const where = scopeLabel(st.scope)
  if (where) bits.push(where)
  if (st.kind === 'atlantis') {
    if (st.hold) bits.push('⛔ ' + st.hold)
    const ps = st.projects ?? []
    if (ps.some((p) => p.state === 'fail')) bits.push('✗ plan failed ' + ps.filter((p) => p.state === 'fail').length + '/' + ps.length)
    else if (ps.some((p) => p.state === 'pending')) bits.push('⏳ planning')
    else if (ps.length) {
      const t = ps.reduce((a, p) => ({ add: a.add + (p.plan?.add ?? 0), change: a.change + (p.plan?.change ?? 0), destroy: a.destroy + (p.plan?.destroy ?? 0) }), { add: 0, change: 0, destroy: 0 })
      bits.push('plan +' + t.add + ' ~' + t.change + ' -' + t.destroy + (ps.length > 1 ? ' (' + ps.length + ' dirs)' : ''))
    }
    if (st.apply === 'pass') bits.push('✓ applied')
    else if (st.apply === 'fail') bits.push('✗ apply failed')
    else if (st.apply === 'pending') bits.push('⏳ applying')
    else {
      const regions = [...new Set(ps.map((p) => p.region).filter((r): r is string => !!r && !!windows[r]))]
      if (st.bypass) bits.push('⏭ window bypass')
      else
        for (const r of regions.slice(0, 2)) {
          const ws = windowState(windows[r]!, nowMs)
          // One region is already named by 📍; several need their names here.
          const name = regions.length > 1 ? r + ' ' : ''
          bits.push(ws.open ? '🟢 ' + name + 'window ' + hm(ws.minutes) + ' left' : '🕒 ' + name + 'window in ' + hm(ws.minutes))
        }
    }
  } else {
    if (st.argodiff) bits.push('argodiff ' + (st.argodiff.changed ? st.argodiff.changed + ' app' + (st.argodiff.changed > 1 ? 's' : '') + (st.argodiff.apps.length ? ': ' + st.argodiff.apps.slice(0, 2).join(', ') : '') : 'no change'))
    else bits.push('argodiff —')
    if (st.codex) bits.push(st.codex.state === 'done' ? 'codex ✓' : st.codex.state === 'running' ? 'codex ⏳' : 'codex ↻ old commit')
    if (st.claudeReview) bits.push('claude ' + (st.claudeReview === 'pass' ? '✓' : st.claudeReview === 'fail' ? '✗' : '⏳'))
  }
  if (st.autoReview === 'needs-human') bits.push('👤 needs human')
  else if (st.autoReview === 'approved') bits.push('🤖 auto-approved')
  else if (st.autoReview === 'pending') bits.push('🤖 auto-review ⏳')
  return bits.join(' · ')
}

// The selected PR's full picture, one line each: every atlantis project with
// its plan and window, or every app ArgoDiff says changes.
export function iacDetail(st: IacState, windows: Record<string, SyncWindow>, nowMs: number): string[] {
  const out: string[] = []
  if (st.scope) out.push(st.scope.broad ? '📍 shared files: lands on every target' + (st.scope.names.length ? ' (also ' + st.scope.names.join(', ') + ')' : '') : '📍 ' + st.scope.names.join(', '))
  if (st.kind === 'atlantis') {
    if (st.hold) out.push('⛔ label ' + st.hold)
    if (st.bypass) out.push('⏭ timewindow-bypass: apply skips the window check')
    for (const p of st.projects ?? []) {
      const plan = p.state === 'fail' ? '✗ plan failed' : p.state === 'pending' ? '⏳ planning' : p.plan ? '+' + p.plan.add + ' ~' + p.plan.change + ' -' + p.plan.destroy : '✓'
      const w = p.region && windows[p.region] ? windowState(windows[p.region]!, nowMs) : undefined
      const win = !w ? '' : w.open ? '  🟢 window open, ' + hm(w.minutes) + ' left' : '  🕒 window opens in ' + hm(w.minutes)
      out.push(plan.padEnd(14) + p.dir + win)
    }
    out.push('apply: ' + (st.apply === 'pass' ? '✓ applied' : st.apply === 'fail' ? '✗ failed' : st.apply === 'pending' ? '⏳ running' : 'not yet'))
  } else {
    if (st.argodiff) {
      out.push('ArgoDiff: ' + st.argodiff.changed + ' of ' + st.argodiff.checked + ' apps change')
      for (const a of st.argodiff.apps) out.push('  ' + a)
    } else out.push('ArgoDiff: no comment yet')
    if (st.codex) out.push('Codex: ' + (st.codex.state === 'done' ? '✓ reviewed' : st.codex.state === 'running' ? '⏳ reviewing' : '↻ reviewed an older commit') + (st.codex.commit ? ' (' + st.codex.commit + ')' : ''))
    if (st.claudeReview) out.push('claude-review: ' + st.claudeReview)
  }
  if (st.autoReview) out.push('auto-review: ' + st.autoReview)
  return out
}

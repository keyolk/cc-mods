// Where coord_spawn puts a worker's pane: a split of the coordinator's pane,
// a split in a window that already holds this coordinator's workers, or a
// new window. Fixed rules list the places first (room after the split, how
// many workers a window already holds, and whether every session in the
// window does the same work as the new worker); coord_route's one model call
// then picks among them, and coord_spawn checks the pick again against tmux
// as it is at spawn time. A pick that is no listed place falls back to the
// first listed place (the coordinator's window first), else a new window.
// Pure: coord.ts reads tmux and git.

import { active, splitPlan, SPLIT_MIN, type Ledger, type Split, type Worker } from './coord'

// Workers one window holds before it takes no more splits. The coordinator's
// window also holds the person's tweb panes and the cockpit, and a third
// split leaves every pane too small to read.
export const WINDOW_WORKERS = 2

export type PaneBox = { window: string; pane: string; width: number; height: number }

// `tmux list-panes -a -F` with BOX_FMT.
export const BOX_FMT = '#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}'
export function parseBoxes(out: string): PaneBox[] {
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length === 4 && f[0]!.startsWith('@') && f[1]!.startsWith('%'))
    .map(([window, pane, w, h]) => ({ window: window!, pane: pane!, width: Number(w) || 0, height: Number(h) || 0 }))
}

export type Spot = { window: string; target: string; split: Split; kind: 'coordinator' | 'workers'; workers: string[]; work?: string[] }
// away: the windows left out because they hold other work, with why.
export type Spots = { spots: Spot[]; skipped: string[]; away: { window: string; why: string }[] }

// What a session works on: its directory, the main checkout of the git
// repository that directory is in (canonicalOf of its common dir) and that
// repository's GitHub owner/name. A worker in ~/research/<slug> with its code
// outside has two: the folder and the code.
export type Work = { dir: string; common?: string; repo?: string }
// A Claude session in a window: by its SendMessage name, with its work.
export type Busy = { window: string; name: string; work: Work[] }
// For spots: the sessions in each window, ~, and the new worker's work
// (unknown while coord_route has not chosen the repository yet: the windows
// are then only labelled with their work).
export type Fit = { sessions: Busy[]; home: string; want?: Work[] }

const norm = (p: string) => p.replace(/(.)\/+$/, '$1')

// Folders that hold many tasks rather than one: ~ and above it, a folder
// right under ~ (~/src, ~/research, ~/worktrees), an org or one
// repository's worktrees under ~/src or ~/worktrees, and the temp roots. Two
// sessions under one of these do not do the same work for that alone (live:
// a Concur expense worker in ~/research/concur-expense was split into the
// cc-mods coordinator's window).
function broad(d: string, home: string): boolean {
  if (!d || d === '/' || d === home || home.startsWith(d + '/') || d === '/tmp' || d === '/private/tmp') return true
  if (!d.startsWith(home + '/')) return false
  const parts = d.slice(home.length + 1).split('/')
  return parts.length === 1 || (parts.length === 2 && (parts[0] === 'src' || parts[0] === 'worktrees'))
}

// The same work: the same repository (one common git dir, or one GitHub
// remote across two clones), or one folder holding the other's when that
// folder is a task's (~/research/<slug>, a project folder), not a broad one.
export function sameWork(a: Work, b: Work, home: string): boolean {
  if (a.common && a.common === b.common) return true
  if (a.repo && b.repo && a.repo.toLowerCase() === b.repo.toLowerCase()) return true
  const x = norm(a.dir)
  const y = norm(b.dir)
  if (!x || !y) return false
  const [outer, inner] = x.length <= y.length ? [x, y] : [y, x]
  return (inner === outer || inner.startsWith(outer + '/')) && !broad(outer, norm(home))
}

export function related(a: readonly Work[], b: readonly Work[], home: string): boolean {
  return a.some((x) => b.some((y) => sameWork(x, y, home)))
}

// One line per session for the router and the reasons: its name and what
// it works on, the repository first.
export function workLabel(b: Busy, home: string): string {
  const w = b.work[0]
  const tilde = (p: string) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p)
  return b.name + ' (' + (w ? w.repo ?? tilde(w.common ?? w.dir) : '?') + ')'
}

// The sessions in `win` whose work is not the new worker's.
function otherWork(fit: Fit | undefined, win: string): Busy[] {
  if (!fit?.want) return []
  return fit.sessions.filter((b) => b.window === win && !related(fit.want!, b.work, fit.home))
}

const madeWindow = (w: Worker) => w.made?.window ?? w.window

// The places a new worker may go besides a new window, and why the others
// are not offered. Only windows this coordinator made (a fallback window of
// one of its workers) are split besides its own: the person's other windows
// are theirs, the same line its tmux_window_escape policy draws.
// `fit`: a window holding a session on other work is not offered. The
// coordinator's own window is no exception: it holds the coordinator's
// repository's work only.
export function spots(l: Ledger, coord: { pane: string; window: string; width: number; height: number }, boxes: PaneBox[], fit?: Fit): Spots {
  const mine = active(l).filter((w) => w.relation === 'owned')
  const out: Spot[] = []
  const skipped: string[] = []
  const away: Spots['away'] = []
  const label = (win: string) => (fit ? { work: fit.sessions.filter((b) => b.window === win).map((b) => workLabel(b, fit.home)) } : {})
  const elsewhere = (win: string, what: string) => {
    const o = otherWork(fit, win)
    if (!o.length) return false
    const why = what + ' holds other work: ' + o.map((b) => workLabel(b, fit!.home)).join(', ')
    skipped.push(why)
    away.push({ window: win, why })
    return true
  }
  const here = mine.filter((w) => coord.window && madeWindow(w) === coord.window).map((w) => w.slug)
  const split = splitPlan(coord.width, coord.height)
  const mixed = elsewhere(coord.window, 'your window ' + coord.window)
  if (mixed) {
    // said in skipped already
  } else if (here.length >= WINDOW_WORKERS) skipped.push('your window ' + coord.window + ' already holds ' + here.length + ' workers (' + here.join(', ') + ')')
  else if (!split) skipped.push('your pane (' + coord.width + 'x' + coord.height + ') is too small to split with ' + SPLIT_MIN.cols + ' columns or ' + SPLIT_MIN.rows + ' rows left on each side')
  else out.push({ window: coord.window, target: coord.pane, split, kind: 'coordinator', workers: here, ...label(coord.window) })
  const made = [...new Set(mine.filter((w) => w.made?.kind === 'window' && w.made.window !== coord.window).map((w) => w.made!.window))]
  for (const win of made) {
    const panes = boxes.filter((b) => b.window === win)
    if (!panes.length) continue // the window is gone
    if (elsewhere(win, 'window ' + win)) continue
    const there = mine.filter((w) => madeWindow(w) === win).map((w) => w.slug)
    if (there.length >= WINDOW_WORKERS) {
      skipped.push('window ' + win + ' already holds ' + there.length + ' workers (' + there.join(', ') + ')')
      continue
    }
    const big = panes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    const s = splitPlan(big.width, big.height)
    if (!s) skipped.push('window ' + win + "'s largest pane (" + big.width + 'x' + big.height + ') is too small to split')
    else out.push({ window: win, target: big.pane, split: s, kind: 'workers', workers: there, ...label(win) })
  }
  return { spots: out, skipped, away }
}

// What the router is shown: each place by its window id, with the work of
// the sessions in it when known, plus "new".
export type Place = { window: string; kind: 'coordinator' | 'workers' | 'new'; workers?: string[]; work?: string[] }
export function places(s: Spots): Place[] {
  return [...s.spots.map((x) => ({ window: x.window, kind: x.kind, workers: x.workers, ...(x.work ? { work: x.work } : {}) })), { window: 'new', kind: 'new' }]
}

// The place coord_spawn uses for `choice` ("@N", "new" or nothing). A
// choice that is not listed falls back to the first listed place (the
// coordinator's window comes first), else a new window, and says so.
export function pick(choice: string | undefined, s: Spots): { spot?: Spot; note?: string } {
  const c = (choice ?? '').trim()
  if (c === 'new') return {}
  const hit = c ? s.spots.find((x) => x.window === c) : undefined
  if (hit) return { spot: hit }
  const dflt = s.spots[0]
  const why = s.away.find((a) => a.window === c)?.why
  const note = c ? (why ? why + ' (' : 'window ' + c + ' is not a place for a worker now (') + (s.spots.map((x) => x.window).join(', ') || 'none') + ', or new); used ' + (!dflt ? 'a new window' : dflt.kind === 'coordinator' ? 'your window' : 'window ' + dflt.window) + ' instead' : undefined
  return { ...(dflt ? { spot: dflt } : {}), ...(note ? { note } : {}) }
}

// The sessions tmux shows, by window, with their work: a session's cwd, and
// for a worker of this coordinator its code outside the cwd. `works`: what
// coord.ts found in git for each directory.
export function busyOf(seen: readonly { window: string; sid: string; cwd: string }[], l: Ledger, names: ReadonlyMap<string, string>, works: ReadonlyMap<string, Work>): Busy[] {
  const mine = new Map(active(l).map((w) => [w.sid, w]))
  const at = (d: string): Work => works.get(d) ?? { dir: d }
  const out: Busy[] = []
  const done = new Set<string>()
  for (const s of seen) {
    if (done.has(s.sid + s.window)) continue
    done.add(s.sid + s.window)
    const w = mine.get(s.sid)
    const work = [at(s.cwd), ...(w?.code ? [at(w.code)] : []), ...(w?.repo ? [{ dir: '', repo: w.repo }] : [])]
    out.push({ window: s.window, name: s.sid === l.sid ? l.name : (w?.slug ?? names.get(s.sid) ?? s.sid.slice(0, 8)), work })
  }
  return out
}

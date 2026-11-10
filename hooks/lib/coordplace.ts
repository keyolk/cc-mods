// Where coord_spawn puts a worker's pane: a split of the coordinator's pane,
// a split in a window that already holds this coordinator's workers, or a
// new window. Fixed rules list the places first (room after the split, how
// many workers a window already holds); coord_route's one model call then
// picks among them, and coord_spawn checks the pick again against tmux as it
// is at spawn time. A pick that is no listed place falls back to the default:
// the coordinator's window when it is listed, else a new window. Pure:
// coord.ts reads tmux.

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

export type Spot = { window: string; target: string; split: Split; kind: 'coordinator' | 'workers'; workers: string[] }
export type Spots = { spots: Spot[]; skipped: string[] }

const madeWindow = (w: Worker) => w.made?.window ?? w.window

// The places a new worker may go besides a new window, and why the others
// are not offered. Only windows this coordinator made (a fallback window of
// one of its workers) are split besides its own: the person's other windows
// are theirs, the same line its tmux_window_escape policy draws.
export function spots(l: Ledger, coord: { pane: string; window: string; width: number; height: number }, boxes: PaneBox[]): Spots {
  const mine = active(l).filter((w) => w.relation === 'owned')
  const out: Spot[] = []
  const skipped: string[] = []
  const here = mine.filter((w) => coord.window && madeWindow(w) === coord.window).map((w) => w.slug)
  const split = splitPlan(coord.width, coord.height)
  if (here.length >= WINDOW_WORKERS) skipped.push('your window ' + coord.window + ' already holds ' + here.length + ' workers (' + here.join(', ') + ')')
  else if (!split) skipped.push('your pane (' + coord.width + 'x' + coord.height + ') is too small to split with ' + SPLIT_MIN.cols + ' columns or ' + SPLIT_MIN.rows + ' rows left on each side')
  else out.push({ window: coord.window, target: coord.pane, split, kind: 'coordinator', workers: here })
  const made = [...new Set(mine.filter((w) => w.made?.kind === 'window' && w.made.window !== coord.window).map((w) => w.made!.window))]
  for (const win of made) {
    const panes = boxes.filter((b) => b.window === win)
    if (!panes.length) continue // the window is gone
    const there = mine.filter((w) => madeWindow(w) === win).map((w) => w.slug)
    if (there.length >= WINDOW_WORKERS) {
      skipped.push('window ' + win + ' already holds ' + there.length + ' workers (' + there.join(', ') + ')')
      continue
    }
    const big = panes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    const s = splitPlan(big.width, big.height)
    if (!s) skipped.push('window ' + win + "'s largest pane (" + big.width + 'x' + big.height + ') is too small to split')
    else out.push({ window: win, target: big.pane, split: s, kind: 'workers', workers: there })
  }
  return { spots: out, skipped }
}

// What the router is shown: each place by its window id, plus "new".
export type Place = { window: string; kind: 'coordinator' | 'workers' | 'new'; workers?: string[] }
export function places(s: Spots): Place[] {
  return [...s.spots.map((x) => ({ window: x.window, kind: x.kind, workers: x.workers })), { window: 'new', kind: 'new' }]
}

// The place coord_spawn uses for `choice` ("@N", "new" or nothing). A
// choice that is not listed falls back to the default and says so.
export function pick(choice: string | undefined, s: Spots): { spot?: Spot; note?: string } {
  const c = (choice ?? '').trim()
  if (c === 'new') return {}
  const hit = c ? s.spots.find((x) => x.window === c) : undefined
  if (hit) return { spot: hit }
  const dflt = s.spots.find((x) => x.kind === 'coordinator')
  const note = c ? 'window ' + c + ' is not a place for a worker now (' + (s.spots.map((x) => x.window).join(', ') || 'none') + ', or new); used ' + (dflt ? 'your window' : 'a new window') + ' instead' : undefined
  return { ...(dflt ? { spot: dflt } : {}), ...(note ? { note } : {}) }
}

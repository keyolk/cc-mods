// Where coord_spawn puts a worker's pane: the places fixed rules list, the
// router's pick among them, and the fallback when the pick is no place.

import { expect, test } from 'claude-code/testing'

import { closeArgv, emptyLedger, type Ledger, type Limits, type Worker } from '../hooks/lib/coord'
import { BOX_FMT, WINDOW_WORKERS, parseBoxes, pick, places, spots, type PaneBox } from '../hooks/lib/coordplace'
import { checkRoute, routeRequest, routeText } from '../hooks/lib/coordroute'

const NOW = 1_800_000_000_000
const LIMITS: Limits = { models: ['haiku', 'sonnet'], maxEffort: 'high', maxWorkers: 4, autoAdopt: true }
const ledger = (workers: Worker[] = []): Ledger => ({ ...emptyLedger('coord', 'cc-mods-d9', NOW), on: true, limits: LIMITS, workers })
const worker = (slug: string, made: Worker['made']): Worker => ({ slug, sid: 's-' + slug, relation: 'owned', cwd: '/w/' + slug, at: NOW, made, window: made?.window, pane: made?.pane })
// The coordinator's pane %1 in window @1, wide enough to split.
const COORD = { pane: '%1', window: '@1', width: 200, height: 50 }
const BOXES: PaneBox[] = [
  { window: '@1', pane: '%1', width: 200, height: 50 },
  { window: '@7', pane: '%70', width: 240, height: 60 },
  { window: '@7', pane: '%71', width: 80, height: 60 },
  { window: '@9', pane: '%90', width: 240, height: 60 },
]

test('coordplace: tmux panes with their window and size', () => {
  expect(BOX_FMT).toBe('#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}')
  expect(parseBoxes('@1\t%1\t200\t50\n\ngarbage\n@7\t%70\t240\t60')).toEqual([BOXES[0]!, BOXES[1]!])
})

test('coordplace: the coordinator window, and windows it made for its workers, with room and under the worker cap; the person\'s windows never', () => {
  // @9 has no worker of this coordinator: it is the person's, never offered.
  const s = spots(ledger([worker('a', { kind: 'window', pane: '%70', window: '@7' })]), COORD, BOXES)
  expect(s.spots.map((x) => [x.window, x.kind, x.target])).toEqual([['@1', 'coordinator', '%1'], ['@7', 'workers', '%70']])
  // The largest pane of a worker window is the one split.
  expect(s.spots[1]!.workers).toEqual(['a'])
  expect(s.skipped).toEqual([])
  expect(places(s)).toEqual([{ window: '@1', kind: 'coordinator', workers: [] }, { window: '@7', kind: 'workers', workers: ['a'] }, { window: 'new', kind: 'new' }])
})

test('coordplace: a pane too small to split, or a window at the worker cap, is not offered, and says why', () => {
  expect(WINDOW_WORKERS).toBe(2)
  // Live: the coordinator pane was 94x33, so a worker went to a new window.
  const small = spots(ledger(), { ...COORD, width: 94, height: 33 }, BOXES)
  expect(small.spots).toEqual([])
  expect(small.skipped[0]).toContain('your pane (94x33) is too small to split with 60 columns or 15 rows')
  const full = ledger([
    worker('a', { kind: 'pane', pane: '%2', window: '@1' }),
    worker('b', { kind: 'pane', pane: '%3', window: '@1' }),
    worker('c', { kind: 'window', pane: '%70', window: '@7' }),
    worker('d', { kind: 'pane', pane: '%71', window: '@7' }),
  ])
  const s = spots(full, COORD, BOXES)
  expect(s.spots).toEqual([])
  expect(s.skipped).toEqual(['your window @1 already holds 2 workers (a, b)', 'window @7 already holds 2 workers (c, d)'])
  // A worker window that is gone is skipped without a word.
  expect(spots(ledger([worker('e', { kind: 'window', pane: '%5', window: '@5' })]), COORD, BOXES).spots.map((x) => x.window)).toEqual(['@1'])
  // An ended worker no longer counts.
  const ended = ledger([{ ...worker('a', { kind: 'pane', pane: '%2', window: '@1' }), endedAt: NOW }, worker('b', { kind: 'pane', pane: '%3', window: '@1' })])
  expect(spots(ended, COORD, BOXES).spots[0]!.window).toBe('@1')
})

test('coordplace: the pick is used when it is a listed place; "new" is a new window; anything else falls back and says so', () => {
  const s = spots(ledger([worker('a', { kind: 'window', pane: '%70', window: '@7' })]), COORD, BOXES)
  expect(pick('@7', s).spot?.window).toBe('@7')
  expect(pick('new', s)).toEqual({})
  // Nothing chosen: the coordinator's window, as before.
  expect(pick(undefined, s)).toEqual({ spot: s.spots[0] })
  const wrong = pick('@9', s)
  expect(wrong.spot?.window).toBe('@1')
  expect(wrong.note).toBe('window @9 is not a place for a worker now (@1, @7, or new); used your window instead')
  // No place has room: a new window, whatever was picked.
  const none = spots(ledger(), { ...COORD, width: 94, height: 33 }, BOXES)
  expect(pick('@1', none).spot).toBeUndefined()
  expect(pick('@1', none).note).toContain('used a new window instead')
})

test('coord_route: the router sees the places and its window pick is checked; a wrong one is dropped, not an error', () => {
  const room = places(spots(ledger([worker('a', { kind: 'window', pane: '%70', window: '@7' })]), COORD, BOXES))
  const ask = routeRequest('fix tmc', [], LIMITS, 1, room)
  expect(JSON.parse(ask.prompt).places).toEqual(room)
  expect(ask.system).toContain('"window":"<a places window id>|new"')
  const spawn = { action: 'spawn', repo_dir: '/h/src/tmc', model: 'sonnet', effort: 'medium', reason: 'same repo as a' }
  const ok = checkRoute({ ...spawn, window: '@7' }, [], LIMITS, 1, { repoTop: '/h/src/tmc' }, room) as any
  expect(ok.window).toBe('@7')
  expect(routeText(ok)).toContain('coord_spawn repo_dir=/h/src/tmc model=sonnet effort=medium window=@7')
  expect(routeText(checkRoute({ ...spawn, window: 'new' }, [], LIMITS, 1, { repoTop: '/h/src/tmc' }, room) as any)).toContain(', in a new window.')
  const bad = checkRoute({ ...spawn, window: '@9' }, [], LIMITS, 1, { repoTop: '/h/src/tmc' }, room) as any
  expect(bad.action).toBe('spawn')
  expect(bad.window).toBeUndefined()
  expect(routeText(bad)).toContain('Place: the router chose window "@9", not one of @1, @7, new; coord_spawn places it by default.')
  expect(routeText(bad)).not.toContain('window=')
})

test('coord_close: a fallback window another live worker was split into loses only the closing worker\'s pane', () => {
  const a = worker('a', { kind: 'window', pane: '%70', window: '@7' })
  const b = worker('b', { kind: 'pane', pane: '%71', window: '@7' })
  expect(closeArgv(a, { pane: '%1', window: '@1' }, [a, b])).toEqual(['kill-pane', '-t', '%70'])
  expect(closeArgv(b, { pane: '%1', window: '@1' }, [a, b])).toEqual(['kill-pane', '-t', '%71'])
  // Alone in it: the whole window, as before.
  expect(closeArgv(a, { pane: '%1', window: '@1' }, [a])).toEqual(['kill-window', '-t', '@7'])
  // Never the coordinator's own pane, wherever the ledger says it is.
  expect(closeArgv(worker('x', { kind: 'pane', pane: '%1', window: '@7' }), { pane: '%1', window: '@1' }, [a])).toBeUndefined()
})

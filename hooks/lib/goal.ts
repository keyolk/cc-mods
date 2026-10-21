// The session's /goal (cc-bridge.py goal reads it off the transcript): the
// condition Claude Code's Stop hook holds each turn against, and how the
// evaluator judged the last turn. Pure: parse and draw-ready strings.

export type Goal = {
  condition: string
  active: boolean // still being pursued: the Stop hook keeps the session going
  met: boolean
  setAt: number // epoch seconds
  checks: number // evaluations so far
  lastAt: number // the last evaluation, 0 before the first
  reason: string // the evaluator's words on the last turn
  ended: '' | 'met' | 'cleared' | 'error'
  endedAt: number
}

export function parseGoal(raw: any): Goal | null {
  const g = raw?.goal
  if (!g || typeof g.condition !== 'string' || !g.condition) return null
  return {
    condition: g.condition,
    active: !!g.active,
    met: !!g.met,
    setAt: Number(g.setAt) || 0,
    checks: Number(g.checks) || 0,
    lastAt: Number(g.lastAt) || 0,
    reason: String(g.reason ?? ''),
    ended: g.ended === 'met' || g.ended === 'cleared' || g.ended === 'error' ? g.ended : '',
    endedAt: Number(g.endedAt) || 0,
  }
}

// A goal that ended long ago is history, not state: the card shows a finished
// one for an hour, then only the header stops showing it.
export const GOAL_KEEP_MS = 60 * 60_000

export function goalVisible(g: Goal | null, now: number): g is Goal {
  return !!g && (g.active || now - g.endedAt * 1000 < GOAL_KEEP_MS)
}

// The header chip: what the goal is doing, in a word.
export function goalChip(g: Goal): string {
  if (g.active) return g.checks ? '🎯 goal · ' + g.checks + ' checks' : '🎯 goal'
  return g.ended === 'met' ? '🎯 goal met' : g.ended === 'error' ? '🎯 goal stopped' : '🎯 goal cleared'
}

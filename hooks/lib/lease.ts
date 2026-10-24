// One session at a time for work every session would otherwise repeat: the PR
// poll, `claude mcp list`, a credential-change radar. Pure: register.ts keeps
// the lease in a file under ~/.claude/state/cc-mods/lease/ and reads it with
// $.fs on every check. Not $.store: nothing promises that one session's
// $.store.get sees another session's set at once, and the measured PR poll ran
// in 8 sessions within two minutes although the shared cache was fresh.
//
// A failure backs off for everyone, not just the session that saw it: on a bad
// network each of ~37 sessions retrying on its own clock is the load.

export type Lease = {
  by: string // session id of the holder
  until: number // ms: held until then (a run in progress, or the result still fresh)
  fails: number // failures in a row
  failUntil: number // ms: nobody runs before this (backoff)
}

export type LeaseTimes = {
  runMs: number // held while the work runs, so a slow run is not repeated meanwhile
  freshMs: number // held after a success: what the work produced is still fresh
  baseMs: number // first backoff after a failure, doubled per failure in a row
  capMs: number // backoff ceiling
}

export function parseLease(text: string | undefined): Lease | undefined {
  try {
    const j = JSON.parse(text ?? '')
    if (!j || typeof j.by !== 'string' || typeof j.until !== 'number') return undefined
    return { by: j.by, until: j.until, fails: Number(j.fails) || 0, failUntil: Number(j.failUntil) || 0 }
  } catch {
    return undefined
  }
}

// May `sid` run now? Not while backing off, and not while another session holds it.
export function mayRun(l: Lease | undefined, sid: string, now: number): boolean {
  if (!l) return true
  if (l.failUntil > now) return false
  return l.by === sid || l.until <= now
}

export function taken(l: Lease | undefined, sid: string, now: number, t: LeaseTimes): Lease {
  return { by: sid, until: now + t.runMs, fails: l?.fails ?? 0, failUntil: 0 }
}

export function settled(l: Lease, now: number, ok: boolean, t: LeaseTimes): Lease {
  if (ok) return { by: l.by, until: now + t.freshMs, fails: 0, failUntil: 0 }
  const fails = l.fails + 1
  return { by: l.by, until: now, fails, failUntil: now + Math.min(t.baseMs * 2 ** (fails - 1), t.capMs) }
}

// A fixed delay in [0, spanMs) for one session: sessions that see the same
// event at the same moment (the network back, a login) act spread over the
// span instead of together. The same session always gets the same delay.
export function spread(sid: string, spanMs: number): number {
  let h = 2166136261
  for (let i = 0; i < sid.length; i++) h = Math.imul(h ^ sid.charCodeAt(i), 16777619)
  return (h >>> 0) % Math.max(1, spanMs)
}

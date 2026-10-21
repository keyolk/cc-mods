// tmux publishing contract, shared with twm, brd, tmux_neighbors.py and
// ~/.tmux.conf's @cc_icon. The values are unchanged from cc_state.py:
//
//   @cc_state      working | waiting | done
//   @cc_attention  ask | action | none
//   @cc_since      epoch seconds
//   @cc_session    session id (the join key; never join on cwd)
//
// plus pane-scoped copies (@cc_pane_*) because several sessions can share a
// window. New options this mod adds, which no existing reader depends on:
//
//   @cc_ctx     context window percent used, e.g. "42"
//   @cc_agents  running subagents + background tasks, e.g. "2"
//   @cc_policy  "1" when this session has any capability unlocked
//   @cc_auth    "expired" | "soon" | "" — the worst credential state
//
// Every command targets $TMUX_PANE explicitly. A mod's process calls do not
// pass through tmux_pane_guard.py (that guard only sees Claude's Bash), so
// staying inside the session's own window is this module's job.

export type CcState = 'working' | 'waiting' | 'done'
export type Attention = 'ask' | 'action' | 'none'

export type Publish = {
  state?: CcState
  attention?: Attention | null // null leaves it untouched
  session?: string
  extra?: Record<string, string>
}

// argv lists for `tmux`, one per option, all scoped to `pane`. Pure, so the
// exact commands are testable without a tmux server.
export function publishArgv(pane: string, p: Publish, nowSec: number): string[][] {
  const out: string[][] = []
  const win = (k: string, v: string) => out.push(['set-window-option', '-t', pane, k, v])
  const pn = (k: string, v: string) => out.push(['set', '-p', '-t', pane, k, v])
  if (p.state) {
    win('@cc_state', p.state)
    win('@cc_since', String(nowSec))
    pn('@cc_pane_state', p.state)
    pn('@cc_pane_since', String(nowSec))
  }
  if (p.attention) win('@cc_attention', p.attention)
  if (p.session) {
    win('@cc_session', p.session)
    pn('@cc_pane_session', p.session)
  }
  for (const [k, v] of Object.entries(p.extra ?? {})) {
    if (!/^@cc_[a-z_]+$/.test(k)) continue
    out.push(v === '' ? ['set-window-option', '-t', pane, '-u', k] : ['set-window-option', '-t', pane, k, v])
  }
  return out
}

export function clearArgv(pane: string): string[][] {
  return ['@cc_state', '@cc_since', '@cc_attention', '@cc_ctx', '@cc_agents', '@cc_policy', '@cc_auth'].map((k) => [
    'set-window-option',
    '-t',
    pane,
    '-u',
    k,
  ])
}

// Pane ids look like %197. Anything else is refused so a bad env value can't
// turn into a different tmux target.
export function isPaneId(s: string | undefined): s is string {
  return !!s && /^%\d+$/.test(s)
}

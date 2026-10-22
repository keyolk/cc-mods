// What needs the person outside this session, for the bottom of the Now tab:
// other tmux windows' Claude sessions waiting on them (@cc_state/@cc_attention,
// published by every session's cc-mods), and today's to-dos from the dayx
// brief (~/.claude/daily-checkin/dayx-<date>.md). Pure: parse and rank.

export type Elsewhere = {
  window: string // tmux window index:name
  // tmux target to select it: its window id (@12), which stays put when the
  // window is moved to another session; session:index only from a listing
  // without ids.
  target: string
  where: string // session:index, as it reads now
  attention: 'action' | 'ask' | 'idle' | 'working'
  title?: string
  since?: number // epoch seconds the state began
  session?: string // its Claude Code session id (@cc_session), for its identity
}

// `tmux list-windows -a -F '#{session_name}|#{window_index}|#{window_name}|#{@cc_state}|#{@cc_attention}|#{@title}|#{@cc_since}|#{@cc_session}|#{window_id}'`
export function parseWindows(out: string, mySession: string | undefined): Elsewhere[] {
  const rows: Elsewhere[] = []
  for (const line of out.split('\n')) {
    const [sess, idx, name, state, attn, title, since, cc, wid] = line.split('|')
    if (!sess || !idx || !state) continue
    if (mySession && cc === mySession) continue
    // Waiting on the person: a permission or action (action), a question or
    // a finished answer (ask), or nothing in particular (idle). Working ones
    // need nothing from them but are listed last, so their identity can be
    // handed to another session.
    const attention = state === 'working' ? 'working' : attn === 'action' ? 'action' : attn === 'ask' ? 'ask' : state === 'waiting' ? 'idle' : undefined
    if (!attention) continue
    rows.push({ window: idx + ':' + name, target: /^@\d+$/.test(wid ?? '') ? wid! : sess + ':' + idx, where: sess + ':' + idx, attention, title: title || undefined, since: Number(since) || undefined, session: cc || undefined })
  }
  const rank = { action: 0, ask: 1, idle: 2, working: 3 } as const
  return rows.sort((a, b) => rank[a.attention] - rank[b.attention] || (b.since ?? 0) - (a.since ?? 0))
}

export type Todo = { text: string; kind: 'due' | 'open' | 'turn' | 'summary' }

// The dayx brief's sections: "## 오늘 due", "## 열어 둔 일 …", "## 내 차례 …",
// and "## 한눈에" for the one-line summary. "- 없음" (none) lines are skipped.
export function parseBrief(md: string | undefined): Todo[] {
  if (!md) return []
  const out: Todo[] = []
  let kind: Todo['kind'] | undefined
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      const t = h[1]!
      kind = /한눈에/.test(t) ? 'summary' : /due/i.test(t) ? 'due' : /열어 둔|open/i.test(t) ? 'open' : /내 차례|my turn/i.test(t) ? 'turn' : undefined
      continue
    }
    if (line === '---') break
    const item = /^[-*]\s+(.+)$/.exec(line)?.[1]
    if (!kind || !item || /^없음$|^none$/i.test(item)) continue
    out.push({ text: item, kind })
  }
  return out
}

export function since(sec: number | undefined, nowMs: number): string {
  if (!sec) return ''
  const m = Math.max(0, Math.round((nowMs / 1000 - sec) / 60))
  return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'
}

// Bringing another window in front from the cockpit. `select-window` alone
// only changes that window's own session: once windows live in more than one
// tmux session (one was moved), the person's client stays where it is. So
// the clients showing this session's pane are switched to the target, which
// also makes it their current window. Every lookup happens at press time,
// through the pane id: the session this window is in now, not the one
// $TMUX named when Claude started.
const FOCUS_WINDOW = [
  'me=$(tmux display-message -p -t "$0" \'#{session_name}\') || exit 1',
  'tmux list-clients -F \'#{client_name}|#{client_session}\' | while IFS=\'|\' read -r c s; do',
  '  [ "$s" = "$me" ] && tmux switch-client -c "$c" -t "$1"',
  'done',
  'tmux select-window -t "$1"',
].join('\n')

export function focusWindowArgv(pane: string, target: string): string[] {
  return ['sh', '-c', FOCUS_WINDOW, pane, target]
}

// Monitor events in the main conversation (and quiet re-arming, below). Each event a Monitor emits wakes
// the session as a turn of its own (a task-notification), and a PR watch at
// 30s fills the transcript with check-ins that changed nothing. These rules
// decide which of those turns earn a place in the flow; the rest fold to one
// line in the transcript and live in the cockpit's 감시 card.
//
// The model still reads every event: folding is drawing only. Nothing here
// drops a delivery, because a dropped "checks=passing" is how a follow-up
// loop never learns it is done.

export type MonitorEvent = { taskId: string; summary: string; event: string }

export type MonitorState = {
  taskId: string
  summary: string
  last: string // the last event line
  label: string // short reading of it: "checks passing"
  at: number
  quiet: number // events handled without anything worth showing
  acted: number // events that changed something or need the person
  outcome?: string // first line of the last answer
  mattered?: boolean // whether the last event's turn was shown
  pr?: string
  input?: WatchInput // what the Monitor was started with, for a quiet re-arm
  armedAt?: number // when the current task started
  rearms?: number // quiet re-arms so far
  firstTaskId?: string // the id the model's own Monitor call returned
  held?: { from: string; since: number; until: number } // run by the cockpit itself (see holdDeadline)
}

// The Monitor tool's own arguments: re-arming calls it again with these.
export type WatchInput = { description: string; timeout_ms: number; command?: string; ws?: { url: string; protocols?: string[] } }

// A Monitor lives at most 30 minutes. Its expiry notice says nothing but
// "expired" (the events it saw were delivered one by one already), yet it
// woke the session for a turn whose only work was starting the same Monitor
// again and saying nothing changed: four watches over a quiet afternoon were
// most of a transcript. So a long watch (asked for the maximum lifetime) is
// re-armed here, without a turn. A short one is a deadline the model set on
// purpose ("tell me in five minutes"), and its expiry still reaches the model.
export const LONG_WATCH_MS = 1_800_000
// Half a day of 30-minute lives; past that the model decides again.
export const REARM_CAP = 24

// Re-arming still cost one visible row per expiry: the engine prints a
// dropped prompt's reason ("Prompt dropped by a hook: ...") and keeps it in
// the transcript, even for an empty reason, and a local Monitor's expiry never
// passes session.receive, where `consumed` would hide it. So at its first
// expiry a long command watch is taken over: the cockpit runs the same command
// with no 30-minute life, and only its events (and its end) reach the model.
// It is held for what the re-arm cap had left, then the model decides again.
export const HELD_PREFIX = 'cw-'

export function holdDeadline(m: MonitorState, now: number): number {
  return now + Math.max(1, REARM_CAP - (m.rearms ?? 0)) * LONG_WATCH_MS
}

// Shaped as the engine's own notification, so the turn and row hooks that
// fold Monitor events read a held watch's events the same way.
export function heldNotification(taskId: string, summary: string, event: string): string {
  return '<task-notification>\n<task-id>' + taskId + '</task-id>\n<summary>Monitor event: "' + summary + '"</summary>\n<event>' + event + '</event>\n</task-notification>'
}

// Lines complete so far, and the unfinished rest to carry into the next piece.
export function splitLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()), rest }
}

export function watchInput(e: Record<string, unknown>): WatchInput | undefined {
  const timeout = Number(e.timeout_ms)
  if (typeof e.description !== 'string' || !Number.isFinite(timeout)) return undefined
  if (typeof e.command === 'string') return { description: e.description, timeout_ms: timeout, command: e.command }
  const ws = e.ws as WatchInput['ws']
  if (ws && typeof ws.url === 'string') return { description: e.description, timeout_ms: timeout, ws }
  return undefined
}

// The new task's id: the tool's record when it carries one, else the text the
// model reads ("Monitor started (task b3fp96b73, expires in 30m ...").
export function startedTaskId(result: unknown): string | undefined {
  const r = result as { result?: Record<string, unknown>; text?: string } | undefined
  const own = r?.result?.taskId ?? r?.result?.task_id
  if (typeof own === 'string' && own) return own
  return /\(task (\w+)[,)]/.exec(String(r?.text ?? ''))?.[1]
}

export function parseExpiry(text: string): { taskId: string } | undefined {
  const t = text.trim()
  if (!NOTIFICATION.test(t)) return undefined
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(t)?.[1]?.trim()
  if (!taskId || !/<event>\s*\[Monitor expired after\b/.test(t)) return undefined
  return { taskId }
}

export function shouldRearm(m: MonitorState | undefined): m is MonitorState & { input: WatchInput } {
  return !!m?.input && m.input.timeout_ms >= LONG_WATCH_MS && (m.rearms ?? 0) < REARM_CAP
}

export type Weight = 'act' | 'routine'

const NOTIFICATION = /^<task-notification>[\s\S]*<\/task-notification>\s*$/
const MONITOR_SUMMARY = /^Monitor event:\s*"?([\s\S]*?)"?\s*$/

export function parseMonitor(text: string): MonitorEvent | undefined {
  const t = text.trim()
  if (!NOTIFICATION.test(t)) return undefined
  const tag = (name: string) => t.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'))?.[1]?.trim()
  const taskId = tag('task-id')
  const summary = tag('summary') ?? ''
  const event = tag('event')
  const m = summary.match(MONITOR_SUMMARY)
  if (!taskId || event === undefined || !m) return undefined
  return { taskId, summary: m[1]!.trim(), event }
}

function pairs(event: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of event.matchAll(/(\w+)=(\S*)/g)) out[m[1]!] = m[2]!
  return out
}

// What an event says, before the turn that handles it runs. `act` is shown no
// matter what the turn does; `routine` is shown only if the turn turns out to
// matter (see turnMattered).
export function weigh(ev: MonitorEvent): { weight: Weight; label: string; pr?: string } {
  const line = ev.event
  const kv = pairs(line)
  const pr = kv.pr
  const label = (s: string) => s
  if (/^PR_DONE\b/.test(line)) return { weight: 'act', label: label('PR ' + (kv.state ?? 'done').toLowerCase()), pr }
  if (/^PR_ERROR\b/.test(line)) return { weight: 'routine', label: label('lookup failed ' + (kv.reason ?? '')), pr }
  if (/^PR_EVENT\b/.test(line)) {
    const parts: string[] = []
    let weight: Weight = 'routine'
    if (kv.state && kv.state !== 'OPEN') (weight = 'act'), parts.push(kv.state.toLowerCase())
    if (kv.checks) {
      parts.push('checks ' + kv.checks)
      if (kv.checks === 'failing') weight = 'act'
    }
    if (kv.merge) {
      parts.push('merge ' + kv.merge)
      if (kv.merge === 'conflicted' || kv.merge === 'behind') weight = 'act'
    }
    if (kv.decision) {
      parts.push(kv.decision.toLowerCase().replace(/_/g, ' '))
      if (kv.decision === 'CHANGES_REQUESTED' || kv.decision === 'APPROVED') weight = 'act'
    }
    if (kv.unresolved && Number(kv.unresolved) > 0) (weight = 'act'), parts.push(kv.unresolved + ' unresolved')
    if (kv.issue_comments || kv.thread_comments || kv.reviews) parts.push('new comments')
    if (kv.sha && parts.length === 0) parts.push('push ' + kv.sha)
    return { weight, label: parts.join(' · ') || 'PR changed', pr }
  }
  // Any other Monitor: words that usually mean someone should look.
  if (/\b(fail(ed|ure)?|error|panic|fatal|conflict|denied|exited|done|finished|complete[d]?)\b/i.test(line)) return { weight: 'act', label: line }
  return { weight: 'routine', label: line }
}

// Calls that change something outside the conversation: the turn did work.
export function isWrite(tool: string, input: Record<string, unknown>): boolean {
  if (/^(Edit|Write|NotebookEdit|PushNotification|AskUserQuestion)$/.test(tool)) return true
  if (tool !== 'Bash') return /__(create|update|delete|send|post|merge|comment|add|edit|transition)/i.test(tool)
  const cmd = String(input.command ?? '')
  return (
    /\bgit\s+(push|commit|merge|rebase)\b/.test(cmd) ||
    /\bgh\s+pr\s+(comment|review|merge|edit|close|ready)\b/.test(cmd) ||
    /\bgh\s+api\b[\s\S]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)\b/i.test(cmd) ||
    /\bgh\s+api\s+graphql\b[\s\S]*\bmutation\b/.test(cmd)
  )
}

const NEEDS_PERSON = /(\?\s*$|확인(해|이) 필요|결정|승인이 필요|직접|알려 주세요|실패|충돌|conflict|머지(했|됐|되었)|merged|닫혔)/im

export function turnMattered(weight: Weight, wrote: boolean, answer: string): boolean {
  return weight === 'act' || wrote || NEEDS_PERSON.test(answer.trim())
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find((l) => l.length > 0) ?? ''
  )
}

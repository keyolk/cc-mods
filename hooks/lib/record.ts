// What the views draw, collected from events as they happen.
//
// Everything here is pure data in and data out so it can be unit tested and
// shared by register.ts (which owns `$`). The shapes are also what
// `session.end` exports to ~/.claude/outputs/<date>/<sid>.json for ccx, dayx
// and the daily check-in, so treat field names as a contract.

import { clip, words } from './text'
import { jiraKeyPattern, org } from './org'

export type OutputKind = 'pr' | 'artifact' | 'scratch' | 'ticket' | 'slack' | 'link' | 'bg' | 'commit' | 'file' | 'exp'

export type Output = {
  id: string // stable dedupe key: kind + url/path
  kind: OutputKind
  title: string
  url?: string
  path?: string
  at: number
  turnId?: string
  agentId?: string
  // Free-form, kind-specific detail the view shows under the title.
  detail?: string
}

export type FlowKind = 'prompt' | 'conclusion' | 'decision' | 'finding' | 'background' | 'progress'

export type FlowEntry = {
  at: number
  turnId: string
  kind: FlowKind
  text: string
  // Said by a subagent of that turn, not the main loop: its description, and
  // the Workflow run it belongs to (Chat groups and labels these).
  by?: string
  run?: string
}

export type AgentNode = {
  id: string // agentId once known, tool_use_id before
  toolUseId: string
  parentId?: string
  turnId?: string
  type: string
  description: string
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'killed' | 'background'
  startedAt: number
  endedAt?: number
  tokens?: number
  tools: number
  answer?: string
  kind: 'agent' | 'bg' | 'workflow' | 'fork'
  // A Workflow run's node: its run id (agents of the run carry it in
  // agent.spawn's `workflow.runId`) and its background task id (what the
  // task notification that ends it names).
  runId?: string
  taskId?: string
}

// `export const meta = { name: '…', description: '…' }` at the top of a
// Workflow script: what to call the run before its result names it.
export function workflowMeta(script: string | undefined): { name?: string; description?: string } {
  if (!script) return {}
  const head = script.slice(0, 2000)
  const name = /\bname\s*:\s*(['"`])([^'"`]+)\1/.exec(head)?.[2]
  const description = /\bdescription\s*:\s*(['"`])([^'"`]+)\1/.exec(head)?.[2]
  return { name, description }
}

export type TurnRecord = {
  turnId: string
  text: string
  at: number
  endedAt?: number
  tools: Record<string, number>
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

const LINK_URL = /https:\/\/[\w.-]*(?:atlassian\.net\/wiki|grafana[\w.-]*|argocd[\w.-]*|claude\.ai\/(?:code\/)?artifact)[^\s)>"'`\]]*/g

// A PR URL in text is only a mention: a search result, a `gh pr list`, a
// subagent reading an upstream repo. 358 such PRs (third-party repos among
// them) were taken as the session's own and filled Needs you; the session's
// own PRs carry what it did to them (created, edited, merged, ...).
export function prOutputs(text: string, at: number, detail = 'mentioned'): Output[] {
  const out: Output[] = []
  for (const m of text.matchAll(PR_URL)) {
    out.push({ id: 'pr:' + m[1] + '#' + m[2], kind: 'pr', title: m[1] + '#' + m[2], url: m[0], at, detail })
  }
  return out
}

// A ticket is this session's when it made it, the person named it, it was
// worked on (read, edited, moved through the Atlassian tools), or it names a
// branch or PR a command made; `detail` says which. Not every key a tool's
// output happens to print: one `cat` of the Jira skill's cache (its epics)
// put 43 unrelated tickets on the daily session's cockpit, and git logs,
// docs and PR lists did the rest — 728 tickets across 18 sessions.
export function ticketOutputs(text: string, at: number, detail?: string): Output[] {
  const seen = new Set<string>()
  const out: Output[] = []
  const keys = jiraKeyPattern()
  const base = org().jira.baseUrl
  if (!keys) return out
  for (const m of text.matchAll(keys)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    out.push({
      id: 'ticket:' + m[0],
      kind: 'ticket',
      title: m[0],
      ...(base ? { url: base + '/browse/' + m[0] } : {}),
      at,
      ...(detail ? { detail } : {}),
    })
  }
  return out
}

export function linkOutputs(text: string, at: number): Output[] {
  const out: Output[] = []
  for (const m of text.matchAll(LINK_URL)) {
    const url = m[0].replace(/[.,;:]+$/, '')
    const kind: OutputKind = /claude\.ai\/(code\/)?artifact/.test(url) ? 'artifact' : 'link'
    out.push({ id: kind + ':' + url, kind, title: linkTitle(url), url, at })
  }
  return out
}

function linkTitle(url: string): string {
  if (url.includes('slack.com')) return 'Slack · ' + clip(url.split('/archives/')[1] ?? url, 40)
  if (url.includes('atlassian.net/wiki')) return 'Confluence · ' + clip(decodeURIComponent(url.split('/').pop() ?? ''), 50)
  if (/grafana/.test(url)) return 'Grafana · ' + clip(url.replace(/^https:\/\/[^/]+/, ''), 50)
  if (/argocd/.test(url)) return 'ArgoCD · ' + clip(url.replace(/^https:\/\/[^/]+/, ''), 50)
  if (/artifact/.test(url)) return 'Artifact · ' + url.split('/').pop()
  return clip(url, 60)
}

// Slack threads this session touched: a permalink pasted into a prompt, one an
// answer or a tool printed, and the threads Slack tools read or posted to. A
// reply's link (…/p<reply>?thread_ts=<root>) and the root's link are one
// thread, so the id is the root: channel + root ts.
const SLACK_URL = /https:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?[^\s)>"'`\]]*)?/g

// The workspace links are built for when a tool gives only channel + ts
// (org.json's slack.team); without one, such threads are not recorded.
export function slackTeam(): string | undefined {
  return org().slack.team
}

// Channel names learned so far (register.ts fills it from the Slack MCP
// server and $.store), so a thread reads "#team-pr-review"
// instead of its id wherever it is first seen.
const slackNames = new Map<string, string>()
export function setSlackName(channel: string, name: string): void {
  slackNames.set(channel, name)
}
export function slackName(channel: string): string | undefined {
  return slackNames.get(channel)
}

export function slackThread(team: string, channel: string, rootTs: string, at: number, detail?: string): Output {
  const url = 'https://' + team + '.slack.com/archives/' + channel + '/p' + rootTs.replace('.', '')
  const when = new Date(Number(rootTs.split('.')[0]) * 1000)
  const stamp = String(when.getMonth() + 1).padStart(2, '0') + '/' + String(when.getDate()).padStart(2, '0') + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
  return { id: 'slack:' + channel + ':' + rootTs, kind: 'slack', title: (slackNames.get(channel) ?? 'Slack · ' + channel) + ' · ' + stamp, url, at, detail }
}

export function slackOutputs(text: string, at: number): Output[] {
  const out: Output[] = []
  for (const m of text.matchAll(SLACK_URL)) {
    const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(m[0])?.[1]
    out.push(slackThread(m[1]!, m[2]!, thread ?? m[3] + '.' + m[4], at))
  }
  return out
}

// Text-borne outputs: what a prompt, a tool result or an answer mentions.
// `tickets` is the detail its JIRA keys carry, or false to leave them out
// (tool output: a key printed there is not one this session works on).
export function textOutputs(text: string, at: number, tickets: string | false = 'mentioned'): Output[] {
  return [...prOutputs(text, at), ...(tickets === false ? [] : ticketOutputs(text, at, tickets)), ...slackOutputs(text, at), ...linkOutputs(text, at)]
}

// Files an answer hands the person: absolute paths it names, and bare file
// names (`probes.csv` in a table) under a folder it names ("all in
// `/…/tg17043/`"). Often made where no tool input spells the path (a script
// writing into `$O`), and they are what the person acts on next (attach,
// send, open), so they are the session's deliverables. Candidates only:
// register.ts keeps the ones that exist.
export const IN_ANSWER = 'in the answer'
const FILE_EXT = /\.[A-Za-z0-9]{1,8}$/
export function answerFiles(text: string, at: number): Output[] {
  const abs = [...text.matchAll(/(?:^|[\s`'"(|])((?:~|\/)[^\s`'"()|<>*]+)/g)].map((m) => m[1]!.replace(/[.,:;)]+$/, ''))
  const dirs = abs.filter((p) => p.endsWith('/')).map((p) => p.replace(/\/+$/, ''))
  const files = abs.filter((p) => !p.endsWith('/') && FILE_EXT.test(p))
  const bare = dirs.length ? [...text.matchAll(/`([\w.@+-]+\.[A-Za-z0-9]{1,8})`/g)].map((m) => m[1]!).filter((n) => !/^\d+(\.\d+)+$/.test(n)) : []
  const paths = [...new Set([...files, ...dirs.flatMap((d) => bare.map((n) => d + '/' + n))])]
  return paths.map((path) => {
    const kind: OutputKind = isScratch(path) ? 'scratch' : 'file'
    return { id: kind + ':' + path, kind, title: path.split('/').pop() ?? path, path, at, detail: IN_ANSWER }
  })
}

// Outputs kept from before tickets carried their source: a ticket with no
// detail came from anywhere, tool output included, so it is dropped.
export function dropUnsourcedTickets(outs: readonly Output[]): Output[] {
  return outs.filter((o) => o.kind !== 'ticket' || !!o.detail)
}

export function isScratch(path: string): boolean {
  return /\/private\/tmp\/claude-\d+\/[^/]+\/[^/]+\/scratchpad\//.test(path) || /\/scratchpad\//.test(path)
}

// Outputs implied by one tool call and its result. `input` is the tool's
// arguments, `result` what next(e) resolved to (may be { deny }).
export function toolOutputs(tool: string, input: Record<string, unknown>, result: unknown, at: number): Output[] {
  const r = (result ?? {}) as Record<string, unknown>
  if (r.deny) return []
  const rec = (r.result ?? {}) as Record<string, unknown>
  const text = typeof r.text === 'string' ? r.text : ''
  const out: Output[] = []

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const path = String(input.file_path ?? input.notebook_path ?? '')
    if (path) {
      const kind: OutputKind = isScratch(path) ? 'scratch' : 'file'
      out.push({ id: kind + ':' + path, kind, title: path.split('/').pop() ?? path, path, at, detail: tool })
    }
  }

  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    const git = rec.gitOperation as Record<string, any> | undefined
    if (git?.pr?.url) {
      const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(git.pr.url)
      if (m) out.push({ id: 'pr:' + m[1] + '#' + m[2], kind: 'pr', title: m[1] + '#' + m[2], url: git.pr.url, at, detail: git.pr.action })
    }
    if (git?.commit?.sha) {
      out.push({
        id: 'commit:' + git.commit.sha,
        kind: 'commit',
        title: String(git.commit.sha).slice(0, 8) + (git.commit.branch ? ' · ' + git.commit.branch : ''),
        at,
        detail: git.commit.kind,
      })
    }
    if (typeof rec.backgroundTaskId === 'string') {
      out.push({
        id: 'bg:' + rec.backgroundTaskId,
        kind: 'bg',
        title: clip(String(input.description ?? cmd), 60),
        path: typeof rec.persistedOutputPath === 'string' ? rec.persistedOutputPath : undefined,
        at,
        detail: rec.backgroundTaskId,
      })
    }
    // A redirect into the scratchpad is a file the session produced.
    for (const w of words(cmd)) {
      if (w.startsWith('/') && isScratch(w) && /\.[a-z0-9]{1,6}$/i.test(w)) {
        out.push({ id: 'scratch:' + w, kind: 'scratch', title: w.split('/').pop() ?? w, path: w, at, detail: 'Bash' })
      }
    }
    out.push(...textOutputs(String(rec.stdout ?? ''), at, false))
    // A branch, commit or PR title the command itself names its ticket in.
    if (/\bgit\s+(checkout|switch|worktree|branch|commit|push)\b|\bgh\s+pr\s+(create|edit)\b/.test(cmd)) out.push(...ticketOutputs(cmd, at, 'in a branch or PR'))
  }

  if (tool === 'Monitor') {
    const id = String(rec.taskId ?? rec.id ?? input.description ?? '')
    out.push({ id: 'bg:' + id, kind: 'bg', title: clip(String(input.description ?? 'monitor'), 60), at, detail: 'Monitor' })
  }

  if (tool === 'Artifact') {
    const url = typeof rec.url === 'string' ? rec.url : undefined
    if (url) {
      out.push({
        id: 'artifact:' + url,
        kind: 'artifact',
        title: String(rec.title ?? input.title ?? (input.file_path as string | undefined)?.split('/').pop() ?? 'artifact'),
        url,
        at,
        detail: rec.version ? 'v' + rec.version : undefined,
      })
    }
  }

  if (/createJiraIssue$/.test(tool)) out.push(...ticketOutputs(text + ' ' + JSON.stringify(rec), at, 'created'))
  // Worked on: its key is in the call's own input, not the result (a search returns dozens).
  if (/(getJiraIssue|editJiraIssue|transitionJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue)$/.test(tool)) out.push(...ticketOutputs(JSON.stringify(input), at, /get/.test(tool) ? 'read' : 'updated'))
  if (/createConfluencePage$|updateConfluencePage$/.test(tool)) out.push(...linkOutputs(text + ' ' + JSON.stringify(rec), at).map((o) => ({ ...o, detail: /create/.test(tool) ? 'created' : 'updated' })))
  // Slack MCP tools: a thread read or replied to names its channel and root ts
  // in the input; a send returns the message's permalink.
  if (/slack_(read_thread|send_message|send_message_draft|schedule_message)$/.test(tool)) {
    const channel = String(input.channel_id ?? '')
    const root = String(input.thread_ts ?? input.message_ts ?? '')
    const team = slackTeam()
    if (team && /^[A-Z0-9]+$/.test(channel) && /^\d+\.\d+$/.test(root)) out.push(slackThread(team, channel, root, at, /read/.test(tool) ? 'read' : 'replied'))
    else out.push(...slackOutputs(text + ' ' + JSON.stringify(rec), at).map((o) => ({ ...o, detail: 'posted' })))
  }
  if (/^mcp__claude_ai_Claude_Docs__batch$/.test(tool)) out.push(...linkOutputs(text, at))

  return dedupe(out)
}

export function dedupe(list: Output[]): Output[] {
  const seen = new Map<string, Output>()
  for (const o of list) {
    const prev = seen.get(o.id)
    // Keep the first sighting's time; later ones may carry richer detail, but
    // a mention never replaces an act (`gh pr create` prints the URL it made).
    const detail = prev && isMade(prev) && !isMade(o) ? prev.detail : (o.detail ?? prev?.detail)
    seen.set(o.id, prev ? { ...o, at: prev.at, detail } : o)
  }
  return [...seen.values()]
}

// Merge new outputs into an existing list, newest first, bounded.
// Made by this session, or only related to it. A Slack thread, a ticket or a
// link is the session's own only when it acted on it: posted or replied in
// the thread, created or updated the ticket, created or edited the page,
// named the ticket in a branch or PR. One pasted into a prompt, read, or
// mentioned is context for the work, not what it produced: a pasted alert
// thread sat in Outputs as if the session had written it. A PR is the
// session's when it acted on it or the person handed it over in a prompt;
// one only mentioned (or kept from before PRs carried a detail) is not.
// Everything else (artifacts, files, tasks, commits) is made by it.
const MADE_DETAIL = new Set(['created', 'updated', 'replied', 'posted', 'in a branch or PR'])

export function isMade(o: Pick<Output, 'kind' | 'detail'>): boolean {
  if (o.kind === 'slack' || o.kind === 'ticket' || o.kind === 'link') return !!o.detail && MADE_DETAIL.has(o.detail)
  if (o.kind === 'pr') return !!o.detail && o.detail !== 'mentioned'
  return true
}

export function mergeOutputs(prev: readonly Output[], add: readonly Output[], cap = 300): Output[] {
  if (add.length === 0) return prev as Output[]
  const byId = new Map(prev.map((o) => [o.id, o]))
  for (const o of add) {
    const old = byId.get(o.id)
    // A later mention does not undo an act: a thread replied in, then linked
    // in an answer, stays replied in.
    const detail = old && isMade(old) && !isMade(o) ? old.detail : (o.detail ?? old?.detail)
    byId.set(o.id, old ? { ...old, ...o, at: old.at, detail } : o)
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, cap)
}

// Which sessions' `outputs:<sid>` copies to drop from $.store. The store is one
// JSON file for every session on the machine and refuses any set once it is
// over 4 MiB, which would stop every shared cache (radar, PRs) at once. Each
// session's copy is capped (mergeOutputs) and exported to
// ~/.claude/outputs/<date>/<sid>.json, but nothing ever removed one: 170 copies,
// 2 MB, on one machine. Dropped: copies untouched for `maxAgeMs`, then the
// oldest until the copies fit `budget` bytes. The current session is never
// dropped. Not by the session map: it is a shared read-modify-write that can
// miss a session started a moment ago, and it forgets sessions alive past a week.
export function outputKeysToDrop(
  copies: readonly { sid: string; at: number; bytes: number }[],
  current: string,
  now: number,
  maxAgeMs: number,
  budget: number,
): string[] {
  const drop = new Set<string>()
  for (const c of copies) if (c.sid !== current && now - c.at > maxAgeMs) drop.add(c.sid)
  let total = copies.filter((c) => !drop.has(c.sid)).reduce((n, c) => n + c.bytes, 0)
  for (const c of [...copies].sort((a, b) => a.at - b.at)) {
    if (total <= budget) break
    if (c.sid === current || drop.has(c.sid)) continue
    drop.add(c.sid)
    total -= c.bytes
  }
  return [...drop]
}

// Rebuild what the views draw from a transcript the session loaded rather than
// lived through: `claude --resume`, `--continue`, /resume, a fork, or the mod
// loading mid-session. Loads are not appends, so none of the events the live
// path listens to (tool.call, agent.spawn, turn.complete) fire for those rows.
//
// $.session.messages() carries no timestamps, so times come from the
// transcript file when it can be read; a row with no known time gets a small
// sequence number instead (see isKnownTime), which keeps the order and lets
// the views say "earlier" instead of drawing 1970.

import { agentFlow, flowOf } from './flow'
import { dedupe, slackOutputs, textOutputs, ticketOutputs, toolOutputs, type AgentNode, type FlowEntry, type Output, type TurnRecord } from './record'
import { clip } from './text'

export type BackfillUse = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  result?: unknown
  text?: string
  isError?: true
  agentId?: string
  durationMs?: number
}

export type BackfillMessage = { role: string; text: string; toolUses: BackfillUse[]; toolResults?: unknown[] }

export type Stamps = {
  tools: Record<string, number> // tool_use_id -> ms
  prompts: { text: string; at: number }[] // the person's prompts, in order
}

// Anything below this is a sequence number, not an epoch time.
export function isKnownTime(at: number): boolean {
  return at > 1e11
}

const KEY = 120
const promptKey = (s: string) => s.trim().slice(0, KEY)

// One JSON object per line; lines this does not understand are skipped, so a
// transcript format change degrades to "no times", never to a throw.
export function parseStamps(jsonl: string): Stamps {
  const tools: Record<string, number> = {}
  const prompts: { text: string; at: number }[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"timestamp"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(row?.timestamp ?? '')
    if (!Number.isFinite(at) || row?.isSidechain) continue
    const content = row?.message?.content
    if (row.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use' && typeof b.id === 'string') tools[b.id] = at
    } else if (row.type === 'user' && !row.isMeta) {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result')
            ? content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n')
            : ''
      if (text.trim()) prompts.push({ text: promptKey(text), at })
    }
  }
  return { tools, prompts }
}

export function isHumanPrompt(m: BackfillMessage): boolean {
  return m.role === 'user' && !!m.text && !m.text.startsWith('<') && m.toolUses.length === 0 && !m.toolResults?.length
}

const NOTE = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

// answers: each turn's last text, whole, for the Chat tab's reader.
export type Rebuilt = { flow: FlowEntry[]; turns: TurnRecord[]; outputs: Output[]; agents: AgentNode[]; answers: Record<string, string> }

// `live`: whether background work the transcript started can still be running
// in this process. A resumed or forked process cannot hold the old process's
// tasks, so an unfinished one there is drawn as killed, not as running.
export function rebuild(msgs: readonly BackfillMessage[], stamps: Stamps = { tools: {}, prompts: [] }, live = true): Rebuilt {
  const flow: FlowEntry[] = []
  const answers: Record<string, string> = {}
  const turns: TurnRecord[] = []
  const outputs: Output[] = []
  const agents: AgentNode[] = []
  // How background tasks ended, from the task notifications the harness posted.
  const ended = new Map<string, string>()
  for (const m of msgs) if (m.role === 'user') for (const n of m.text.matchAll(NOTE)) ended.set(n[1]!, n[2]!)

  const prompts = [...stamps.prompts]
  let seq = 0
  let last = 0 // the newest time seen, so an unstamped row sorts after it
  const tick = () => (last = isKnownTime(last) ? last + 1 : ++seq)
  const stamp = (at: number | undefined) => (at !== undefined && at >= last ? (last = at) : tick())

  let turnId = ''
  let t = 0
  for (const m of msgs) {
    if (isHumanPrompt(m)) {
      const key = promptKey(m.text)
      const i = prompts.findIndex((p) => p.text === key)
      const at = stamp(i >= 0 ? prompts.splice(0, i + 1).at(-1)!.at : undefined)
      const prev = turns.at(-1)
      if (prev && prev.endedAt === undefined) prev.endedAt = at
      turnId = 'bf-' + ++t
      flow.push({ at, turnId, kind: 'prompt', text: clip(m.text, 280) })
      turns.push({ turnId, text: clip(m.text, 200), at, tools: {} })
      outputs.push(...slackOutputs(m.text, at).map((o) => ({ ...o, detail: 'from your prompt', turnId })))
      outputs.push(...ticketOutputs(m.text, at, 'from your prompt').map((o) => ({ ...o, turnId })))
      continue
    }
    if (m.role !== 'assistant' || !turnId) continue
    const tr = turns.at(-1)!
    for (const u of m.toolUses) {
      const at = stamp(stamps.tools[u.tool_use_id])
      tr.tools[u.tool] = (tr.tools[u.tool] ?? 0) + 1
      if (!u.isError) {
        const r = { result: u.result, text: u.text ?? '' }
        outputs.push(...toolOutputs(u.tool, u.input, r, at).map((o) => ({ ...o, turnId })))
      }
      const node = agentOf(u, turnId, at, ended, live)
      if (node) agents.push(node)
      // A foreground subagent's answer came back in its tool result: its
      // decisions and findings, as live (register.ts turn.complete).
      if (node?.kind === 'agent' && node.answer) flow.push(...agentFlow(node.answer, turnId, at, node.description || node.type))
    }
    if (m.text) {
      const at = isKnownTime(last) ? last : tick()
      flow.push(...flowOf(m.text, turnId, at, 4))
      answers[turnId] = m.text
      outputs.push(...textOutputs(m.text, at).map((o) => ({ ...o, turnId })))
    }
  }
  // The newest turn ended when its last row did, unless it is still going.
  const tail = turns.at(-1)
  if (tail && tail.endedAt === undefined && isKnownTime(last)) tail.endedAt = last

  return { flow, turns, outputs: dedupe(outputs).sort((a, b) => b.at - a.at), agents, answers: capAnswers(answers) }
}

function agentOf(u: BackfillUse, turnId: string, at: number, ended: Map<string, string>, live: boolean): AgentNode | undefined {
  const status = (s: string | undefined, fallback: AgentNode['status']): AgentNode['status'] =>
    s === undefined ? (live ? fallback : 'killed') : /fail|error/.test(s) ? 'failed' : /kill|stop/.test(s) ? 'killed' : 'completed'
  const base = { toolUseId: u.tool_use_id, turnId, startedAt: at, tools: 0 }

  if (u.tool === 'Agent' || u.tool === 'Task') {
    const input = u.input
    const answered = u.text !== undefined
    const bg = input.run_in_background === true
    return {
      ...base,
      id: u.agentId ?? u.tool_use_id,
      type: String(input.subagent_type || 'agent'),
      description: String(input.description || clip(String(input.prompt ?? ''), 60)),
      prompt: clip(String(input.prompt ?? ''), 4000),
      // An unanswered call in a loaded transcript was cut off by the exit; a
      // background launch is answered at once and finishes by notification.
      status: u.isError ? 'failed' : bg ? status(ended.get(u.agentId ?? ''), 'background') : answered ? 'completed' : 'killed',
      endedAt: u.durationMs !== undefined ? at + u.durationMs : undefined,
      answer: bg ? undefined : clip(u.text ?? '', 2000),
      kind: 'agent',
    }
  }
  const rec = (u.result ?? {}) as Record<string, unknown>
  if (u.tool === 'Bash' && typeof rec.backgroundTaskId === 'string') {
    const cmd = String(u.input.command ?? '')
    return {
      ...base,
      id: 'bg:' + rec.backgroundTaskId,
      type: 'bg',
      description: clip(String(u.input.description ?? cmd), 60),
      prompt: clip(cmd, 1000),
      status: status(ended.get(rec.backgroundTaskId), 'background'),
      kind: 'bg',
    }
  }
  if (u.tool === 'Monitor' && !u.isError) {
    const id = String(rec.taskId ?? rec.id ?? '')
    return {
      ...base,
      id: 'mon:' + u.tool_use_id,
      type: 'monitor',
      description: clip(String(u.input.description ?? 'monitor'), 60),
      prompt: clip(String(u.input.command ?? ''), 1000),
      status: status(ended.get(id), 'background'),
      kind: 'bg',
    }
  }
  return undefined
}

// ~/.claude/projects/<cwd, every non-alphanumeric as '-'>/<sid>.jsonl
export function transcriptPath(home: string, cwd: string, sid: string): string {
  return home + '/.claude/projects/' + cwd.replace(/[^a-zA-Z0-9]/g, '-') + '/' + sid + '.jsonl'
}

// The Chat tab keeps each turn's answer whole (the flow keeps paragraphs, and
// drops tables and code), bounded so $.state stays small: the newest turns,
// each cut at ANSWER_MAX characters.
export const ANSWER_TURNS = 40
export const ANSWER_MAX = 30_000

export function capAnswers(a: Record<string, string>): Record<string, string> {
  const keys = Object.keys(a).slice(-ANSWER_TURNS)
  return Object.fromEntries(keys.map((k) => [k, a[k]!.length > ANSWER_MAX ? a[k]!.slice(0, ANSWER_MAX) + '\n\n…(cut at ' + ANSWER_MAX + ' characters)' : a[k]!]))
}

// What this session's narwhal runs need from the person, for the Now tab.
//
// A run started through the narwhal MCP tools records the session that
// started it (its origin). The narwhal daemon answers
// GET /api/v1/control/attention?session=<id> with what those runs need:
// questions for the operator, workers judged stuck, and runs that finished
// or failed in the last day. A checkpoint's five questions once went
// unanswered because they were only in `narwhal monitor`, which nobody had
// open; this puts them in the cockpit, answerable there.
//
// The session's runs themselves (GET /api/v1/control/runs?session=<id>)
// go to the Work tab, as work this session started, and what they produced
// to Outputs, beside the session's own PRs and files.
//
// Pure: parse the daemon's answer, decide what is new, build the answer
// body. The fetch and the timer are in register.ts.

import { prOutputs, type Output } from './record'


export type NarwhalQuestion = {
  id: number
  task_id: string
  text: string
  assumed?: string
  blocking?: boolean
  options?: string[]
  context?: string
  recommended?: number
  grounds?: string[]
  raised_by?: string
}

export type NarwhalItem = {
  kind: 'question' | 'stuck' | 'done' | 'failed'
  run_id: string
  flow?: string
  request: string
  at: string
  title: string
  question?: NarwhalQuestion
  task_id?: string
  summary?: string
  artifacts?: number
}

// One key per item, stable across polls: a question by its id, a stuck
// task by its id, an ended run once.
export function itemKey(it: NarwhalItem): string {
  if (it.kind === 'question') return it.run_id + '#q' + (it.question?.id ?? 0)
  if (it.kind === 'stuck') return it.run_id + '#stuck:' + (it.task_id ?? '')
  return it.run_id + '#' + it.kind
}

export function parseAttention(body: string | undefined): NarwhalItem[] {
  if (!body) return []
  try {
    const j = JSON.parse(body)
    const items = Array.isArray(j?.items) ? j.items : []
    return items.filter((x: any) => x && typeof x.kind === 'string' && typeof x.run_id === 'string')
  } catch {
    return []
  }
}

// The items to tell the person about now: those not seen before. Seen keys
// are kept by the caller; an item that stops being returned is forgotten
// with them.
export function freshItems(items: NarwhalItem[], seen: string[]): NarwhalItem[] {
  const s = new Set(seen)
  return items.filter((it) => !s.has(itemKey(it)))
}

// The answer to send for one question: an option's text, or what the
// person wrote.
export function answerBody(runId: string, questionId: number, answer: string): string {
  return JSON.stringify({ run_id: runId, answers: [{ id: questionId, answer }] })
}

// The prompt that brings a finished run's result into the conversation.
export function resultPrompt(it: NarwhalItem): string {
  const head = it.kind === 'failed' ? 'narwhal run ' + it.run_id + ' failed' : 'narwhal run ' + it.run_id + ' finished'
  return head + ' (' + it.request + ').' + (it.summary ? ' Its answer starts: ' + it.summary : '') + ' Read its result with narwhal_status and carry on from it.'
}

// The toast for a fresh item.
export function toastFor(it: NarwhalItem): string {
  switch (it.kind) {
    case 'question':
      return 'narwhal asks: ' + (it.question?.text ?? it.title)
    case 'stuck':
      return 'narwhal: ' + it.title
    case 'failed':
      return 'narwhal run failed: ' + it.request
    default:
      return 'narwhal run finished: ' + it.request
  }
}

export type NarwhalTask = {
  id: string
  name?: string
  state: string // pending | ready | dispatched | completed | failed
  model?: string
  started_at?: string
  ended_at?: string
  outcome?: string
}

export type NarwhalRun = {
  run_id: string
  flow?: string
  request: string
  state: string // active | done | failed | cancelled
  started_at: string
  ended_at?: string
  done: number
  failed: number
  running: number
  waiting?: number
  answer?: string
  artifacts: { prs?: string[]; branches?: string[]; commits?: string[]; files?: string[] }
  tasks: NarwhalTask[]
}

export function parseRuns(body: string | undefined): NarwhalRun[] {
  if (!body) return []
  try {
    const j = JSON.parse(body)
    const runs = Array.isArray(j?.runs) ? j.runs : []
    return runs
      .filter((r: any) => r && typeof r.run_id === 'string')
      .map((r: any) => ({ ...r, tasks: Array.isArray(r.tasks) ? r.tasks : [], artifacts: r.artifacts ?? {} }))
  } catch {
    return []
  }
}

// What a session's runs produced, as Outputs: a PR as the session's own PRs
// are (so the PR poller follows it), a file as a scratch file, and the
// run's answer as a document. The detail names the run, since these were
// made by narwhal workers, not this session's turns.
export function runOutputs(runs: readonly NarwhalRun[]): Output[] {
  const out: Output[] = []
  for (const r of runs) {
    const at = Date.parse(r.ended_at || r.started_at) || 0
    const detail = 'narwhal · ' + r.request.slice(0, 60)
    for (const url of r.artifacts.prs ?? []) for (const o of prOutputs(url, at)) out.push({ ...o, detail })
    for (const path of r.artifacts.files ?? []) {
      out.push({ id: 'scratch:' + path, kind: 'scratch', title: path.split('/').pop() || path, path, at, detail })
    }
    if (r.answer && (r.state === 'done' || r.state === 'failed')) {
      out.push({ id: 'narwhal:' + r.run_id, kind: 'artifact', title: 'narwhal result · ' + r.request.slice(0, 60), at, detail: r.answer })
    }
  }
  return out
}

// A run's line in the Work tab: how far it has got.
export function runProgress(r: NarwhalRun): string {
  const total = r.tasks.length
  const bits = [r.done + '/' + total + ' done']
  if (r.running) bits.push(r.running + ' running')
  if (r.failed) bits.push(r.failed + ' failed')
  if (r.waiting) bits.push(r.waiting + ' waiting for you')
  return bits.join(' · ')
}

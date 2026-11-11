// A worker's own status: where its work stands, declared by the worker with
// the `status` tool, not guessed from its pane. Before this the coordinator
// knew only that a worker's turn had ended (`finished its turn`); a turn that
// ended without a READY/QUESTION message left it to read the pane or ask
// again (2026-11-11, several times a day). The record follows Rex's Program
// Status Protocol (OSC 7501, rev 0.4): one current record per session, each
// report replacing the last whole, states idle/working/blocked/done/error and
// a kind for what blocked waits on, so a terminal bridge later needs no
// mapping. Rex has no step/next/needs: they are what a coordinator acts on.
//
// Pure: register.ts registers the tool in a worker session and writes
// ~/.claude/state/office/status/<sid>.json; coord.ts reads those files each
// tick into the ledger (Worker.status), which coord_roster, the turn wakes
// and the office's 지휘 view show.

export const STATES = ['working', 'blocked', 'done', 'error', 'idle'] as const
export type StatusState = (typeof STATES)[number]
// Rex's three, and `wait` for what no person answers: CI, a review, another
// session.
export const KINDS = ['question', 'permission', 'auth', 'wait'] as const
export type StatusKind = (typeof KINDS)[number]
// What a login wait asks of the person, so the office can relay it from its
// 내 차례 row instead of sending the person to the worker's browser pane
// (office/relay.py): a code typed into an input (otp), a button pressed
// (click), or something only the person's device does (device: a passkey, a
// fingerprint), which the office only points at.
export const ASKS = ['otp', 'click', 'device'] as const
export type StatusAsk = (typeof ASKS)[number]

export type Status = {
  state: StatusState
  kind?: StatusKind
  step?: string // the phase it is in, a few words
  next?: string // its next action
  needs?: string // what the person or the coordinator must give (a brief path, a reply)
  progress?: number // 0-100, when known
  msg?: string // one line
  link?: string // a PR URL or a brief path
  // With blocked:auth, where the login waits: the tweb pane (%N), what it
  // asks (ask), the element to fill or press (target, a CSS selector) and,
  // for otp, the button that sends the code (submit; else Enter).
  pane?: string
  ask?: StatusAsk
  target?: string
  submit?: string
  at: number // ms, when it was declared
}

export const STATUS_DIR = '/.claude/state/office/status'

// Field caps: the record rides in every coordinator turn (coord_roster) and
// in an office row; a paragraph there is noise.
const CAP = { step: 60, next: 120, needs: 200, msg: 160, link: 300, target: 200, submit: 200 } as const

export const STATUS_TOOL = {
  name: 'status',
  description:
    'Declare where your work stands, for the coordinator that gave it and the office the person watches (cc-mods). Call it when your state changes (a new phase, blocked on someone, done, failed) and before you end every turn. Each call replaces the last one whole: give every field that still holds. ' +
    'state: working (going on: a phase, or waiting on something that will wake you), blocked (cannot go on until someone acts; set kind), done (finished: link the PR or brief), error (failed and cannot go on), idle (nothing to do). ' +
    'kind, with blocked: question (the person must decide: needs = the decision brief path), permission (a dialog or a policy gate), auth (a login or a lost connection), wait (CI, a review, another session). ' +
    'step: the phase, a few words. next: your next action. needs: what the person or the coordinator must give. progress: 0-100 when you know it. msg: one line. link: a PR URL or a brief path. ' +
    'With blocked:auth on a page in a tweb pane, also give pane (its id, %N), ask (otp: a code to type; click: a button to press; device: a passkey or fingerprint on the person\'s device) and, for otp and click, target (the CSS selector of the code input or of the button) and for otp optionally submit (the selector of the button that sends the code): the person then answers from the office without going to your pane. ' +
    'It does not replace your READY / QUESTION / BLOCKED message to the coordinator: send those as before.',
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: [...STATES] },
      kind: { type: 'string', enum: [...KINDS] },
      step: { type: 'string' },
      next: { type: 'string' },
      needs: { type: 'string' },
      progress: { type: 'number' },
      msg: { type: 'string' },
      link: { type: 'string' },
      pane: { type: 'string' },
      ask: { type: 'string', enum: [...ASKS] },
      target: { type: 'string' },
      submit: { type: 'string' },
    },
    required: ['state'],
  },
}

const one = (v: unknown, n: number): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : undefined
}

// The tool's arguments (spread on the call event, as Bash's command is) as a
// record, or why it is refused. A wrong state is refused, not stored as
// something else: as in Rex, an unknown state must not read as idle.
export function parseStatus(i: any, now: number): Status | string {
  const state = String(i?.state ?? '')
  if (!(STATES as readonly string[]).includes(state)) return 'state must be one of ' + STATES.join(', ')
  const kind = i?.kind == null || i.kind === '' ? undefined : String(i.kind)
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) return 'kind must be one of ' + KINDS.join(', ')
  if (kind && state !== 'blocked') return 'kind goes only with state blocked'
  if (state === 'blocked' && !kind) return 'blocked needs a kind: ' + KINDS.join(', ')
  let progress: number | undefined
  if (i?.progress != null && i.progress !== '') {
    const p = Number(i.progress)
    if (!Number.isFinite(p) || p < 0 || p > 100) return 'progress is 0 to 100'
    progress = Math.round(p)
  }
  const s: Status = { state: state as StatusState, at: now }
  if (kind) s.kind = kind as StatusKind
  for (const k of ['step', 'next', 'needs', 'msg', 'link'] as const) {
    const v = one(i?.[k], CAP[k])
    if (v) s[k] = v
  }
  if (progress !== undefined) s.progress = progress
  const relay = parseRelay(i, s)
  if (typeof relay === 'string') return relay
  Object.assign(s, relay)
  return s
}

// The relay fields of a login wait (pane, ask, target, submit), or why they
// are refused. They mean something only with blocked:auth; a pane is a tmux
// pane id, and otp/click name the element the office acts on.
function parseRelay(i: any, s: Status): Pick<Status, 'pane' | 'ask' | 'target' | 'submit'> | string {
  const pane = one(i?.pane, 16), ask = one(i?.ask, 16), target = one(i?.target, CAP.target), submit = one(i?.submit, CAP.submit)
  if (!pane && !ask && !target && !submit) return {}
  if (s.state !== 'blocked' || s.kind !== 'auth') return 'pane, ask, target and submit go only with state blocked, kind auth'
  if (!pane || !/^%\d+$/.test(pane)) return 'pane is a tmux pane id such as %601'
  if (!ask || !(ASKS as readonly string[]).includes(ask)) return 'ask must be one of ' + ASKS.join(', ')
  if (ask !== 'device' && !target) return 'ask ' + ask + ' needs target: the CSS selector of the ' + (ask === 'otp' ? 'code input' : 'button')
  const out: Pick<Status, 'pane' | 'ask' | 'target' | 'submit'> = { pane, ask: ask as StatusAsk }
  if (target && ask !== 'device') out.target = target
  if (submit && ask === 'otp') out.submit = submit
  return out
}

// A status file as written (a missing or broken one: none).
export function parseStatusFile(json: string | undefined): Status | undefined {
  try {
    const d = JSON.parse(json ?? '')
    const s = parseStatus(d, Number(d?.at) || 0)
    return typeof s === 'string' ? undefined : s
  } catch {
    return undefined
  }
}

// One line for the coordinator: `blocked:question · brief 대기 · needs … · next … · 60%`.
// `|` is taken out: the line sits in a markdown table (coord_roster).
export function statusLine(s: Status): string {
  return [
    s.state + (s.kind ? ':' + s.kind : ''),
    s.step,
    s.progress !== undefined ? s.progress + '%' : undefined,
    s.needs ? 'needs ' + s.needs : undefined,
    s.next ? 'next ' + s.next : undefined,
    s.msg,
    s.link,
    s.ask ? 'relay ' + s.ask + ' ' + s.pane : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
    .replace(/\|/g, '/')
}

// Whether two records say the same (the time aside): the ledger is saved
// only when a worker's status changed.
export function sameStatus(a?: Status, b?: Status): boolean {
  if (!a || !b) return a === b
  return statusLine(a) === statusLine(b) && a.at === b.at
}

// This session as a worker, from the coordinators' ledgers (one JSON text
// each): the coordinator and the slug it knows it by, when a coordinator
// that is on lists it as a worker it gave work to (owned, or adopted and
// instructed) and has not ended. An adopted session the coordinator never
// instructed is the person's own: no tool, no self-check.
export function workerOf(ledgers: readonly string[], sid: string): { coord: string; slug: string } | undefined {
  for (const t of ledgers) {
    let d: any
    try {
      d = JSON.parse(t)
    } catch {
      continue
    }
    if (!d?.on || !Array.isArray(d.workers) || d.sid === sid) continue
    const w = d.workers.find((x: any) => x?.sid === sid && !x.endedAt && (x.relation === 'owned' || x.instructed))
    if (w) return { coord: String(d.sid), slug: String(w.slug ?? '') }
  }
  return undefined
}

// The prompt a worker gets when its turn ended without a status call. It is
// a turn of its own; that turn never asks again (selfCheckDue `selfTurn`).
export const SELF_CHECK_PROMPT =
  '[cc-mods] Your turn ended without a `status` call. Call the status tool once now with where this work stands (state, step, next; with blocked its kind and needs), then end your turn. Do not redo or continue the work in this turn, and send nothing to the coordinator for this.'

// A worker asked this many times in a row without ever calling status is not
// asked again until it does: the asking must not become the work.
export const SELF_CHECK_MAX = 2

// Whether the turn that just ended should be followed by the self-check:
// a worker's main turn (not aborted, not itself the self-check), the tool
// already there when the turn started (a turn without it was not asked to
// call it), and no status declared since the turn started.
export function selfCheckDue(o: { worker: boolean; toolAt?: number; turnAt: number; statusAt?: number; selfTurn: boolean; aborted: boolean; streak: number }): boolean {
  if (!o.worker || o.aborted || o.selfTurn || o.streak >= SELF_CHECK_MAX) return false
  if (o.toolAt === undefined || o.toolAt > o.turnAt) return false
  return o.statusAt === undefined || o.statusAt < o.turnAt
}

// The fork offer (Jev thinks a prompt starts a separate line of work) and what
// answering it does depends on when the person answers:
//
// - while this session is still on that prompt: the fork *moves* it — this
//   session's turn is stopped, the new pane picks the request up;
// - after this session answered it: the fork *continues* that topic in a new
//   pane, and this session sets it aside.
//
// Before, both cases resubmitted the original prompt in the fork. Answered
// late, the new pane asked again what the transcript it inherited had already
// answered, and the old session kept the topic too: two panes on one thing.
// Pure: the offer, its phase, and the words each side gets.

import type { TurnRecord } from './record'

export type ForkOffer = {
  prompt: string
  p: number
  at: number // when it was offered
  later: number // prompts the person sent since: past a few, the moment is gone
}

export type ForkPhase = { kind: 'running'; turnId: string } | { kind: 'answered' } | { kind: 'unknown' }

// Offers outlive this many later prompts; after that the work has moved on.
export const FORK_STALE_AFTER = 3

// Where the prompt's turn stands: the newest main turn with that text.
export function forkPhase(offer: ForkOffer, turns: readonly TurnRecord[]): ForkPhase {
  const t = [...turns].reverse().find((x) => x.text === offer.prompt)
  if (!t) return { kind: 'unknown' }
  return t.endedAt === undefined ? { kind: 'running', turnId: t.turnId } : { kind: 'answered' }
}

// What a press does now, in a line, under the offer.
export function forkEffect(phase: ForkPhase): string {
  return phase.kind === 'running'
    ? 'fork moves this request to a new pane and stops it here'
    : phase.kind === 'answered'
      ? 'answered here already: fork carries this topic on in a new pane, and this session sets it aside'
      : 'fork opens a new pane with this request'
}

// The fork's first prompt. It inherits the whole conversation, so it is told
// which part is now its own instead of being asked the same thing again.
export function forkPrompt(offer: ForkOffer, phase: ForkPhase): string {
  const q = offer.prompt.trim()
  if (phase.kind === 'running')
    return '(이 pane은 원래 세션에서 갈라져 나온 fork다.) 원래 세션은 아래 요청을 처리하다가 멈췄고, 이 요청은 이제 이 pane에서 맡는다. 멈춘 지점부터 이어서 처리한다.\n\n' + q
  if (phase.kind === 'answered')
    return '(이 pane은 원래 세션에서 갈라져 나온 fork다.) 아래 요청에 대한 답은 대화에 이미 있다. 이 주제는 이제 이 pane에서 이어 간다. 다음 단계가 분명하면 진행하고, 아니면 지금 상태를 짧게 정리하고 다음 지시를 기다린다.\n\n' + q
  return q
}

// What this session reads about the moved topic, once, in its system prompt:
// another pane owns it now.
export function movedSection(moved: readonly { prompt: string; pane: string }[]): string {
  return (
    '# Moved to fork panes\n' +
    moved.map((m) => '- tmux pane ' + m.pane + ': ' + m.prompt.replace(/\s+/g, ' ').slice(0, 160)).join('\n') +
    '\nThese lines of work continue in those panes. Do not pick them up here unless the user asks.'
  )
}

export function forkAge(offer: ForkOffer, now: number): string {
  const m = Math.round((now - offer.at) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ago'
}

// The moved request, set aside in this session's transcript: once the fork
// pane holds it, the request and everything this session did on it (up to the
// person's next prompt) is one exchange saying where it went. Kept twice, the
// topic weighs on every later turn here and invites picking it back up.
//
// Only the span is rebuilt; every message around it is returned as received,
// its engine handle intact, so the prompt cache holds up to the span. Null
// when the request is not in the transcript (nothing to set aside).

type Msg = { role: 'user' | 'assistant'; text: string; toolUses: readonly unknown[]; toolResults?: readonly unknown[]; handle?: string }

// A prompt the person typed: a user message with text and no tool results.
// The engine's interrupt notice is not one; it closes the span it stopped.
const isPrompt = (m: Msg) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== '' && !/^\[Request interrupted/.test(m.text.trim())

export function setAsideMoved<M extends Msg>(messages: readonly M[], moved: { prompt: string; pane: string }): (M | Msg)[] | null {
  const q = moved.prompt.trim()
  const start = messages.findLastIndex((m) => isPrompt(m) && m.text.includes(q))
  if (start < 0) return null
  const next = messages.findIndex((m, i) => i > start && isPrompt(m))
  const end = next < 0 ? messages.length : next
  const brief = q.replace(/\s+/g, ' ').slice(0, 160)
  return [
    ...messages.slice(0, start),
    { role: 'user', text: brief, toolUses: [] },
    { role: 'assistant', text: '(이 요청은 tmux pane ' + moved.pane + '의 fork로 옮겼다. 여기서는 다루지 않는다.)', toolUses: [] },
    ...messages.slice(end),
  ]
}

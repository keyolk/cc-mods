// Turn an answer into flow entries: the conclusion, decisions, findings,
// background, and progress chatter, with no tool calls.
//
// Rule-based on purpose. The answers this classifies follow a fixed house
// style (conclusion first, `##` headings that state a claim, short paragraphs),
// so the first paragraph and the headings carry most of the signal for free.
// A model call is only worth it for what the rules leave as `background`, and
// register.ts decides whether to spend one.

import { clip } from './text'
import type { FlowEntry, FlowKind } from './record'

// Lines that report what is happening rather than what was concluded. These
// are what make a long transcript hard to skim, so they fold by default.
const PROGRESS = /(하는 중입니다|하겠습니다|확인합니다|기다리(고 있|는 중)|진행합니다|시작합니다|살펴보겠|보겠습니다|I'll |Let me |Checking|Now )/

const DECISION = /(추천|제안|결정|선택|우선순위|하기로|으로 (가|간)다|should|recommend|decid)/i
const FINDING = /(발견|원인|확인했|확인 결과|측정|실측|드러났|밝혀|\d+건|exit \d|found|root cause|measured)/i

export function classifyParagraph(p: string): FlowKind {
  if (PROGRESS.test(p) && p.length < 160) return 'progress'
  if (DECISION.test(p)) return 'decision'
  if (FINDING.test(p)) return 'finding'
  return 'background'
}

// Split markdown into the units a reader skims: headings with the paragraph
// under them, and free paragraphs. Code blocks and tables are dropped; they are
// evidence, not flow.
export function paragraphs(md: string): string[] {
  const noCode = md.replace(/```[\s\S]*?```/g, ' ')
  const out: string[] = []
  // Paragraphs that were a heading line and nothing else. Only these fold into
  // the next paragraph; a heading with its own body stays as it is.
  const lone = new Set<number>()
  let cur: string[] = []
  const flush = () => {
    const t = cur.join(' ').replace(/\s+/g, ' ').trim()
    if (t) {
      if (cur.length === 1 && t.startsWith('§ ')) lone.add(out.length)
      out.push(t)
    }
    cur = []
  }
  for (const raw of noCode.split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('|')) continue
    if (/^#{1,6}\s/.test(line)) {
      flush()
      cur.push(line.replace(/^#{1,6}\s+/, '§ '))
      continue
    }
    cur.push(line.replace(/^[-*]\s+|^\d+\.\s+/, '· '))
  }
  flush()
  // A heading followed by a blank line arrives alone; fold it into the next
  // paragraph as its label, so it does not take a row (and get classified)
  // twice. Live: "§ 원인 확인 결과" showed as its own ⚠ 발견 row.
  const merged: string[] = []
  for (let i = 0; i < out.length; i++) {
    const p = out[i]!
    const next = out[i + 1]
    if (lone.has(i) && next !== undefined && !lone.has(i + 1)) {
      merged.push(p + ' — ' + next)
      i++
    } else merged.push(p)
  }
  return merged
}

// A paragraph is kept whole up to this many characters: the row shows one line
// and the selected entry shows all of it, so cutting it here (280/220 before)
// left no way to read a long finding or decision. The cap only bounds what
// $.state holds.
export const FLOW_TEXT_MAX = 4000

export function flowOf(answer: string, turnId: string, at: number, maxPer = 10): FlowEntry[] {
  const ps = paragraphs(answer)
  if (ps.length === 0) return []
  const entries: FlowEntry[] = []
  // The house style puts the conclusion first, so the first paragraph is it
  // unless it is pure progress chatter.
  const [first = '', ...rest] = ps
  entries.push({ at, turnId, kind: PROGRESS.test(first) && first.length < 160 ? 'progress' : 'conclusion', text: clip(first, FLOW_TEXT_MAX) })
  for (const p of rest) {
    if (entries.length >= maxPer) break
    // Headings are the author's own summary of each section: always keep.
    const kind = p.startsWith('§ ') ? (DECISION.test(p) ? 'decision' : FINDING.test(p) ? 'finding' : 'background') : classifyParagraph(p)
    entries.push({ at, turnId, kind, text: clip(p, FLOW_TEXT_MAX) })
  }
  return entries
}

// What a subagent's answer adds to the Chat flow: its conclusion and the
// decisions and findings in it, under the main turn that started it, marked
// with who said it. Progress and background are the subagent's own business;
// a Workflow fans out to many agents, so each keeps at most `max`.
export function agentFlow(answer: string, turnId: string, at: number, by: string, run?: string, max = 4): FlowEntry[] {
  return flowOf(answer, turnId, at, 12)
    .filter((e) => e.kind === 'conclusion' || e.kind === 'decision' || e.kind === 'finding')
    .slice(0, max)
    .map((e) => ({ ...e, by, ...(run ? { run } : {}) }))
}

export const FLOW_ICON: Record<FlowKind, string> = {
  prompt: '❯',
  conclusion: '◆',
  decision: '▶',
  finding: '⚠',
  background: '·',
  progress: '…',
}

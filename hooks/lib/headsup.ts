// What a worker's own screen and last answer say that the coordinator would
// otherwise never hear. Pure: hooks/coord.ts does the reads.
//
// 1. A "Heads up" band. Claude Code's built-in side agent
//    (cc-plugin-you-should-know) draws a note above the prompt box when it
//    finds a problem in the session's work:
//      ✦ Heads up · <sentence, wrapped over several rows>
//        1 Learn more  2 Knew this already  3 What is this  0 Dismiss
//    The plugin API gives no event for it, so it is read off the pane
//    (tmux capture-pane). Only the band itself counts: the star at the start
//    of the row, and its choice row (Learn more … Dismiss) right under it.
//    "Heads up ·" quoted in the chat's scrollback (a session that talks
//    about an earlier one) has neither.
//    Its "You should know" sibling explains a concept; it is not about the
//    work, so it is left out.
//
// 2. A question in a turn's last answer. A worker that ends its turn on
//    "정해 주세요" or "할까요?" without a decision brief or a blocked:question
//    status asks the person in a pane nobody may look at; the coordinator
//    hears only "finished its turn" (live, 2026-11-12: "남은 결정은 하나입니다.
//    … 정해 주세요" sat in luther-dp-onboarding's pane).

const STAR = '✦'
const BAND = /^\s*✦\s+Heads[\s-]*up\s*·\s*(.*)$/
// The band's choice row: Dismiss is always there, with Learn more or the
// first choice before it.
const CHOICES = /\bDismiss\b/
const CHOICE_HEAD = /\b(Learn more|Knew this already|Understood)\b/
const FRAME = /^[│┃║\s]+|[│┃║\s]+$/g
// A side panel beside the chat pads a row and draws its own text after a
// bar: the row ends at the first bar after a wide gap.
const PANEL = /\s{3,}[│┃║].*$/
export const HEADSUP_MAX = 240

const bare = (l: string) => l.replace(PANEL, '').replace(FRAME, '').trim()

// The Heads up sentence on this screen, on one line; undefined when no band
// is drawn. Only the bottom of the screen is read: the band sits right above
// the prompt box.
export function parseHeadsUp(screen: string): string | undefined {
  const rows = screen.split('\n').map((l) => l.replace(PANEL, '').trimEnd())
  // capture-pane pads a screen that is not full with blank rows below.
  while (rows.length && !rows[rows.length - 1]) rows.pop()
  const tail = rows.slice(-40)
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = BAND.exec(tail[i]!)
    if (!m) continue
    const body = [m[1]!.trim()]
    let j = i + 1
    // The sentence wraps onto the rows below it (indented under the star)
    // until the choice row.
    for (; j < tail.length && j < i + 12; j++) {
      const r = tail[j]!
      // The choice row; on a narrow pane it wraps, Dismiss a row or two on.
      if (CHOICE_HEAD.test(r) && tail.slice(j, j + 3).some((x) => CHOICES.test(x))) break
      if (!r.trim() || r.includes(STAR)) {
        j = tail.length
        break
      }
      body.push(bare(r))
    }
    if (j >= tail.length || j >= i + 12) continue // no choice row: not the band
    const text = body.join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > HEADSUP_MAX ? text.slice(0, HEADSUP_MAX - 1) + '…' : text
  }
  return undefined
}

// How a turn's last answer asks the person, read from its last paragraph.
// A question asked inside the work (a list item, a quoted message) is not
// the turn's ask; the last paragraph is.
const ASKS = [
  /정해\s*주세요/,
  /골라\s*주세요/,
  /알려\s*주세요/,
  /확인해\s*주세요/,
  /결정해\s*주세요/,
  /답해\s*주세요/,
  /(할|될|갈|볼|낼|둘|올릴|보낼|넣을|진행할|열|쓸)까요\s*[?？]?/,
  /(하시겠|원하시)(어요|습니까|나요)\s*[?？]?/,
  /\b(shall|should) I\b/i,
  /\bdo you want me to\b/i,
  /\bwould you like\b/i,
  /\blet me know\b/i,
  /[?？]\s*$/,
]
export const ASK_MAX = 200

// The sentence the turn's answer ends on asking the person, or undefined.
export function endsAsking(text: string): string | undefined {
  const paras = text
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const last = paras[paras.length - 1]
  if (!last) return undefined
  // A table or a heading closes the answer: nothing asked.
  if (/^(\||#)/.test(last)) return undefined
  const lines = last.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean)
  const hit = [...lines].reverse().find((l) => ASKS.some((r) => r.test(l)))
  if (!hit) return undefined
  // The one sentence that asks, out of its line.
  const sentences = hit.split(/(?<=[.!?？。])\s+/)
  const s = [...sentences].reverse().find((x) => ASKS.some((r) => r.test(x))) ?? hit
  const one = s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  return one.length > ASK_MAX ? one.slice(0, ASK_MAX - 1) + '…' : one
}

// Whether the turn asked the right way already: a decision brief (`brief
// ask`), or a status declared blocked:question. `tools`: the turn's tool
// calls as name and input.
export function askedProperly(tools: readonly { name: string; input: unknown }[]): boolean {
  return tools.some((t) => {
    const i: any = t.input ?? {}
    if (/(^|__)status$/.test(t.name)) return i.state === 'blocked' && i.kind === 'question'
    if (t.name === 'Bash') return /(^|[\s;&|(])brief\s+ask\b/.test(String(i.command ?? ''))
    if (t.name === 'SendMessage') return /^\s*(\[[^\]]*\]\s*)?(QUESTION|BLOCKED)\b/.test(String(i.message ?? ''))
    return false
  })
}

// Where a worker's cc-mods writes the question its last turn ended on
// (register.ts askExport), one file a session: {text, at, turnId}.
export const ASKS_DIR = '/.claude/state/office/asks'

export type AskSeen = { text: string; at: number }
export function parseAskFile(json: string | undefined): AskSeen | undefined {
  try {
    const d = JSON.parse(json ?? '')
    return d && typeof d.text === 'string' && d.text && Number(d.at) > 0 ? { text: d.text, at: Number(d.at) } : undefined
  } catch {
    return undefined
  }
}

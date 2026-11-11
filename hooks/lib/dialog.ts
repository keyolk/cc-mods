// A permission dialog on a pane's screen, read from `tmux capture-pane`:
// what coord_answer checks before it presses a key in a worker's pane. The
// office reads the same screens (office/office.py dialog); this keeps only
// what a press needs: a numbered choice with a cursor (❯) near the bottom,
// the box above it (the tool and its command), and the option numbers.

const OPTION = /^\s*([❯›>]\s*)?(\d)[.)]\s+(.+?)\s*$/
const RULE = /^\s*[─━═╌]{8,}\s*$/
const FRAME = /^[│┃║|\s]+|[│┃║|\s]+$/g
// A side panel beside the chat pads a line and then draws its own text after
// a bar: an option's label ends at the first bar after a wide gap.
const PANEL = /\s{3,}[│┃║].*$/

export type Dialog = { question: string; about: string[]; options: { n: number; label: string }[] }

const bare = (l: string) => l.replace(PANEL, '').replace(FRAME, '')

export function parseDialog(screen: string): Dialog | undefined {
  const tail = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-18)
  let opts: { n: number; label: string }[] = []
  let cursor = false
  let first = -1
  tail.forEach((l, i) => {
    const m = OPTION.exec(l.replace(PANEL, ''))
    if (!m) return
    const n = Number(m[2])
    if (n === 1) {
      opts = []
      cursor = false
      first = i
    }
    if (opts.length && n !== opts[opts.length - 1]!.n + 1) return
    if (!opts.length && n !== 1) return
    opts.push({ n, label: bare(m[3]!).slice(0, 90) })
    cursor ||= Boolean(m[1])
  })
  if (opts.length < 2 || !cursor || first < 0) return undefined
  let q = first - 1
  while (q >= 0 && (!bare(tail[q]!) || OPTION.test(tail[q]!))) q--
  const question = q >= 0 ? bare(tail[q]!) : ''
  // Only the dialog's own box: it starts under a rule; above it is scrollback.
  let top = Math.max(0, first - 9)
  for (let j = first - 1; j >= Math.max(0, first - 10); j--)
    if (RULE.test(tail[j]!)) {
      top = j + 1
      break
    }
  const about = tail
    .slice(top, first)
    .map(bare)
    .filter((x) => x && x !== question && !RULE.test(x))
    .slice(-6)
  return { question: question.slice(0, 160), about: about.map((x) => x.slice(0, 160)), options: opts }
}

// What the dialog asks about, as one line: the expect check runs on it.
export function dialogText(d: Dialog): string {
  return [...d.about, d.question].join(' ').replace(/\s+/g, ' ').trim()
}

// expect: a piece of the command or path the coordinator checked. The press
// is refused when the dialog on screen now does not show it (the worker went
// on to its next call, which asks with the same question and options).
export function matches(d: Dialog, expect: string): boolean {
  const want = expect.replace(/\s+/g, ' ').trim()
  return !want || dialogText(d).includes(want)
}

export function dialogShown(d: Dialog): string {
  return [...d.about, d.question, ...d.options.map((o) => o.n + '. ' + o.label)].join('\n')
}

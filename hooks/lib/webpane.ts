// One TWeb pane per tmux window. Workers each ran `tweb split`, so one
// window filled with browser panes, and tweb then asks for --pane on every
// command because it cannot tell which one is meant. The Bash guard in
// register.ts refuses a second pane unless the command says it is meant
// (TWEB_SECOND_PANE=1); the prompts tell sessions to reuse the pane first.
// Only Claude's Bash calls meet the guard: a command the person types runs
// as before. Pure: register.ts lists the panes.

import type { SidePane } from './webside'

// The office (office.py, port 8796) is the person's screen, not a browser
// for a task: never a pane to open pages in, and no reason to refuse one.
// Every tab must be the office: a new tweb pane can come up with the last
// pane's tabs restored, the office among them (live), and that pane is a
// browser pane like any other.
const OFFICE = /^https?:\/\/(localhost|127\.0\.0\.1):8796(\/|$)/
export function isOffice(p: SidePane): boolean {
  return p.tabs.length > 0 && p.tabs.every((t) => OFFICE.test(t.url))
}

export const SECOND_PANE_ENV = 'TWEB_SECOND_PANE'

// The rule as the coordinator and its workers read it.
export const ONE_BROWSER =
  '- A browser: one tweb pane per tmux window. Before `tweb split`, look for a browser pane in your window (`tweb panes` lists every one, `tmux list-panes -F "#{pane_id}"` your window\'s panes): when there is one, open the page there with `tweb tab new <url> --pane %N` (`tweb tab engine chrome --pane %N` then moves it to the Chrome engine), and run `tweb split <url>` only when there is none. ' +
  'The office pane (localhost:8796) is the person\'s screen: never tab new or navigate in it; it does not count as your window\'s browser pane. ' +
  'A second browser pane only when the first truly cannot do, with the reason in your report: a hook refuses `tweb split` while your window has a browser pane, and `' + SECOND_PANE_ENV + '=1 tweb split <url>` passes it.'

// The `tweb split` / `tweb open` calls in a Bash command line that do not say
// TWEB_SECOND_PANE=1 before them, as the words after `tweb`. Help is not a pane.
export function paneOpens(command: string): string[] {
  const out: string[] = []
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const words = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'))
    const at = words.findIndex((w) => w === 'tweb' || /\/tweb$/.test(w))
    if (at < 0) continue
    const rest = words.slice(at + 1)
    if (rest[0] !== 'split' && rest[0] !== 'open') continue
    if (rest.includes('-h') || rest.includes('-H') || rest.includes('--help')) continue
    const meant = words.slice(0, at).some((w) => new RegExp('^' + SECOND_PANE_ENV + '=["\']?(1|true|yes)["\']?$', 'i').test(w))
    if (!meant) out.push(['tweb', ...rest].join(' '))
  }
  return out
}

// The URL argument of `tweb split|open`: the first word that is neither a
// flag nor a flag's value.
const VALUED = new Set(['--engine', '--frame-rate', '--ssh'])
function urlOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (VALUED.has(a)) i++
    else if (!a.startsWith('-')) return a
  }
  return undefined
}

// Why the command may not run: a browser pane other than the office is
// already in this session's window (`panes`, register.ts listSide). Undefined:
// it may.
export function secondPaneDeny(command: string, panes: readonly SidePane[]): string | undefined {
  const opens = paneOpens(command)
  if (!opens.length) return undefined
  const there = panes.filter((p) => !isOffice(p))
  if (!there.length) return undefined
  const p = there[0]!.pane
  const url = urlOf(opens[0]!.split(' ').slice(2)) ?? '<url>'
  return (
    'This tmux window already has a browser pane (' + there.map((x) => x.pane).join(', ') + '), and one window keeps one tweb pane. ' +
    'Open the page in it: `tweb tab new ' + url + ' --pane ' + p + '` (then `tweb tab engine chrome --pane ' + p + '` if it needs the Chrome engine). ' +
    'Only when that pane truly cannot do, run `' + SECOND_PANE_ENV + '=1 ' + opens[0] + '` and give the reason in your report.'
  )
}

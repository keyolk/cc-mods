// Archive folders: ~/exp/<YYYY-MM-DD>_<topic>/, where the exp-archive skill
// keeps what a session exchanged with an outside party (a vendor ticket, a
// Slack Connect thread, a customer) so it outlives the scratchpad:
//
//   README.md          links, what each file is, and "## Open": what is
//                      still owed (an attachment promised, a reply due)
//   correspondence.md  one table row per message in or out
//   attachments/       what was or will be sent, with SHA256SUMS
//   drafts/ work/      unsent text, scripts and raw evidence
//
// A session that writes into one is linked to it (an `exp` output, so it is
// kept, exported and listed with the rest), and the cockpit shows what the
// folder still owes and whether its attachments still match their sums.
// Sends to Slack Connect are often made by the person by hand, so the folder,
// not the send, is what is tracked. Pure: detection and parsing.

import type { Output } from './record'

// A folder root: ~/exp/2026-10-14_twingate_17043, spelled with ~, $HOME or
// an absolute home (/Users/x, /home/x).
const EXP_DIR = /(~|\$\{?HOME\}?|\/(?:Users|home)\/[^/\s'"`]+)\/exp\/(\d{4}-\d{2}-\d{2}_[^/\s'"`;|&)<>]+)/g

// Commands that put something in a folder, as opposed to reading it.
const WRITES = /\b(mkdir|mv|cp|rsync|tee|install|ln|touch|tar|zip|gzip|shasum|sha256sum|ditto)\b|>>?\s*\S*\/exp\//

// The folders a text names, ~-relative paths left with ~ for the caller to
// expand ($HOME becomes ~).
export function expFolders(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(EXP_DIR)) {
    const root = /^\$/.test(m[1]!) ? '~' : m[1]!
    out.add(root + '/exp/' + m[2]!.replace(/[.,:]+$/, ''))
  }
  return [...out]
}

const expOutput = (path: string, at: number, detail: string): Output => ({ id: 'exp:' + path, kind: 'exp', title: path.split('/').pop() ?? path, path, at, detail })

// Linked by a tool call: a file written under the folder, or a shell command
// that writes there. A command that only reads one (ls, cat) does not link it.
export function expFromTool(tool: string, input: Record<string, unknown>, at: number): Output[] {
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') return expFolders(String(input.file_path ?? input.notebook_path ?? '')).map((p) => expOutput(p, at, 'archived'))
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    return WRITES.test(cmd) ? expFolders(cmd).map((p) => expOutput(p, at, 'archived')) : []
  }
  return []
}

// Linked by an answer that names the folder (the skill reports where it put
// things).
export function expFromAnswer(text: string, at: number): Output[] {
  return expFolders(text).map((p) => expOutput(p, at, 'named'))
}

// README's "## Open": its top-level bullets, up to the next heading. A bullet
// that only points at another file ("See correspondence.md …") is not owed.
export function parseOpen(readme: string | undefined): string[] {
  if (!readme) return []
  const out: string[] = []
  let inOpen = false
  for (const line of readme.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inOpen = /^##\s+open\b/i.test(line.trim())
      continue
    }
    if (!inOpen) continue
    const m = /^[-*]\s+(.+)$/.exec(line)
    if (!m || /^see\s+`?[\w.-]+\.md`?\b/i.test(m[1]!)) continue
    out.push(m[1]!.trim())
  }
  return out
}

// correspondence.md's last row, as "time · dir · gist".
export function lastMessage(md: string | undefined): string | undefined {
  if (!md) return undefined
  const rows = md
    .split('\n')
    .filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*time\s*\|/i.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  const r = rows.at(-1)
  return r && r.length >= 5 ? [r[0], r[1], r[4]].filter(Boolean).join(' · ') : undefined
}

export type Sums = { ok: number; failed: string[]; unlisted: string[] }

// `shasum -a 256 -c SHA256SUMS; echo --ls; ls -1` run in attachments/: what
// matched, what did not (changed or gone), and files no sum covers.
export function parseSums(out: string): Sums | undefined {
  const [check = '', listing] = out.split('\n--ls\n')
  if (listing === undefined) return undefined
  const listed = new Set<string>()
  const failed: string[] = []
  let ok = 0
  for (const line of check.split('\n')) {
    const m = /^(.+?): (OK|FAILED.*)$/.exec(line.trim())
    if (!m) continue
    listed.add(m[1]!)
    if (m[2] === 'OK') ok++
    else failed.push(m[1]!)
  }
  if (!listed.size) return undefined
  const unlisted = listing
    .split('\n')
    .map((l) => l.trim())
    .filter((n) => n && n !== 'SHA256SUMS' && !listed.has(n) && !n.startsWith('.'))
  return { ok, failed, unlisted }
}

export const SUMS_CHECK = 'cd "$0" 2>/dev/null || exit 0; [ -f SHA256SUMS ] || exit 0; shasum -a 256 -c SHA256SUMS 2>&1; echo --ls; ls -1'

export type ExpCheck = { open: string[]; sums?: Sums; last?: string; at: number }

// The few words a row shows: what is owed and whether the sums hold.
export function expStatus(c: ExpCheck | undefined): string {
  if (!c) return ''
  const bad = c.sums ? c.sums.failed.length + c.sums.unlisted.length : 0
  return [c.open.length ? c.open.length + ' open' : '', bad ? '⚠ ' + (c.sums!.failed.length ? c.sums!.failed.length + ' changed' : c.sums!.unlisted.length + ' unsummed') : c.sums ? '✓ ' + c.sums.ok + ' sums' : ''].filter(Boolean).join(' · ')
}

export function expNeedsYou(c: ExpCheck | undefined): boolean {
  return !!c && (c.open.length > 0 || !!c.sums?.failed.length || !!c.sums?.unlisted.length)
}

// The preview: what is owed, the sums, the last message, then the README.
export function expPreview(path: string, c: ExpCheck | undefined, readme: string | undefined): string {
  const parts: string[] = ['**' + path + '**']
  if (c?.open.length) parts.push('### Open\n' + c.open.map((o) => '- ' + o).join('\n'))
  if (c?.sums) {
    const s = c.sums
    parts.push(
      '### Attachments\n' +
        (s.failed.length || s.unlisted.length
          ? [...s.failed.map((f) => '- ⚠ changed or missing: `' + f + '`'), ...s.unlisted.map((f) => '- ⚠ not in SHA256SUMS: `' + f + '`')].join('\n')
          : '- ✓ ' + s.ok + ' files match SHA256SUMS'),
    )
  }
  if (c?.last) parts.push('### Last message\n' + c.last)
  if (readme) parts.push('---\n' + readme)
  return parts.join('\n\n')
}

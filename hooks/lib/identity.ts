// A session's identity, as text another session can act on: which session,
// where it runs, what it is about, and where its transcript is, so a second
// Claude session (or a person) can catch up by reading it. Pure.

export type Identity = {
  session: string
  window?: string // tmux session:index name
  pane?: string
  cwd?: string
  topic?: string
  state?: string
  transcript?: string
  last?: string // the latest conclusion
  links?: readonly string[] // threads, PRs this session works on
}

export function identityText(i: Identity): string {
  const lines = ['Claude Code session ' + i.session + (i.state ? ' (' + i.state + ')' : '')]
  if (i.window || i.pane || i.cwd) lines.push('- where: ' + [i.window && 'tmux ' + i.window, i.pane, i.cwd].filter(Boolean).join(' · '))
  if (i.topic) lines.push('- topic: ' + oneLine(i.topic, 200))
  if (i.last) lines.push('- latest: ' + oneLine(i.last, 300))
  for (const l of (i.links ?? []).slice(0, 5)) lines.push('- link: ' + l)
  if (i.transcript) lines.push('- transcript: ' + i.transcript + ' (JSONL, newest last; read it to catch up)')
  lines.push('- continue it elsewhere: claude --resume ' + i.session + ' --fork-session')
  return lines.join('\n')
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

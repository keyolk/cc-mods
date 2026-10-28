// The side chat's prompt: a conversation beside the main work, not a string
// of one-off questions. Each ask carries the side exchanges since the last
// clear, so "그럼 그건?" resolves against what was just said here, while the
// fork itself carries the main transcript.

export type SideTurn = { q: string; a?: string; error?: string; pending?: boolean }

// Enough to follow a thread; older turns are dropped first, and long answers
// cut, so a long chat cannot crowd out the main transcript the fork replays.
export const SIDE_KEEP_TURNS = 8
export const SIDE_ANSWER_CHARS = 1200

export function sidePrompt(history: readonly SideTurn[], q: string): string {
  const done = history.filter((t) => t.a && !t.error && !t.pending).slice(-SIDE_KEEP_TURNS)
  const lines = [
    'The user is chatting with you beside the main work, in a separate pane: this exchange never enters the main conversation.',
    'Talk with them, the way a colleague at the next desk would: reply to what they said, in Korean, short unless they ask for more.',
    'Use the main conversation so far as shared context. You cannot use tools here; if something needs checking, say what you would check.',
  ]
  if (done.length) {
    lines.push('', 'The side chat so far:')
    for (const t of done) {
      const a = t.a!.length > SIDE_ANSWER_CHARS ? t.a!.slice(0, SIDE_ANSWER_CHARS) + '…' : t.a!
      lines.push('', 'User: ' + t.q, 'You: ' + a)
    }
  }
  lines.push('', 'User: ' + q)
  return lines.join('\n')
}

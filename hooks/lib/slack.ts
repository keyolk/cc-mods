// Slack threads this session touched, kept current: the channel's name and
// the replies nobody has looked at yet. Pure: it parses what the Slack MCP
// server's slack_read_thread / slack_read_channel return (their detailed
// text, not JSON) and decides what is unseen. register.ts does the calls.

export type SlackReply = { user: string; name: string; email?: string; ts: string }

export type SlackThreadState = {
  channel: string
  root: string
  name?: string // #channel-name once resolved
  replies: number
  unseen: number // replies after `seen` by someone other than me
  lastFrom?: string // who wrote the newest unseen reply
  newest?: string // ts of the newest message, what opening it marks seen
  checkedAt: number
}

// "From: Jane Doe <jane@example.com> (U0123ABCD45)\nTime: …\nMessage TS: 1791964938.841409"
// for the parent and each reply; the parent comes first.
export function parseThread(text: string): { parent?: SlackReply; replies: SlackReply[] } {
  const all: SlackReply[] = []
  const re = /From: ([^\n<(]+?)\s*(?:<([^>\n]+)>)?\s*\(([A-Z0-9]+)\)\nTime: [^\n]*\nMessage TS: (\d+\.\d+)/g
  for (const m of text.matchAll(re)) all.push({ name: m[1]!.trim(), email: m[2], user: m[3]!, ts: m[4]! })
  const parentMarked = text.indexOf('=== THREAD PARENT MESSAGE ===') >= 0
  return parentMarked ? { parent: all[0], replies: all.slice(1) } : { replies: all }
}

// "Channel: #team-pr-review (C0123ABCD45)"
export function parseChannelName(text: string): string | undefined {
  return /Channel: (#[\w.-]+) \(/.exec(text)?.[1]
}

// The text block an MCP tool result carries, whether it came back as content
// blocks or as a JSON string: the read tools put it in `messages`, the search
// tools in `results`.
export function mcpText(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[] } | undefined
  const raw = (r?.content ?? []).map((c) => c.text ?? '').join('\n')
  try {
    const j = JSON.parse(raw)
    if (typeof j?.messages === 'string') return j.messages
    if (typeof j?.results === 'string') return j.results
  } catch {}
  return raw
}

const tsNum = (ts: string) => Number(ts)

// Replies after `seen` that someone else wrote. A reply of mine marks the
// thread seen up to it: I wrote it, so I had read what came before.
export function unseenReplies(replies: readonly SlackReply[], seen: string | undefined, me: { user?: string; email?: string }): SlackReply[] {
  let mark = seen ? tsNum(seen) : 0
  for (const r of replies) if (isMe(r, me) && tsNum(r.ts) > mark) mark = tsNum(r.ts)
  return replies.filter((r) => tsNum(r.ts) > mark && !isMe(r, me))
}

export function isMe(r: SlackReply, me: { user?: string; email?: string }): boolean {
  return (!!me.user && r.user === me.user) || (!!me.email && r.email?.toLowerCase() === me.email.toLowerCase())
}

export function newestTs(t: { parent?: SlackReply; replies: readonly SlackReply[] }): string | undefined {
  return [t.parent, ...t.replies].filter((x): x is SlackReply => !!x).map((x) => x.ts).sort((a, b) => tsNum(a) - tsNum(b)).at(-1)
}

// Threads the person asked the cockpit to follow up on its own (In/Out ›
// Slack › auto): `lastRun` is the newest reply ts a follow-up already ran for,
// so one batch of replies starts one follow-up, not one per poll.
export type SlackFollow = { auto: boolean; lastRun?: string }

export function followDue(state: SlackThreadState | undefined, follow: SlackFollow | undefined): boolean {
  return !!(follow?.auto && state && state.unseen > 0 && state.newest && state.newest !== follow.lastRun)
}

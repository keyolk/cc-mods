// The context cc-mods gives Claude (session policy, coordinator mode, RCA
// mode, moved topics) as conversation rows, where the system prompt is out of
// reach.
//
// Why: where Claude Code seats cc-plugin-sec-default (managed settings, Team
// and Enterprise), that built-in sends prompt.compose past every user-tier
// plugin (`on("prompt.compose", (n, r, o) => o.to(r, "append"))`), and the
// debug log says `prompt.compose bypassed by cc-plugin-sec-default (tier
// user); beneath runs`. The `cc-mods:policy` section never reached the model.
// A plugin's own `$.session.append` (door `note`) it lets through for a user
// tier caller, and the row is a user-role message the model reads.
//
// Rows stay in the conversation, unlike a system prompt that is rendered
// anew, so each block goes only when its text changed, and says it replaces
// the one before. What is in the conversation is read back from it (its
// marker and digest), not kept in memory: a compaction or /clear drops the
// row, and the next prompt sends it again.

export type NoteBlock = { key: string; text: string }

export const NOTE_PREFIX = '[cc-mods context: '

// `[cc-mods context: policy #1a2b3c4d]`: the block's key and its text's
// digest, at the start of a line. A row of ours starts with one (each part
// after it starts its own line); a marker quoted mid-line (a summary, another
// session's prompt) carries no body and counts for nothing.
const HEAD = /^\[cc-mods context: ([a-z-]+) #([0-9a-f]{8})\]/gm

// FNV-1a, 32 bits: a change detector, not a security boundary.
export function digest(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// The newest digest of each key in these texts (oldest first): only a text
// that is a row of ours, one starting with a marker.
export function sentDigests(texts: readonly string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of texts) if (t.startsWith(NOTE_PREFIX)) for (const x of t.matchAll(HEAD)) m.set(x[1]!, x[2]!)
  return m
}

// A key that once had a block and now has none says so, once: the old row is
// still in the conversation and would otherwise go on reading as current.
const ENDED = 'ended'

// The blocks to send now, as one row's text, or undefined when the
// conversation already holds every current one.
export function noteText(blocks: readonly NoteBlock[], sent: ReadonlyMap<string, string>): string | undefined {
  const parts: string[] = []
  const live = new Set(blocks.map((b) => b.key))
  for (const b of blocks) {
    const d = digest(b.text)
    if (sent.get(b.key) === d) continue
    parts.push(NOTE_PREFIX + b.key + ' #' + d + '] ' + (sent.has(b.key) ? 'This replaces the earlier ' + b.key + ' context.' : 'cc-mods context for this session.') + '\n' + b.text)
  }
  for (const [k, d] of sent) {
    if (live.has(k) || d === digest(ENDED)) continue
    parts.push(NOTE_PREFIX + k + ' #' + digest(ENDED) + '] The earlier ' + k + ' context no longer applies.')
  }
  return parts.length ? parts.join('\n\n') : undefined
}

// The user-side text blocks of a conversation in its Messages API form
// ($.session.messages({ as: 'api' })): where a note row shows; the row form
// leaves it out.
export function userTexts(msgs: readonly { role: string; content: unknown }[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') out.push(m.content)
    else if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b === 'object' && (b as any).type === 'text') out.push(String((b as any).text ?? ''))
  }
  return out
}

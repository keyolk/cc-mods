// Sessions the person set aside in the office 지휘 view (⏰ 나중에,
// office/defer.py): one file a session, ~/.claude/state/office/defer/<sid>.json,
// {"until": epoch s, ...}. While its time has not come the session is quiet
// everywhere, not only in the 지휘 table: its MCP auto-reconnect waits
// (register.ts; a /mcp reconnect makes the engine fire idle_prompt a minute
// later, and that rang the person's banner: gavin-jeong-f1, 2026-11-11, five
// banners in 17 minutes after it was set aside until Monday), and a
// coordinator records its worker's changes without waking on them
// (coord.ts). A new question brings it back: the office drops the time
// (office.py deferred, turn.woken), and the file stops naming it here.

export const DEFER_DIR = '/.claude/state/office/defer'

// What the listing prints: one `<file name>\t<its JSON on one line>` a file.
export const DEFER_LIST = 'cd "$0" 2>/dev/null || exit 0; for f in *.json; do [ -f "$f" ] && printf "%s\\t%s\\n" "$f" "$(tr -d "\\n" < "$f")"; done; true'

const SID = /^[0-9a-f-]{8,64}$/

// sid -> until (epoch ms) for the sessions set aside at `now` (epoch ms).
export function parseDeferred(out: string, now: number): Map<string, number> {
  const m = new Map<string, number>()
  for (const line of out.split('\n')) {
    const i = line.indexOf('\t')
    if (i < 0) continue
    const name = line.slice(0, i)
    const sid = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!SID.test(sid)) continue
    const u = deferredUntil(line.slice(i + 1), now)
    if (u) m.set(sid, u)
  }
  return m
}

// One file's until (epoch ms) while it is ahead of `now`; else undefined.
export function deferredUntil(json: string | undefined, now: number): number | undefined {
  try {
    const u = JSON.parse(json ?? '')?.until
    return typeof u === 'number' && u * 1000 > now ? u * 1000 : undefined
  } catch {
    return undefined
  }
}

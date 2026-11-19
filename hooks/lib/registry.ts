// Claude Code's session registry (~/.claude/sessions/<pid>.json): a
// session's id, name and pid, read one file at a time. Pure: coord.ts reads
// the files.
//
// Claude Code rewrites a registry file in place, and a shorter record over a
// longer one leaves the old tail behind: on 2026-11-20, 4 of 23 files ended
// in one extra `}` after a complete object, all four sessions alive. The
// roster read them with one `jq … sessions/*.json`, and jq stops the whole
// run at the first parse error: 10 of 23 names came out, the rest of the
// roster fell back to 8-character ids. So each file is parsed on its own, as
// the first JSON value in it; a file that still does not parse hides only
// itself.

export type RegSession = { name?: string; pids: number[]; at: number }

// The first JSON value in raw, or undefined: trailing bytes after a complete
// object or array (a torn rewrite's leftover) are ignored.
export function leadingJson(raw: string | undefined): unknown {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    // fall through: find where the first value ends
  }
  const open = s[0]
  if (open !== '{' && open !== '[') return undefined
  let depth = 0
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(0, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

// Session id → its name and every pid a registry file gives it (a resumed
// session can have the old, dead pid's file beside the new one). `files`:
// each file's name (`<pid>.json`) and text.
export function parseRegistry(files: readonly { name: string; text: string | undefined }[]): Map<string, RegSession> {
  const out = new Map<string, RegSession>()
  for (const f of files) {
    const d = leadingJson(f.text) as Record<string, unknown> | undefined
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue
    const sid = typeof d.sessionId === 'string' ? d.sessionId : ''
    if (!sid) continue
    const pid = Number(d.pid ?? f.name.replace(/\.json$/, ''))
    const at = Number(d.updatedAt ?? d.startedAt ?? 0) || 0
    const name = typeof d.name === 'string' && d.name ? d.name : undefined
    const cur = out.get(sid) ?? { pids: [], at: -1 }
    const pids = Number.isInteger(pid) && pid > 0 && !cur.pids.includes(pid) ? [...cur.pids, pid] : cur.pids
    // The newest named record names the session; an unnamed one never
    // takes the name of a named one away.
    const takes = !!name && (!cur.name || at >= cur.at)
    out.set(sid, { pids, at: takes ? at : cur.at, ...(takes ? { name } : cur.name ? { name: cur.name } : {}) })
  }
  return out
}

// Tool calls this session put to its permission mode that have not run yet,
// and how the one a person must answer is named in tmux (@cc_pane_asks), so
// a coordinator can say "asks: Read ~/x/brief.py" instead of "finished".
//
// tool.check's ask goes to the mode first: under auto mode the classifier
// settles most with no dialog (attention `action`, provisional). When the
// dialog is really drawn (classic PermissionRequest, or the Notification
// `permission_prompt` that fires with it) the call is `shown` and the pane
// says `ask`: only the person in that pane can answer.
//
// Calls run in parallel (two Reads outside the working directory), so this
// is a list: one call running must not clear the other's dialog.
// Pure: register.ts keeps the list and publishes.

export type Asked = { id: string; tool: string; label: string; key: string; shown?: boolean }

const ARG_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'url', 'pattern', 'query', 'prompt']

// "Read ~/worktrees/briefs/x/bin/brief.py": the tool and what it touches, one
// line, home as ~, no tabs (the tmux format splits on them).
export function askLabel(tool: string, input: unknown, home?: string): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const arg = ARG_KEYS.map((k) => i[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  let what = (arg ?? '').replace(/\s+/g, ' ').trim()
  if (home && home !== '/' && (what === home || what.startsWith(home + '/'))) what = '~' + what.slice(home.length)
  const name = tool.replace(/^mcp__/, '').replace(/__/g, ' ')
  const s = what ? name + ' ' + what : name
  return s.length > 140 ? s.slice(0, 139) + '…' : s
}

// The call's identity for matching a dialog to it: the tool and its input.
export function askKey(tool: string, input: unknown): string {
  try {
    return tool + ' ' + JSON.stringify(input ?? null)
  } catch {
    return tool
  }
}

// Which pending call a drawn dialog is for: the same tool and input, else
// one of that tool already shown (the notice of a dialog already marked),
// else the oldest of that tool; with no tool named, the same over all.
export function dialogFor(asked: readonly Asked[], tool?: string, input?: unknown): Asked | undefined {
  if (tool && input !== undefined) {
    const k = askKey(tool, input)
    const same = asked.find((a) => a.key === k)
    if (same) return same
  }
  const of = tool ? asked.filter((a) => a.tool === tool) : asked
  return of.find((a) => a.shown) ?? of[0]
}

// "Claude needs your permission to use Read" → Read.
export function toolOfNotice(message: unknown): string | undefined {
  const m = /permission to use ([\w.:-]+)/i.exec(String(message ?? ''))
  return m?.[1]
}

// What the pane says while calls are pending: a drawn dialog first (`ask`),
// else the oldest call the mode is still deciding (`action`).
export function askState(asked: readonly Asked[]): { attention: 'ask' | 'action'; label: string } | undefined {
  const shown = asked.find((a) => a.shown)
  if (shown) return { attention: 'ask', label: shown.label }
  return asked.length ? { attention: 'action', label: asked[0]!.label } : undefined
}

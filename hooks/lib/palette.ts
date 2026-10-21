// The cockpit's quick-access palette (cmd+k in other apps): every setting and
// action in one searchable list. Pure: the items are data with an `run` id the
// register module maps to what it does, so the list and its ranking are tested
// without the engine.

export type PaletteItem = {
  id: string // what register.ts runs for it
  title: string
  group: 'Tab' | 'Go' | 'Slack' | 'Policy' | 'Routing' | 'Browser' | 'Web' | 'Command'
  hint?: string // the current value, or what it does
  keywords?: string // extra words it is found by
}

export type PaletteState = { open: boolean; query: string; sel: number }

export const PALETTE_CLOSED: PaletteState = { open: false, query: '', sel: 0 }

// Fuzzy rank: every query character in order in the title or keywords. A
// match at a word start or a run of consecutive characters scores higher; an
// empty query keeps the list's order. Several words match each on its own
// (any order, any of title/group/keywords), so "side question" finds "Ask a
// side question" and "jira out" finds the In/Out Jira list; one fuzzy pass
// over the whole query found nothing once the space had to match too.
export function score(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const words = q.split(/\s+/)
  const whole = scoreOne(item, q)
  if (words.length < 2) return whole
  let sum = 0
  for (const w of words) {
    const s = scoreOne(item, w)
    if (s <= 0) return whole
    sum += s
  }
  return Math.max(whole, sum / words.length)
}

function scoreOne(item: PaletteItem, q: string): number {
  let best = 0
  for (const hay of [item.title, item.group + ' ' + item.title, item.keywords ?? '']) {
    const h = hay.toLowerCase()
    if (!h) continue
    if (h.includes(q)) {
      // A word in the title beats the same word in the keywords: "pr" is
      // Show PRs before the prod_eks_write grant whose cap id starts with it.
      const title = hay === item.title ? 20 : 0
      best = Math.max(best, 100 - h.indexOf(q) + (h.startsWith(q) || h.includes(' ' + q) ? 50 : 0) + title)
      continue
    }
    let i = 0
    let s = 0
    let run = 0
    for (const c of q) {
      const j = h.indexOf(c, i)
      if (j < 0) {
        s = 0
        break
      }
      run = j === i ? run + 1 : 0
      s += 1 + run * 2 + (j === 0 || h[j - 1] === ' ' ? 3 : 0)
      i = j + 1
    }
    best = Math.max(best, s)
  }
  return best
}

export function filterPalette(items: readonly PaletteItem[], query: string, limit = 12): PaletteItem[] {
  return items
    .map((item, i) => ({ item, i, s: score(item, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item)
}

// The In/Out tab's lists (views/outputs.ts TABS) as places to go to.
const OUT_PLACES: readonly (readonly [string, string, string])[] = [
  ['pr', 'PRs', 'pr pull request github'],
  ['artifact', 'docs and artifacts', 'docs artifact page'],
  ['scratch', 'files', 'files scratch edits'],
  ['ticket', 'Jira tickets', 'jira ticket issue'],
  ['slack', 'Slack threads', 'slack thread'],
  ['link', 'links', 'links url'],
  ['bg', 'background tasks', 'tasks bg background monitor'],
]

// What the palette lists, from the cockpit's state. `policy` maps a capability
// to its value; `caps` gives each capability's label.
export function paletteItems(v: {
  tabs: readonly { id: string; label: string; hotkey: string }[]
  caps: readonly { cap: string; label: string; value: string }[]
  route: { effort: boolean; model: boolean }
  browser: string
  web: { running: boolean; engine: string; device: string; rate: number }
  slack?: readonly { url: string; title: string; detail?: string }[] // threads this session touched, newest first
}): PaletteItem[] {
  const items: PaletteItem[] = []
  // `slack:<url>`: register.ts opens the thread where links open.
  for (const t of v.slack ?? []) {
    items.push({ id: 'slack:' + t.url, title: 'Open ' + t.title, group: 'Slack', hint: t.detail, keywords: 'slack thread channel' })
    // `slack-follow:<url>`: sb:slack-followup on that thread.
    items.push({ id: 'slack-follow:' + t.url, title: 'Follow up ' + t.title, group: 'Slack', hint: t.detail, keywords: 'slack thread follow up reply answer followup' })
  }
  // Extra words a tab is found by, beyond its name.
  const tabWords: Record<string, string> = { usage: 'ccproxy quota tokens account model trend jev', web: 'browser tweb url', policy: 'merge prod gate slack', auth: 'login sso aws gh github argocd mcp connector credential token expired', settings: 'preferences config browser links routing keys' }
  for (const t of v.tabs) items.push({ id: 'tab:' + t.id, title: 'Go to ' + t.label, group: 'Tab', hint: t.hotkey, keywords: t.id + ' ' + (tabWords[t.id] ?? '') })
  // Places inside a tab: register.ts opens the tab there and puts the
  // keyboard on that place (the side question field, the list's own tab).
  items.push({ id: 'go:side', title: 'Ask a side question', group: 'Go', hint: 'Chat', keywords: 'side question ask aside btw chat' })
  for (const [id, label, words] of OUT_PLACES) items.push({ id: 'out:' + id, title: 'Show ' + label, group: 'Go', hint: 'In/Out', keywords: 'outputs in out ' + words })
  items.push({ id: 'go:out-filter', title: 'Filter In/Out by words', group: 'Go', hint: 'In/Out', keywords: 'outputs inputs in out filter search find grep keyword' })
  items.push({ id: 'out-side:in', title: 'Show inputs (brought in, read, mentioned)', group: 'Go', hint: 'In/Out', keywords: 'outputs in out inputs read mentioned' })
  for (const [id, label] of [['conclusions', 'conclusions'], ['decisions', 'decisions'], ['agents', 'agents']] as const) items.push({ id: 'chat:' + id, title: 'Chat ' + label, group: 'Go', hint: 'Chat', keywords: 'chat flow filter ' + id })
  for (const c of v.caps) {
    const next = c.value === 'allow' ? 'inherit' : 'allow'
    items.push({ id: 'policy:' + next + ':' + c.cap, title: (next === 'allow' ? 'Allow ' : 'Stop allowing ') + c.label, group: 'Policy', hint: c.value, keywords: c.cap })
  }
  items.push({ id: 'go:scope', title: 'Allow a target (merge repo, prod ns, slack channel)', group: 'Go', hint: 'Policy', keywords: 'policy scope grant allow target' })
  items.push({ id: 'route:effort:' + (v.route.effort ? 'off' : 'on'), title: 'Auto effort ' + (v.route.effort ? 'off' : 'on'), group: 'Routing', hint: v.route.effort ? 'on' : 'off', keywords: 'jev effort model routing' })
  items.push({ id: 'route:model:' + (v.route.model ? 'off' : 'on'), title: 'Auto model ' + (v.route.model ? 'off' : 'on'), group: 'Routing', hint: v.route.model ? 'on' : 'off', keywords: 'jev sonnet routing' })
  for (const b of ['tweb', 'tweb-chrome', 'tweb-webkit', 'chrome', 'inherit']) {
    if (b !== v.browser) items.push({ id: 'browser:' + b, title: 'Open links in ' + b, group: 'Browser', hint: v.browser, keywords: 'browser links tmux-chrome' })
  }
  items.push({ id: 'web:open', title: 'Open a page in the Web tab', group: 'Web', keywords: 'url browse tweb' })
  if (v.web.running) {
    for (const [en, label] of [['electron', 'Electron'], ['chrome', 'Chrome'], ['webkit', 'WebKit']] as const) {
      if (en !== v.web.engine) items.push({ id: 'web:engine:' + en, title: 'Web engine ' + label, group: 'Web', hint: v.web.engine, keywords: 'tweb engine' + (en === 'webkit' ? ' tauri safari' : '') })
    }
    items.push({ id: 'web:float', title: 'Float the page as a desktop window (or pin it back)', group: 'Web', keywords: 'float window detach pin tweb w' })
    items.push({ id: 'web:devtools', title: 'Open DevTools', group: 'Web', hint: v.web.engine === 'chrome' ? '' : 'Chrome engine only', keywords: 'inspect console' })
    for (const d of ['', 'iPhone 12', 'iPad', 'Pixel 5']) {
      if (d !== v.web.device) items.push({ id: 'web:device:' + d, title: 'Web device ' + (d || 'pane viewport'), group: 'Web', hint: v.web.device || 'pane', keywords: 'mobile emulate viewport' })
    }
    for (const r of [15, 30, 60]) if (r !== v.web.rate) items.push({ id: 'web:fps:' + r, title: 'Web frame rate ' + r, group: 'Web', hint: String(v.web.rate), keywords: 'fps frames' })
    items.push({ id: 'web:close', title: 'Close the Web page', group: 'Web', keywords: 'stop quit' })
  }
  items.push({ id: 'cmd:auth', title: 'Refresh the credential radar', group: 'Command', keywords: 'auth login sso' })
  items.push({ id: 'cmd:share', title: "Copy this session's identity", group: 'Command', keywords: 'share handoff session id transcript copy' })
  items.push({ id: 'cmd:rca-end', title: 'End RCA mode (revert its grants)', group: 'Command', keywords: 'rca incident alert off' })
  items.push({ id: 'cmd:fold', title: 'Fold finished tool calls', group: 'Command', keywords: 'transcript' })
  items.push({ id: 'cmd:close', title: 'Close the cockpit', group: 'Command', keywords: 'hide exit' })
  return items
}

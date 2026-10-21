// The Web tab while pages open in a TWeb pane beside this one (lib/webside.ts):
// the address field, that pane's tabs and the controls that drive it. TWeb's
// pane draws the page and takes the keys; this tab only reports and commands.

import { WEB_ENGINES, WEB_ENGINE_LABEL, type WebEngine } from '../lib/web'
import { linkOwner, type AutoStep, type SidePanel, type SideWeb, type TwebLink } from '../lib/webside'
import { clip } from '../lib/text'
import { C, field, type Els, type Node } from './common'

export type WebSideView = {
  width: number
  side: SideWeb
  engine: WebEngine // what a new pane opens on (Web settings)
  onOpen: (text: string) => void // the address field's Enter: navigate, or open a pane
  onCmd: (argv: string[]) => void // a tweb command for the driven pane
  onFocus: () => void // put the keyboard on the pane
  onClose: () => void // close the pane
  onEngine: (engine: WebEngine) => void
  onTab: (index: number) => void
  onNewTab: () => void
  onCloseTab: (index: number) => void
  auto: readonly AutoStep[] // browser commands agents ran, newest last
  driving: boolean // one ran in the last few seconds
  onPanel: (panel: SidePanel | undefined) => void
  onClearPanel: () => void
  panelRows: number // lines the open panel may take
  self: string // this session's tmux pane, the owner the TWeb pane shows as linked
  now: number
}

// How long after the person acted on a driven page the tab still says so.
const CONFLICT_SHOWN_MS = 60_000

const LEVEL_COLOR: Record<string, string> = { error: C.bad, warning: C.warn, warn: C.warn }

function hhmmss(at: string | number): string {
  const d = new Date(at)
  return isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

// The panel under the tabs: the pane's console or network (TWeb keeps them per
// page, read with tweb console/network), or what agents did to the browser.
function panel(els: Els, v: WebSideView): Node[] {
  const { Box, Button, Text } = els
  const s = v.side
  const open = s.panel
  const tab = (id: SidePanel, label: string) =>
    Button({ key: 'web-side-panel-' + id, label, plain: true, onPress: () => v.onPanel(open === id ? undefined : id), children: [Text({ color: open === id ? C.accent : C.muted, bold: open === id, children: [(open === id ? '▾ ' : '▸ ') + label] })] })
  const errors = (s.console ?? []).filter((c) => c.level === 'error').length
  const head = Box({
    flexDirection: 'row',
    columnGap: 2,
    paddingX: 1,
    children: [
      tab('console', 'console' + (errors ? ' · ' + errors + ' errors' : '')),
      tab('network', 'network'),
      tab('auto', 'automation' + (v.auto.length ? ' · ' + v.auto.length : '')),
      ...(open && open !== 'auto' ? [Button({ key: 'web-side-panel-clear', label: 'clear', plain: true, onPress: v.onClearPanel, children: [Text({ color: C.faint, children: ['clear'] })] })] : []),
    ],
  })
  if (!open) return [head]
  const n = Math.max(3, v.panelRows)
  const w = Math.max(20, v.width - 4)
  const line = (key: string, parts: Node[]) => Box({ key, flexDirection: 'row', paddingX: 2, children: parts })
  let rows: Node[] = []
  if (open === 'console') {
    rows = (s.console ?? []).slice(-n).map((c, i) =>
      line('web-side-con-' + i, [Text({ color: C.faint, children: [hhmmss(c.at) + ' '] }), Text({ color: LEVEL_COLOR[c.level] ?? C.muted, children: [c.level.slice(0, 4).padEnd(5)] }), Text({ children: [clip(c.text, w - 16)] })]),
    )
  } else if (open === 'network') {
    rows = (s.network ?? []).slice(-n).map((r, i) =>
      line('web-side-net-' + i, [
        Text({ color: r.failed || (r.status ?? 0) >= 400 ? C.bad : C.faint, children: [String(r.status ?? '…').padEnd(4)] }),
        Text({ color: C.muted, children: [r.method.padEnd(5) + r.type.slice(0, 8).padEnd(9)] }),
        Text({ children: [clip(r.url, w - 20)] }),
      ]),
    )
  } else {
    rows = v.auto.slice(-n).map((a, i) =>
      line('web-side-auto-' + i, [
        Text({ color: C.faint, children: [hhmmss(a.at) + ' '] }),
        Text({ color: a.state === 'failed' ? C.bad : a.state === 'running' ? C.accent : C.ok, children: [(a.state === 'running' ? '◐ ' : a.state === 'failed' ? '✗ ' : '✓ ') + a.verb.padEnd(10)] }),
        Text({ color: C.muted, children: [clip(a.detail, w - 30) + (a.pane ? '  ' + a.pane : '')] }),
      ]),
    )
  }
  const unread = (open === 'console' && !s.console) || (open === 'network' && !s.network)
  const empty = open === 'auto' ? 'No browser commands from agents yet (tweb … in Bash, tweb MCP tools).' : unread ? 'reading ' + open + ' from pane ' + (s.pane ?? '') + '…' : 'Nothing recorded for this page yet.'
  if (!rows.length) rows = [line('web-side-panel-empty', [Text({ color: C.faint, children: [empty] })])]
  // Always n rows while open: switching panels, or records arriving, must not
  // move what is drawn below.
  while (rows.length < n) rows.push(line('web-side-pad-' + rows.length, [Text({ children: [' '] })]))
  return [head, ...rows]
}

function upFor(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? m + 'm' : m < 48 * 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '') : Math.floor(m / 1440) + 'd'
}

// The mod ↔ TWeb link, first line of the tab: whether tweb answered the last
// listing, its supervisor, and how many panes it hosts. An unreachable tweb
// otherwise looks the same as "no pane beside".
function linkLine(els: Els, link: TwebLink | undefined): Node {
  const { Box, Text } = els
  if (!link) return Box({ key: 'web-side-link', paddingX: 1, children: [Text({ color: C.faint, children: ['○ tweb · checking…'] })] })
  if (link.state !== 'ok')
    return Box({ key: 'web-side-link', paddingX: 1, children: [Text({ color: C.bad, bold: true, children: [link.state === 'missing' ? '✗ tweb not installed' : '✗ tweb unreachable'] }), Text({ color: C.muted, children: ['  ' + clip(link.detail ?? '', 100)] })] })
  const d = link.daemon
  const bits = [d?.pid ? 'twebd ' + d.pid : 'twebd', d?.uptimeMs ? 'up ' + upFor(d.uptimeMs) : '', d?.panes !== undefined ? d.panes + ' pane' + (d.panes === 1 ? '' : 's') + ' hosted' : '', d?.engine ? 'engine ' + d.engine.replace(/\s*\(pid \d+\)/, '') : ''].filter(Boolean)
  return Box({ key: 'web-side-link', paddingX: 1, children: [Text({ color: C.ok, children: ['● tweb linked'] }), Text({ color: C.faint, children: ['  ' + bits.join(' · ')] })] })
}

// What the TWeb pane shows its person about this cockpit: whether the ⇄ link badge is up, and
// whether they acted on the page while an agent drove it (a race the agent should know of).
function paneSide(els: Els, v: WebSideView): Node {
  const { Box, Text } = els
  const s = v.side
  const owner = linkOwner(v.self)
  const link = s.presence?.link
  const parts: Node[] = []
  if (s.linkUnsupported) parts.push(Text({ color: C.warn, children: ['⇄ this tweb cannot show the link — update tweb'] }))
  else if (link?.owner === owner) parts.push(Text({ color: C.ok, children: ['⇄ pane ' + s.pane + ' shows it is linked here'] }))
  else if (link) parts.push(Text({ color: C.warn, children: ['⇄ pane ' + s.pane + ' is linked to ' + link.owner] }))
  else parts.push(Text({ color: C.faint, children: ['⇄ linking pane ' + s.pane + '…'] }))
  const conflict = s.presence?.conflictAt
  if (conflict && v.now - conflict < CONFLICT_SHOWN_MS) parts.push(Text({ color: C.bad, bold: true, children: ['  ⚠ the person acted on the page while an agent drove it'] }))
  return Box({ key: 'web-side-paneside', flexDirection: 'row', paddingX: 1, children: parts })
}

export function renderWebSide(els: Els, v: WebSideView): Node {
  const { Box, Button, Input, Text } = els
  const s = v.side
  const btn = (key: string, label: string, text: string, press: () => void, color: string = C.accent) =>
    Button({ key, label, plain: true, onPress: press, children: [Text({ color, children: [text] })] })
  const address = Input({
    key: 'web-address',
    label: 'go',
    placeholder: s.pane ? 'URL, host or search — Enter opens it in pane ' + s.pane : 'URL, host or search — Enter opens a TWeb pane beside',
    value: '',
    submitLabel: 'open',
    ...(s.pane ? {} : { autoFocus: true as const }),
    onSubmit: (value) => {
      if (value.trim()) v.onOpen(value)
    },
  })
  const engines = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Text({ color: C.muted, children: ['new pane on'] }),
      ...WEB_ENGINES.map((en) =>
        Button({ key: 'web-side-engine-' + en, label: WEB_ENGINE_LABEL[en], plain: true, onPress: () => v.onEngine(en), children: [Text({ color: v.engine === en ? C.accent : C.muted, bold: v.engine === en, children: [(v.engine === en ? '● ' : '○ ') + WEB_ENGINE_LABEL[en]] })] }),
      ),
    ],
  })
  const note = (text: string, color: string | undefined = C.muted) => Box({ paddingX: 1, children: [Text({ color, children: [text] })] })
  if (!s.pane) {
    return Box({
      flexDirection: 'column',
      children: [linkLine(els, s.link), field(els, address), Box({ paddingX: 1, children: [engines] }), note('No TWeb pane beside this one. Enter a URL to open one; links this session opens go there too.'), ...(v.auto.length ? panel(els, { ...v, side: { ...s, panel: 'auto' } }) : []), ...(s.error ? [note(s.error, C.warn)] : [])],
    })
  }
  const active = s.tabs.find((t) => t.active)
  const controls = Box({
    flexDirection: 'row',
    columnGap: 2,
    paddingX: 1,
    children: [
      Text({ color: C.muted, children: ['pane ' + s.pane + ' · ' + WEB_ENGINE_LABEL[s.engine ?? 'electron']] }),
      btn('web-side-back', 'back', '← back', () => v.onCmd(['back'])),
      btn('web-side-forward', 'forward', '→ fwd', () => v.onCmd(['forward'])),
      btn('web-side-reload', 'reload', '⟳ reload', () => v.onCmd(['reload'])),
      btn('web-side-focus', 'focus the pane', '⌨ focus', v.onFocus),
      btn('web-side-float', s.floating ? 'pin the page back into the pane' : 'float the page as a desktop window', s.floating ? '⧉ pin' : '⧉ float', () => v.onCmd([s.floating ? 'pin' : 'float'])),
      ...(s.engine === 'chrome' ? [btn('web-side-devtools', 'open DevTools', 'devtools', () => v.onCmd(['devtools']))] : []),
      btn('web-side-close', 'close the pane', '✕ close', v.onClose, C.warn),
      // Last in the row: appearing and going, it moves no button. The pane shows the same badge
      // (◐ AGENT) to the person at the page.
      ...(v.driving ? [Text({ color: C.claude, bold: true, inverse: true, children: [' ◐ Claude is driving' + (s.presence?.driving ? ' · ' + s.presence.driving.method : '') + ' '] })] : []),
    ],
  })
  const urlWidth = Math.max(20, v.width - 50)
  const tabs = s.tabs.map((t) =>
    Box({
      key: 'web-side-tabrow-' + t.index,
      flexDirection: 'row',
      columnGap: 1,
      paddingX: 1,
      children: [
        Button({
          key: 'web-side-tab-' + t.index,
          label: t.url || t.title,
          plain: true,
          onPress: () => v.onTab(t.index),
          children: [Text({ color: t.active ? C.accent : C.muted, bold: t.active, children: [(t.active ? '● ' : '○ ') + clip(t.title || '(untitled)', 40) + '  '] }), Text({ color: C.faint, children: [clip(t.url, urlWidth)] })],
        }),
        btn('web-side-tabclose-' + t.index, 'close tab ' + t.index, '✕', () => v.onCloseTab(t.index), C.faint),
      ],
    }),
  )
  return Box({
    flexDirection: 'column',
    children: [
      linkLine(els, s.link),
      paneSide(els, v),
      field(els, address),
      controls,
      ...(active ? [note(clip(active.title || active.url, v.width - 4), undefined)] : []),
      Box({ paddingX: 1, children: [Text({ color: C.muted, children: ['tabs · ' + s.tabs.length] }), Text({ children: ['  '] }), btn('web-side-newtab', 'new tab', '+ new tab', v.onNewTab)] }),
      ...tabs,
      ...panel(els, v),
      Box({ paddingX: 1, children: [engines] }),
      ...(s.others ? [note(s.others + ' more TWeb pane' + (s.others > 1 ? 's' : '') + ' in this window, not driven here', C.faint)] : []),
      ...(s.error ? [note(s.error, C.warn)] : []),
    ],
  })
}

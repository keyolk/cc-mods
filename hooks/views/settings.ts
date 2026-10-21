// The cockpit's own settings (tab 9): where the links Claude opens go, the Web
// tab's defaults, cockpit behaviour, routing, and the keys. Everything here is
// the person's preference for this machine or session, not a safety gate
// (those are the Policy tab's).

import { C, field, row, section, type Els, type Node } from './common'
import { ENGINE_NOTE, WEB_DEVICES, WEB_RATES, type WebSettings } from './web'
import { WEB_ENGINES, WEB_ENGINE_LABEL, type EngineRule } from '../lib/web'

export type SettingsView = {
  width: number
  browser: string // this session's choice: inherit | tweb | tweb-chrome | tweb-webkit | chrome
  target?: string // what tmux-chrome resolves for this pane now
  envBrowser?: string // $BROWSER, what Claude Code opens links with
  embed: boolean // draw TWeb pages in the Web tab instead of a pane beside
  web: WebSettings
  onStart: boolean // open the cockpit when a session starts
  autoResume: boolean // continue a turn a disconnect interrupted
  onAutoResume: (on: boolean) => void
  rcaAuto: boolean // an alert thread pasted into a prompt starts RCA mode
  slashHide: boolean // hide the cockpit while the slash-command typeahead is open
  mcpHeal: boolean // reconnect dropped MCP servers on their own
  onMcpHeal: (on: boolean) => void
  onSlashHide: (on: boolean) => void
  onRcaAuto: (on: boolean) => void
  route: { effort: boolean; model: boolean }
  onBrowser: (b: string) => void
  onEmbed: (on: boolean) => void
  onWeb: (patch: Partial<WebSettings>) => void
  engineRules: readonly EngineRule[] // URL pattern -> engine, first match wins
  onEngineRuleAdd: (text: string) => void
  onEngineRuleRemove: (pattern: string) => void
  onStartChange: (on: boolean) => void
  onRoute: (which: 'effort' | 'model', on: boolean) => void
}

const BROWSERS: [string, string][] = [
  ['inherit', 'inherit (window / global)'],
  ['tweb', 'TWeb'],
  ['tweb-chrome', 'TWeb on Chrome'],
  ['tweb-webkit', 'TWeb on WebKit'],
  ['chrome', 'Chrome tab group'],
]

export function renderSettings(els: Els, v: SettingsView): Node {
  const { Box, Button, Input, Text } = els
  const pick = (group: string, id: string, label: string, on: boolean, press: () => void) =>
    Button({ key: 'set-' + group + '-' + id, label, plain: true, onPress: press, children: [Text({ color: on ? C.accent : C.muted, bold: on, children: [(on ? '● ' : '○ ') + label] })] })
  const line = (name: string, items: Node[], note?: string) =>
    Box({ flexDirection: 'column', children: [row(els, [Box({ width: 10, flexShrink: 0, children: [Text({ bold: true, children: [name] })] }), Box({ flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', flexShrink: 1, children: items })]), ...(note ? [Box({ paddingLeft: 10, children: [Text({ color: C.faint, children: [note] })] })] : [])] })
  const onOff = (group: string, on: boolean, press: (on: boolean) => void) => [pick(group, 'on', 'on', on, () => press(true)), pick(group, 'off', 'off', !on, () => press(false))]

  return Box({
    flexDirection: 'column',
    children: [
      section(els, 'Links', 'where pages Claude opens go'),
      line(
        'open in',
        BROWSERS.map(([id, label]) => pick('browser', id, label, v.browser === id, () => v.onBrowser(id))),
        'now: ' + (v.target || '?') + (v.envBrowser ? '  ·  $BROWSER ' + v.envBrowser : ''),
      ),
      line('Web tab', onOff('embed', v.embed, v.onEmbed), 'off (default): a TWeb pane beside this one, the Web tab (6) drives it; on: pages draw in the Web tab'),

      section(els, 'Web tab', 'defaults for pages opened here'),
      line('engine', WEB_ENGINES.map((en) => pick('engine', en, WEB_ENGINE_LABEL[en], v.web.engine === en, () => v.onWeb({ engine: en }))), ENGINE_NOTE),
      line('device', WEB_DEVICES.map((d) => pick('device', d || 'pane', d || 'Pane', v.web.device === d, () => v.onWeb({ device: d })))),
      line('fps', WEB_RATES.map((r) => pick('fps', String(r), String(r), v.web.rate === r, () => v.onWeb({ rate: r }))), 'drops to 4 at rest'),
      line(
        'by URL',
        v.engineRules.length
          ? v.engineRules.map((r) =>
              Button({ key: 'set-rule-' + r.pattern, label: 'remove ' + r.pattern, plain: true, onPress: () => v.onEngineRuleRemove(r.pattern), children: [Text({ children: [r.pattern] }), Text({ color: C.accent, children: [' → ' + WEB_ENGINE_LABEL[r.engine]] }), Text({ color: C.faint, children: [' ✕'] })] }),
            )
          : [Text({ color: C.muted, children: ['no rules: every page on the engine above'] })],
        'a page whose URL matches opens on that engine (subdomains too, * any, first match wins; ✕ removes)',
      ),
      Box({
        paddingLeft: 10,
        children: [
          field(
            els,
            Input({ key: 'set-rule-input', label: 'add', placeholder: 'claude.ai chrome · *.okta.com chrome · github.com/acme webkit', value: '', submitLabel: 'add', onSubmit: (value) => value.trim() && v.onEngineRuleAdd(value) }),
          ),
        ],
      }),

      section(els, 'Cockpit'),
      line('at start', onOff('start', v.onStart, v.onStartChange), 'open the cockpit when a session starts (this machine)'),
      line('slash list', onOff('slash-hide', v.slashHide, v.onSlashHide), 'hide the cockpit while the prompt shows /command candidates; restore it when the token ends'),
      line('MCP', onOff('mcp-heal', v.mcpHeal, v.onMcpHeal), 'when an MCP call fails because its server dropped, reconnect that server as the turn ends (/mcp reconnect <server> does it by hand)'),
      line('resume', onOff('resume', v.autoResume, v.onAutoResume), 'a turn a disconnect cut off (sleep, VPN, refused) continues once the API answers again'),
      line('RCA', onOff('rca', v.rcaAuto, v.onRcaAuto), 'an alert thread you paste starts RCA mode: read prod, write in the alerting service, post in its channel, for 2h'),

      section(els, 'Routing', 'Jev picks per turn'),
      line('effort', onOff('effort', v.route.effort, (on) => v.onRoute('effort', on)), 'reasoning effort from the request (session policy auto_effort)'),
      line('model', onOff('model', v.route.model, (on) => v.onRoute('model', on)), 'light work to a smaller model; re-caches on a switch (auto_model)'),

      section(els, 'Keys'),
      Text({ color: C.muted, children: ['alt+tab  Claude ⇄ cockpit     alt+w  Web controls ⇄ page     alt+←→  width     alt+s  search     1-9  tabs     ↑↓  move by row'] }),
      Text({ color: C.muted, children: ['alt+<letter>  the tab\'s letter key, also under Korean input (not c s h j k l)'] }),
      Text({ color: C.muted, children: ['i  ask a side question (Chat)     Esc  leave a field     ctrl+x x  close     alt+/  every key'] }),
    ],
  })
}

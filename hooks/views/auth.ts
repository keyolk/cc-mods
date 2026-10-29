// The cockpit's Auth tab: every credential the session's work leans on, by
// kind, with a press that logs in where one can. It used to sit under the
// Policy tab, but a login is not a permission: policy says what Claude may do,
// this says whether the tools it would do it with still work.

import { ICON as AUTH_ICON, foldArgocd, type AuthItem } from '../lib/auth'
import type { McpLogin } from '../lib/mcpauth'
import { C, field, section, type Els, type Node } from './common'

type LoginAction = 'paste' | 'reopen' | 'copy' | 'retry' | 'cancel'

export type AuthView = {
  auth: readonly AuthItem[]
  now: number
  onFix: (a: AuthItem) => void
  login?: McpLogin | null
  onLogin?: (action: LoginAction, value?: string) => void
  mcpOpen: boolean // the connector list unfolded
  onMcpOpen: () => void
  onRefresh: () => void
  onAlt?: (argv: string[]) => void
}

const GROUPS: { title: string; test: (id: string) => boolean; note?: string }[] = [
  { title: 'Cloud and clusters', test: (id) => id === 'aws-sso' || id.startsWith('argocd:') },
  { title: 'Coder', test: (id) => id.startsWith('coder:') },
  { title: 'GitHub', test: (id) => id.startsWith('gh:') },
  { title: 'Claude', test: (id) => id === 'daemon' || id.startsWith('ccproxy:') },
]

export function renderAuthTab(els: Els, v: AuthView): Node {
  const { Box, Button, Text } = els
  const rows: Node[] = []
  if (v.login && v.onLogin) rows.push(mcpLoginCard(els, v.login, v.onLogin))
  const bad = v.auth.filter((a) => (a.state === 'expired' || a.state === 'soon') && !a.id.startsWith('mcp:'))
  if (bad.length) {
    rows.push(section(els, 'Needs you', bad.length + ''))
    for (const a of foldArgocd(bad)) rows.push(authRow(els, a, v))
  }
  for (const g of GROUPS) {
    const items = v.auth.filter((a) => g.test(a.id) && !bad.includes(a))
    if (!items.length) continue
    rows.push(section(els, g.title))
    for (const a of items) rows.push(authRow(els, a, v))
  }
  // MCP servers the person set up (user or project scope) first, always
  // shown: they are the ones the work uses.
  const mine = v.auth.filter((a) => a.id.startsWith('mcp:') && a.mine && !bad.includes(a))
  if (mine.length) {
    rows.push(section(els, 'Your MCP servers', mine.filter((a) => a.state !== 'ok').length + ' need attention'))
    for (const a of mine) rows.push(authRow(els, a, v))
  }
  // The org's claude.ai connectors: Claude Code lists every one it offers,
  // used or not, so the ones without a login stay folded behind a count.
  const mcp = v.auth.filter((a) => a.id.startsWith('mcp:') && !a.mine).sort((a, b) => Number(a.state !== 'ok') - Number(b.state !== 'ok'))
  if (mcp.length) {
    const waiting = mcp.filter((a) => a.state !== 'ok').length
    rows.push(section(els, 'claude.ai connectors', (mcp.length - waiting) + ' connected · ' + waiting + ' without a login'))
    rows.push(
      Button({
        key: 'auth-mcp-toggle',
        label: v.mcpOpen ? 'fold connectors' : 'show connectors',
        hotkey: 'm',
        plain: true,
        onPress: v.onMcpOpen,
        children: [Text({ color: C.muted, children: [(v.mcpOpen ? '▾ ' : '▸ ') + waiting + ' without a login · press one to log in (or /auth <name>)'] })],
      }),
    )
    // Connected ones are in the radar but need nothing: only the rest unfold.
    // ... and one just authorized from here, until a restart picks it up.
    if (v.mcpOpen) for (const a of mcp.filter((x) => x.state !== 'ok' || /restart/.test(x.detail ?? ''))) rows.push(authRow(els, a, v))
  }
  if (!rows.length) rows.push(Text({ color: C.muted, children: ['No credentials checked yet.'] }))
  rows.push(
    Box({
      marginTop: 1,
      children: [Button({ key: 'auth-refresh', label: 'refresh', hotkey: 'r', plain: true, onPress: v.onRefresh, children: [Text({ color: C.muted, children: ['⟳ check again'] })] })],
    }),
  )
  return Box({ flexDirection: 'column', children: rows })
}

function authRow(els: Els, a: AuthItem, v: AuthView): Node {
  const { Box, Button, Text } = els
  const tone = a.state === 'expired' ? C.bad : a.state === 'soon' ? C.warn : a.state === 'ok' ? C.ok : C.muted
  const left = a.expiresAt ? Math.round((a.expiresAt - v.now) / 60000) : undefined
  // ccproxy rows carry their own state and quota line; a bare "expired"
  // would drop the why (auth-failed vs expired) and the remaining quota.
  const own = a.id.startsWith('ccproxy:')
  const meta = own ? (a.detail ?? '') : a.state === 'expired' ? 'expired' : left !== undefined && left > 0 ? (left >= 120 ? Math.round(left / 60) + 'h' : left + 'm') + ' left' : (a.detail ?? '')
  // A row with a second way out carries why in its detail: show it beside the time.
  const why = (a.alt || a.batch) && a.detail && !meta.includes(a.detail) ? ' · ' + a.detail : ''
  const label = a.id.startsWith('mcp:') ? a.label.replace(/^MCP /, '') : a.label
  const row = [Text({ color: tone, children: [AUTH_ICON[a.state] + ' '] }), Text({ bold: a.state !== 'ok', children: [label] }), Text({ color: C.muted, children: ['  ' + meta + why] })]
  const main = a.fix && a.state !== 'ok'
    ? Button({ key: 'auth-row-' + a.id, label, plain: true, onPress: () => v.onFix(a), children: [...row, Text({ color: C.accent, children: [a.batch ? '  → log in to each' : '  → log in'] })] })
    : Box({ key: 'auth-row-' + a.id, flexDirection: 'row', children: row })
  if (!a.alt || !v.onAlt) return main
  const alt = a.alt
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [main, Button({ key: 'auth-alt-' + a.id, label: alt.label, plain: true, onPress: () => v.onAlt!(alt.argv), children: [Text({ color: C.accent, children: ['↗ ' + alt.label] })] })],
  })
}

// The MCP login in progress: where it stands, the URL to open again, and a
// field for the callback URL when the browser could not reach localhost.
export function mcpLoginCard(els: Els, l: McpLogin, on: (action: 'paste' | 'reopen' | 'copy' | 'retry' | 'cancel', value?: string) => void): Node {
  const { Box, Button, Input, Text } = els
  const name = l.server.replace(/^claude\.ai /, '')
  const tone = l.status === 'done' ? C.ok : l.status === 'failed' ? C.bad : C.accent
  const head =
    l.status === 'starting' ? 'asking ' + name + ' for a login link…'
      : l.status === 'waiting' ? (l.claudeAi ? 'authorize ' + name + ' on claude.ai in the browser that opened; this updates when it is connected' : 'log in to ' + name + ' in the browser that opened; this updates when it is done')
        : l.status === 'done' ? name + ': ' + (l.msg ?? 'logged in')
          : name + ' login failed: ' + (l.msg ?? '')
  const rows: Node[] = [Text({ bold: true, color: tone, children: ['🔑 ' + head] })]
  if (l.status === 'waiting' && !l.claudeAi) {
    rows.push(Text({ color: C.muted, children: ['If the browser shows a localhost page that failed to load, paste its address here:'] }))
    rows.push(field(els, Input({ key: 'mcp-callback', label: 'callback URL', placeholder: 'http://localhost:…/callback?code=…', value: '', submitLabel: 'finish', onSubmit: (value) => on('paste', value) })))
  }
  rows.push(
    Box({
      flexDirection: 'row',
      columnGap: 3,
      children: [
        ...(l.status === 'waiting' && l.url
          ? [
              Button({ key: 'mcp-reopen', label: 'open the login page again', plain: true, onPress: () => on('reopen'), children: [Text({ color: C.accent, children: ['↗ open again'] })] }),
              // Opened where it cannot be seen (another Chrome, a locked screen): paste it yourself.
              Button({ key: 'mcp-copy', label: 'copy the login link', plain: true, onPress: () => on('copy'), children: [Text({ color: C.accent, children: ['⧉ copy link'] })] }),
            ]
          : []),
        ...(l.status === 'failed' ? [Button({ key: 'mcp-retry', label: 'try again', plain: true, onPress: () => on('retry'), children: [Text({ color: C.accent, children: ['⟳ try again'] })] })] : []),
        ...(l.status !== 'done' ? [Button({ key: 'mcp-cancel', label: 'cancel', plain: true, onPress: () => on('cancel'), children: [Text({ color: C.muted, children: ['✕ cancel'] })] })] : []),
      ],
    }),
  )
  return Box({ flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, marginBottom: 1, children: rows })
}


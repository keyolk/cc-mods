// The band above the prompt: credential radar, the session's PRs, neighbors,
// and a fork offer. Every part is optional and the band is empty when there is
// nothing worth a row, so it never costs vertical space for nothing.
//
// Each row starts with a colored bar and a fixed-width category, so the eye
// can scan the left edge: red means act now, yellow means soon, muted means
// for information. The first version mixed bare words ("auth", a repo name,
// "이웃") at different positions, and nothing told a failing PR from a fine one.

import { forkAge, type ForkOffer } from '../lib/fork'
import { foldArgocd, ICON, type AuthItem } from '../lib/auth'
import type { MonitorState } from '../lib/monitor'
import { needsAttention, prLine, type PrStatus } from '../lib/prs'
import { clip, pad } from '../lib/text'
import { C, prTone, type Els, type Node } from './common'

export type Neighbor = { window: string; state: string; title: string }

export type BandView = {
  auth: readonly AuthItem[]
  prs: readonly PrStatus[]
  neighbors: readonly Neighbor[]
  // Monitors, only while the cockpit is closed (it shows them otherwise).
  monitors?: readonly MonitorState[]
  now?: number
  fork?: ForkOffer
  forkEffect?: string // what a press does now (lib/fork.ts)
  // The cockpit is open and asks the fork question itself: draw it as text.
  // Any Button here takes abovePrompt:focus (alt+c) ahead of the open pane.
  forkInCockpit?: boolean
  width: number
  onFix: (item: AuthItem) => void
  onPr: (pr: PrStatus, action: 'open' | 'followup' | 'review') => void
  onFork: (yes: boolean) => void
}

const STATE_ICON: Record<string, string> = { working: '⏳', waiting: '❓', done: '🟢' }

function line(els: Els, tone: string, label: string, children: Node[]): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [Text({ color: tone, children: ['▎'] }), Text({ color: tone, bold: true, children: [pad(label, 5)] }), ...children],
  })
}

export function renderBand(els: Els, v: BandView): Node | undefined {
  const { Box, Text, Button } = els
  const lines: Node[] = []
  const now = Date.now()

  const bad = foldArgocd(v.auth.filter((a) => a.state === 'expired' || a.state === 'soon'))
  if (bad.length) {
    const expired = bad.some((a) => a.state === 'expired')
    lines.push(
      line(els, expired ? C.bad : C.warn, 'auth', [
        ...bad.slice(0, 4).map((a) =>
          Button({
            key: 'auth-' + a.id,
            label: a.label,
            plain: true,
            onPress: () => v.onFix(a),
            children: [
              Text({ color: a.state === 'expired' ? C.bad : C.warn, children: [ICON[a.state] + ' '] }),
              Text({ children: [a.label] }),
              Text({
                color: C.muted,
                children: [a.state === 'soon' && a.expiresAt ? ' ' + Math.max(1, Math.ceil((a.expiresAt - now) / 60000)) + 'm left' : a.state === 'expired' ? ' expired' : ''],
              }),
            ],
          }),
        ),
        ...(bad.some((a) => a.fix) ? [Text({ color: C.faint, children: ['  press to log in'] })] : []),
      ]),
    )
  }

  const open = v.prs.filter((p) => p.state === 'OPEN' || now - p.at < 30 * 60_000)
  for (const pr of open.slice(0, 3)) {
    const need = needsAttention(pr)
    const tone = prTone(pr)
    lines.push(
      line(els, tone, 'PR', [
        Button({ key: 'pr-open-' + pr.key, label: pr.key, plain: true, onPress: () => v.onPr(pr, 'open'), children: [Text({ bold: true, children: [clip(pr.key, 36)] })] }),
        Text({ color: tone, children: [prLine(pr)] }),
        ...(need && need !== 'ready'
          ? [Button({ key: 'pr-fu-' + pr.key, label: 'follow up', plain: true, onPress: () => v.onPr(pr, 'followup'), children: [Text({ color: C.accent, children: [' → follow up'] })] })]
          : []),
        ...(pr.state === 'OPEN' && pr.approvals === 0 && !pr.isDraft
          ? [Button({ key: 'pr-rv-' + pr.key, label: 'request review', plain: true, onPress: () => v.onPr(pr, 'review'), children: [Text({ color: C.muted, children: [' → request review'] })] })]
          : []),
      ]),
    )
  }
  if (open.length > 3) lines.push(line(els, C.muted, '', [Text({ color: C.muted, children: [(open.length - 3) + ' more PRs · /outputs pr'] })]))

  // Watches: the routine events left the transcript, so one row says they are
  // alive and what the newest one saw. Gone after an hour of silence.
  const now2 = v.now ?? now
  const live = (v.monitors ?? []).filter((m) => now2 - m.at < 60 * 60_000).sort((a, b) => b.at - a.at)
  if (live.length) {
    const top = live[0]!
    const mins = Math.max(0, Math.round((now2 - top.at) / 60000))
    const quiet = live.reduce((n, m) => n + m.quiet, 0)
    lines.push(
      line(els, top.mattered ? C.warn : C.muted, 'watch', [
        Text({ color: top.mattered ? C.warn : C.accent, children: [(top.mattered ? '❗ ' : '⟳ ') + clip(top.summary, 40)] }),
        Text({ color: C.muted, children: [' · ' + top.label + ' · ' + (mins ? mins + 'm ago' : 'just now')] }),
        Text({ color: C.faint, children: [(live.length > 1 ? '  +' + (live.length - 1) + ' more' : '') + (quiet ? '  · folded ' + quiet : '') + '  /cockpit'] }),
      ]),
    )
  }

  if (v.neighbors.length) {
    lines.push(
      line(
        els,
        C.muted,
        'peers',
        v.neighbors.slice(0, 3).map((n) =>
          Text({ color: C.muted, children: [(STATE_ICON[n.state] ?? '·') + ' ' + n.window + (n.title ? ' · ' + clip(n.title, 24) : '') + '   '] }),
        ),
      ),
    )
  }

  if (v.fork) {
    lines.push(
      line(els, C.warn, 'fork', [
        Text({ children: [clip(v.fork.prompt.replace(/\s+/g, ' '), 32) + ' · a separate task? '] }),
        Text({ color: C.muted, children: [forkAge(v.fork, v.now ?? Date.now()) + (v.forkEffect && !v.forkInCockpit ? ' · ' + v.forkEffect + '  ' : '  ')] }),
        ...(v.forkInCockpit
          ? [Text({ color: C.accent, children: ['answer in the cockpit (alt+tab)'] })]
          : [
              Button({ key: 'fork-yes', label: 'fork to new pane', hotkey: '1', plain: true, onPress: () => v.onFork(true) }),
              Button({ key: 'fork-no', label: 'continue here', hotkey: '2', plain: true, onPress: () => v.onFork(false) }),
            ]),
      ]),
    )
  }

  if (lines.length === 0) return undefined
  return Box({ flexDirection: 'column', children: lines })
}

// The cockpit's Usage tab: ccproxy's view of this session (ccproxy usage) and
// every account's quota (ccproxy status), with room the Now tab's Model card
// does not have — per-account rows with quota windows and reset times, models,
// and output and request trends over a chosen window.

import { kTokens, clip, ago, hhmm } from '../lib/text'
import { accountStrip, bar, cacheHit, effortMix, hookName, modelStrip, seriesBy, share, shortModel, span, sparkline, until, usd, type JevUsage, type Quota, type Usage } from '../lib/usage'
import { C, section, type Els, type Node } from './common'

export type UsageWindow = '1h' | '6h' | 'session'

// 'session' lets ccproxy size the buckets to the whole session (PR #265).
export const USAGE_WINDOWS: Record<UsageWindow, { bucket: string; buckets: number; label: string; hotkey: string }> = {
  '1h': { bucket: '5m', buckets: 12, label: 'last hour, 5m buckets', hotkey: 'h' },
  '6h': { bucket: '30m', buckets: 12, label: 'last 6 hours, 30m buckets', hotkey: 'w' },
  session: { bucket: 'session', buckets: 24, label: 'whole session', hotkey: 's' },
}

export type UsageView = {
  width: number
  now: number
  usage?: Usage
  note?: string
  quota: readonly Quota[]
  jev?: JevUsage
  window: UsageWindow
  onWindow: (w: UsageWindow) => void
  onRefresh: () => void
}

export function renderUsage(els: Els, v: UsageView): Node {
  const { Box, Button, Text } = els
  // Columns are fixed-width boxes: runs of spaces inside one Text are drawn as
  // one, so padEnd does not line anything up.
  const cols = (cells: [string, number, string?][], tone?: string, bold = false) =>
    Box({ flexDirection: 'row', children: cells.map(([t, width, color]) => Box({ width, flexShrink: 0, children: [Text({ color: color ?? tone, bold, children: [clip(t, width - 1)] })] })) })
  // The whole-session window starts at the session's first busy bucket:
  // ccproxy sizes buckets to cover the session, so the leading ones are
  // before it began and only push the start time on the axis off.
  const raw = v.usage
  const lead = raw && v.window === 'session' ? Math.max(0, raw.trend.findIndex((b) => b.requests > 0)) : 0
  const u = raw && lead > 0 ? { ...raw, trend: raw.trend.slice(lead) } : raw
  const w = v.width - 2
  const rows: Node[] = []
  const muted = (s: string) => Text({ color: C.muted, children: [s] })
  // Under a sparkline: its first bucket's clock time at the left, "now" at the
  // right. Boxes, not padding: runs of spaces in one Text draw as one.
  const axis = (start: number, n: number, indent = 10) =>
    Box({ flexDirection: 'row', children: [Box({ width: indent, flexShrink: 0 }), Box({ width: Math.max(6, n - 3), flexShrink: 0, children: [muted(hhmm(start * 1000))] }), muted('now')] })

  rows.push(section(els, 'Last request', u?.last ? ago(u.last.at * 1000, v.now) + ' ago' : ''))
  if (u?.last) {
    const l = u.last
    rows.push(Text({ bold: true, children: [clip((l.account ?? '?') + ' · ' + shortModel(l.model) + (l.effort ? ' · effort ' + l.effort : ''), w)] }))
    rows.push(muted(clip((l.reason ? 'chosen: ' + l.reason + ' · ' : '') + (l.ms / 1000).toFixed(1) + 's · status ' + l.status + ' · out ' + kTokens(l.tokens.output) + ' · cache read ' + kTokens(l.tokens.cache_read), w)))
  } else rows.push(muted(v.note ?? 'No requests through ccproxy yet.'))

  // The session as a whole: how long, how much, and how well the cache held.
  if (u && u.requests > 0) {
    const t = u.totals
    rows.push(section(els, 'Session', u.firstAt ? 'since ' + hhmm(u.firstAt * 1000) + ' · ' + ago(u.firstAt * 1000, v.now) : ''))
    rows.push(cols([[u.requests + ' req', 12], ['out ' + kTokens(t.output), 12], ['in ' + kTokens(t.input + t.cache_create), 12], ['cache hit ' + cacheHit(t), 16]]))
    rows.push(muted(clip('cache read ' + kTokens(t.cache_read) + ' · cache write ' + kTokens(t.cache_create) + ' · fresh input ' + kTokens(t.input), w)))
  }

  // This session by account: which accounts carried it and when, over the
  // trend window (ccproxy by_account, PR #267). The quota rows below are every
  // account's state across all sessions; this is only what this session used.
  const win0 = USAGE_WINDOWS[v.window]
  const bySession = u ? seriesBy(u.trend, 'by_account', 'requests') : []
  if (u && bySession.length) {
    const names0 = bySession.map((s) => s.name)
    const peak = Math.max(1, ...u.trend.map((b) => b.requests))
    const { strip, switches } = accountStrip(u.trend, names0)
    rows.push(section(els, 'This session by account', (v.window === 'session' ? 'whole session, ' + span(u.bucket_seconds) + ' buckets' : win0.label) + (switches ? ' · switched ' + switches + '×' : '')))
    bySession.forEach((sr, i) => {
      const g = u.accounts.find((a) => a.name === sr.name)
      const out = seriesBy(u.trend, 'by_account').find((x) => x.name === sr.name)?.total ?? 0
      const current = sr.name === u.last?.account
      rows.push(
        Box({
          flexDirection: 'row',
          children: [
            Box({ width: 22, flexShrink: 0, children: [Text({ color: current ? C.accent : undefined, bold: current, children: [clip((current ? '● ' : '○ ') + String.fromCharCode(97 + Math.min(i, 25)) + ' ' + sr.name, 21)] })] }),
            Text({ color: C.accent, children: [sparkline([...sr.values, peak]).slice(0, -1)] }),
            muted('  ' + sr.total + ' req · out ' + kTokens(out) + (g ? ' · ' + share(g.requests, u.requests) + ' of the session' : '')),
          ],
        }),
      )
    })
    rows.push(Box({ flexDirection: 'row', children: [Box({ width: 22, flexShrink: 0, children: [muted('served by')] }), Text({ children: [strip] }), muted('  letter = account above (lower: shared)')] }))
    rows.push(axis(u.trend[0]!.start, u.trend.length, 22))
  }

  // Quota: every account as ccproxy status sees it, beside this session's totals on it.
  rows.push(section(els, 'Accounts', 'quota across all sessions · ' + (u ? u.requests + ' requests this session' : '')))
  const used = new Map((u?.accounts ?? []).map((a) => [a.name, a]))
  const names = [...new Set([...(u?.accounts ?? []).map((a) => a.name), ...v.quota.map((q) => q.name)])]
  for (const name of names) {
    const a = used.get(name)
    const q = v.quota.find((x) => x.name === name)
    const current = name === u?.last?.account
    const tone = q?.state === 'expired' || q?.state === 'auth-failed' ? C.bad : q?.state === 'cooldown' ? C.warn : current ? C.accent : undefined
    rows.push(
      a
        ? cols([[(current ? '● ' : '○ ') + name, 22], [share(a.requests, u!.requests), 6], [a.requests + ' req', 10], ['out ' + kTokens(a.tokens.output), 12]], tone, current)
        : cols([['○ ' + name, 22], ['not used here', 28, C.faint]], tone),
    )
    const fmt = (win: { label: string; left: number; resetAt?: number; active?: boolean }) =>
      win.label + ' ' + bar(win.left, 8) + ' ' + Math.round(win.left) + '%' + (until(win.resetAt, v.now) ? ' ↻' + until(win.resetAt, v.now) : '') + (win.active ? ' ◀ binding' : '')
    // All-models windows on one row, each model's own allowance (Fable) on the
    // next, so a full weekly window does not read as the model being out too.
    const all = q?.windows.filter((x) => !x.scoped) ?? []
    const own = q?.windows.filter((x) => x.scoped) ?? []
    const quotaLine = q ? (all.length ? all.map(fmt).join(' · ') : (q.note ?? '')) : 'no quota from ccproxy status'
    const state = q && q.state !== 'ready' ? '  [' + q.state + (until(q.cooldownUntil, v.now) ? ' ' + until(q.cooldownUntil, v.now) : '') + ']' : ''
    rows.push(Box({ paddingLeft: 4, children: [Text({ color: tone === C.bad || tone === C.warn ? tone : C.muted, children: [clip(quotaLine + state, w - 4)] })] }))
    if (own.length) rows.push(Box({ paddingLeft: 4, children: [Text({ color: C.muted, children: [clip('own: ' + own.map(fmt).join(' · '), w - 4)] })] }))
  }

  rows.push(section(els, 'Models'))
  if (u?.models.length) {
    for (const m of u.models) {
      const mean = m.ms !== undefined && m.requests ? (m.ms / m.requests / 1000).toFixed(1) + 's avg' : ''
      rows.push(cols([[shortModel(m.name), 22], [share(m.requests, u.requests), 6], [m.requests + ' req', 10], ['out ' + kTokens(m.tokens.output), 12], [mean, 10]]))
      // Effort mix and cache hit per model: the cost side of routing picks.
      const detail = [effortMix(m.efforts), cacheHit(m.tokens) ? 'cache hit ' + cacheHit(m.tokens) : ''].filter(Boolean).join(' · ')
      if (detail) rows.push(Box({ paddingLeft: 2, children: [muted(clip(detail, w - 2))] }))
    }
  } else rows.push(muted('—'))

  // Jev: the decision model the hooks ask (fork hint, routing, guards). Its
  // reply carries what the gateway billed, mostly a flat per-request fee.
  rows.push(section(els, 'Jev', 'hooks · AI Gateway'))
  if (v.jev) {
    const j = v.jev
    const lat = (x: { p50?: number; p95?: number }) => (x.p50 ? 'p50 ' + x.p50 + 'ms · p95 ' + x.p95 + 'ms' : '')
    rows.push(cols([['today', 10, C.muted], [j.today.calls + ' calls', 14], [usd(j.today.cost), 12], [kTokens(j.today.in) + ' in', 12]]))
    rows.push(cols([['7 days', 10, C.muted], [j.week.calls + ' calls', 14], [usd(j.week.cost), 12], [kTokens(j.week.in) + ' in', 12]]))
    if (j.session) rows.push(cols([['this', 10, C.muted], [j.session.calls + ' calls', 14], [usd(j.session.cost), 12], [lat(j.session), 26, C.muted]]))
    if (j.hours.length) {
      const calls = j.hours.map((h) => h.calls)
      rows.push(Box({ flexDirection: 'row', children: [Box({ width: 10, children: [muted('24h')] }), Text({ color: C.accent, children: [sparkline(calls)] }), muted('  peak ' + Math.max(0, ...calls) + '/h · ' + usd(j.hours.reduce((x, h) => x + h.cost, 0)))] }))
      rows.push(axis(j.hours[0]!.start, j.hours.length))
    }
    // ask = one yes/no, choose = one of several (routing, attention).
    for (const k of j.kinds) rows.push(cols([['  ' + k.name, 10, C.muted], [k.calls + ' calls', 14], [usd(k.cost), 12], [lat(k), 26, C.muted]]))
    if (j.callers.length) {
      rows.push(muted('by hook (7 days)'))
      for (const c of j.callers) {
        const kinds = Object.entries(c.kinds ?? {}).map(([k, n]) => k + ' ' + n).join(' ')
        rows.push(cols([['  ' + hookName(c.name), 22], [c.calls + (c.today !== undefined ? ' (' + c.today + ' today)' : ''), 16], [usd(c.cost), 10], [c.p50 ? c.p50 + 'ms' : '', 8, C.muted], [kinds, 18, C.faint]]))
      }
    }
    if (j.gateway) rows.push(muted(clip('gateway, whole team since ' + j.gateway.since + ': ' + j.gateway.requests + ' calls · ' + usd(j.gateway.cost) + ' (hours late)', w)))
  } else rows.push(muted('no Jev calls recorded yet (~/.claude/state/jev-usage.jsonl)'))

  const win = USAGE_WINDOWS[v.window]
  rows.push(section(els, 'Trend', v.window === 'session' && u ? 'whole session, ' + span(u.bucket_seconds) + ' buckets' : win.label))
  if (u?.trend.length) {
    const line = (label: string, values: number[], color: string, total: (xs: number[]) => string) =>
      Box({ flexDirection: 'row', children: [Box({ width: 10, children: [muted(label)] }), Text({ color, children: [sparkline(values)] }), muted('  ' + total(values))] })
    const tok = (xs: number[]) => 'peak ' + kTokens(Math.max(0, ...xs)) + ' · total ' + kTokens(xs.reduce((x, y) => x + y, 0))
    rows.push(line('output', u.trend.map((b) => b.output), C.accent, tok))
    rows.push(line('requests', u.trend.map((b) => b.requests), C.merged, (xs) => 'peak ' + Math.max(0, ...xs) + ' · total ' + xs.reduce((x, y) => x + y, 0)))
    // Cache columns come from ccproxy with PR #265; an older one leaves them out.
    if (u.trend.some((b) => b.cache_read !== undefined)) {
      rows.push(line('cache rd', u.trend.map((b) => b.cache_read ?? 0), C.muted, tok))
      // A write spike mid-session is a cache break: a changed effort or model, or a cold TTL.
      rows.push(line('cache wr', u.trend.map((b) => b.cache_create ?? 0), C.warn, tok))
    }
    // The same output, one line per model and per account (ccproxy PR #267):
    // every line scaled to the session's busiest bucket, so they compare.
    const peak = Math.max(1, ...u.trend.map((b) => b.output))
    const split = (title: string, by: 'by_model' | 'by_account', name: (n: string) => string) => {
      const ss = seriesBy(u.trend, by)
      if (!ss.length) return
      rows.push(Box({ marginTop: 1, children: [muted(title)] }))
      for (const sr of ss.slice(0, 5))
        rows.push(Box({ flexDirection: 'row', children: [Box({ width: 18, flexShrink: 0, children: [Text({ children: [clip(name(sr.name), 17)] })] }), Text({ color: C.accent, children: [sparkline([...sr.values, peak]).slice(0, -1)] }), muted('  ' + kTokens(sr.total) + ' out · ' + share(sr.total, u.totals.output || 1))] }))
    }
    split('output by model', 'by_model', shortModel)
    if (u.trend.some((b) => b.models)) rows.push(Box({ flexDirection: 'row', children: [Box({ width: 10, children: [muted('model')] }), Text({ children: [modelStrip(u.trend)] }), muted('  O opus · S sonnet · H haiku · F fable (lower: mixed)')] }))
    rows.push(axis(u.trend[0]!.start, u.trend.length))
  } else rows.push(muted('—'))

  rows.push(
    Box({
      flexDirection: 'row',
      columnGap: 3,
      marginTop: 1,
      children: [
        ...(['1h', '6h', 'session'] as const).map((k) =>
          Button({ key: 'usage-window-' + k, label: k, hotkey: USAGE_WINDOWS[k].hotkey, plain: true, onPress: () => v.onWindow(k), children: [Text({ color: v.window === k ? C.accent : C.muted, children: [(v.window === k ? '● ' : '○ ') + k] })] }),
        ),
        Button({ key: 'usage-refresh', label: 'refresh', hotkey: 'r', plain: true, onPress: v.onRefresh, children: [Text({ color: C.muted, children: ['⟳ refresh'] })] }),
      ],
    }),
  )
  return Box({ flexDirection: 'column', children: rows })
}

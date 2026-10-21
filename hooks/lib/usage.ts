// ccproxy's view of this session (`ccproxy usage --session <sid> --json`)
// beside each account's quota (`ccproxy status --json`): which
// account and model served the last request, how this session splits across
// them, and how its output has trended. Pure: parse and draw-ready strings.

type Tokens = { input: number; output: number; cache_read: number; cache_create: number }

export type UsageGroup = {
  name: string
  requests: number
  tokens: Tokens
  // Summed request time and requests by effort; ccproxy before PR #265 has neither.
  ms?: number
  efforts?: Record<string, number>
}

export type Usage = {
  requests: number
  last?: { at: number; account?: string; model?: string; effort?: string; status: number; reason?: string; ms: number; tokens: { output: number; cache_read: number } }
  totals: Tokens
  accounts: UsageGroup[]
  models: UsageGroup[]
  trend: { start: number; requests: number; output: number; input?: number; cache_read?: number; cache_create?: number; models?: Record<string, number>; by_model?: Record<string, UsageSlice>; by_account?: Record<string, UsageSlice> }[]
  bucket_seconds: number
  firstAt?: number
}

// One model's or account's share of a trend bucket (ccproxy PR #267).
export type UsageSlice = { requests: number; output: number; input: number; cache_read: number }

// One series per model or per account across the trend, busiest first: what
// each drew in each bucket, 0 where it drew nothing. Empty from a ccproxy that
// does not split its buckets.
export function seriesBy(trend: Usage['trend'], by: 'by_model' | 'by_account', field: 'output' | 'requests' = 'output'): { name: string; values: number[]; total: number }[] {
  const names = new Map<string, number>()
  for (const b of trend) for (const [n, sl] of Object.entries(b[by] ?? {})) names.set(n, (names.get(n) ?? 0) + sl[field])
  return [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, total, values: trend.map((b) => b[by]?.[name]?.[field] ?? 0) }))
}

// Which account served each trend bucket: one letter per account (its index
// in `names`, a b c …), upper case when it served all the bucket's requests,
// a space for an empty bucket; and how often the session moved between
// accounts from one busy bucket to the next.
export function accountStrip(trend: Usage['trend'], names: readonly string[]): { strip: string; switches: number } {
  let prev = ''
  let switches = 0
  const strip = trend
    .map((b) => {
      const e = Object.entries(b.by_account ?? {}).sort((x, y) => y[1].requests - x[1].requests)
      if (!e.length) return ' '
      const top = e[0]![0]
      if (prev && top !== prev) switches++
      prev = top
      const i = names.indexOf(top)
      const ch = i >= 0 && i < 26 ? String.fromCharCode(97 + i) : '?'
      return e.length === 1 ? ch.toUpperCase() : ch
    })
    .join('')
  return { strip, switches }
}

const NO_TOKENS: Tokens = { input: 0, output: 0, cache_read: 0, cache_create: 0 }

export function parseUsage(json: string | undefined): Usage | undefined {
  let raw: any
  try {
    raw = json ? JSON.parse(json) : undefined
  } catch {
    return undefined
  }
  if (!raw || typeof raw.requests !== 'number' || !Array.isArray(raw.trend)) return undefined
  const group = (g: any): UsageGroup => ({ ...g, tokens: { ...NO_TOKENS, ...(g?.tokens ?? {}) } })
  return {
    requests: raw.requests,
    last: raw.last ?? undefined,
    totals: { ...NO_TOKENS, ...(raw.totals ?? {}) },
    accounts: Array.isArray(raw.accounts) ? raw.accounts.map(group) : [],
    models: Array.isArray(raw.models) ? raw.models.map(group) : [],
    trend: raw.trend,
    bucket_seconds: Number(raw.bucket_seconds) || 300,
    firstAt: Number(raw.first_at) || undefined,
  }
}

// What share of the prompt was served from cache: reads over everything the
// requests sent (fresh input, cache writes and reads). '' with nothing sent.
export function cacheHit(t: Tokens): string {
  const sent = t.input + t.cache_create + t.cache_read
  return sent > 0 ? Math.round((t.cache_read / sent) * 100) + '%' : ''
}

// "medium 98% · high 2%": a group's requests by effort, most used first.
export function effortMix(efforts: Record<string, number> | undefined): string {
  const e = Object.entries(efforts ?? {}).sort((a, b) => b[1] - a[1])
  const n = e.reduce((x, [, c]) => x + c, 0)
  return e.map(([k, c]) => k + ' ' + share(c, n)).join(' · ')
}

// One letter per trend bucket: the family of the model that served most of its
// requests (o opus, s sonnet, h haiku, f fable, ? other), upper case when that
// model served all of them; a space for an empty bucket.
export function modelStrip(trend: Usage['trend']): string {
  return trend
    .map((b) => {
      const e = Object.entries(b.models ?? {}).sort((x, y) => y[1] - x[1])
      if (!e.length) return ' '
      const fam = /opus/.test(e[0]![0]) ? 'o' : /sonnet/.test(e[0]![0]) ? 's' : /haiku/.test(e[0]![0]) ? 'h' : /fable/.test(e[0]![0]) ? 'f' : '?'
      return e.length === 1 ? fam.toUpperCase() : fam
    })
    .join('')
}

// A bucket width as 5m / 2h / 2h15m.
export function span(seconds: number): string {
  const m = Math.round(seconds / 60)
  const h = Math.floor(m / 60)
  return h ? h + 'h' + (m % 60 ? (m % 60) + 'm' : '') : m + 'm'
}

const BARS = '▁▂▃▄▅▆▇█'

// One glyph per bucket, scaled to the window's busiest bucket; an empty bucket
// is a space so a quiet stretch reads as a gap, not as low activity.
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  if (max === 0) return values.map(() => ' ').join('')
  return values.map((v) => (v <= 0 ? ' ' : BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1)))]!)).join('')
}

// claude-opus-5-5 → opus-5-5; a dated id keeps its family and version.
export function shortModel(model: string | undefined): string {
  if (!model) return '?'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

// "52%" of a group's requests, for a split line.
export function share(n: number, total: number): string {
  return total > 0 ? Math.round((n / total) * 100) + '%' : '0%'
}

// Each ccproxy account's quota as `ccproxy status --json` gives it, kept raw
// enough to draw windows with their reset times.
export type QuotaWindow = { label: string; left: number; resetAt?: number; scoped?: boolean; active?: boolean }
export type Quota = { name: string; state: string; windows: QuotaWindow[]; note?: string; cooldownUntil?: number }

export function parseQuota(json: string | undefined): Quota[] {
  let raw: any
  try {
    raw = json ? JSON.parse(json) : undefined
  } catch {
    return []
  }
  if (!Array.isArray(raw?.accounts)) return []
  return raw.accounts.map((a: any): Quota => {
    const b = a.budget ?? {}
    const w = (label: string, x: any): QuotaWindow[] => (typeof x?.left_pct === 'number' ? [{ label, left: x.left_pct, resetAt: x.reset_at }] : [])
    // A model's own weekly allowance (Fable) beside the all-models windows:
    // ccproxy status budget.scoped, from the usage endpoint.
    const scoped: QuotaWindow[] = Array.isArray(b.scoped)
      ? b.scoped.filter((x: any) => typeof x?.left_pct === 'number' && x.model).map((x: any) => ({ label: String(x.model), left: x.left_pct, resetAt: x.reset_at, scoped: true, active: !!x.active }))
      : []
    const windows = b.kind === 'windows' ? [...w('5h', b.five_hour), ...w('7d', b.seven_day), ...scoped] : b.kind === 'pool' ? w(b.pool_name ?? 'pool', b.pool) : []
    const note = b.kind === 'spend_cap' ? (b.capped ? 'spend cap hit' : 'spend cap: not capped') : b.kind === 'requests' ? b.requests_remaining + '/' + b.requests_limit + ' requests' : windows.length ? undefined : (b.reason ?? 'no usage API')
    return { name: String(a.name), state: String(a.state ?? 'ready'), windows, note, cooldownUntil: a.cooldown_until }
  })
}

// A left-percentage as a bar of `cells`: filled for what is left.
export function bar(left: number, cells = 10): string {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return '█'.repeat(n) + '░'.repeat(cells - n)
}

// Seconds until an epoch-seconds instant, as 4h12m / 3d4h; '' when past or unknown.
export function until(at: number | undefined, nowMs: number): string {
  if (!at) return ''
  const s = Math.round(at - nowMs / 1000)
  if (s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h >= 48) return Math.floor(h / 24) + 'd' + (h % 24 ? (h % 24) + 'h' : '')
  return h ? h + 'h' + (m ? m + 'm' : '') : m + 'm'
}

// Jev calls these hooks made (~/.claude/hooks/jev.py records each one with
// the gateway's billed cost), and the team-wide Jev line of the AI Gateway
// report beside it (cc-bridge.py jev_usage).
type JevTally = { calls: number; cost: number; in: number }
type JevLatency = { p50?: number; p95?: number }
export type JevUsage = {
  today: JevTally
  week: JevTally
  // This session's calls (lines jev.py tagged with its id); absent from an older bridge.
  session?: JevTally & JevLatency
  // The last 24 hours by hour, oldest first.
  hours: { start: number; calls: number; cost: number; ms?: number }[]
  callers: ({ name: string; calls: number; cost: number; today?: number; kinds?: Record<string, number> } & JevLatency)[]
  kinds: ({ name: string; calls: number; cost: number } & JevLatency)[]
  gateway?: { requests: number; cost: number; since: string } | null
}

export function parseJev(raw: any): JevUsage | undefined {
  if (!raw || typeof raw !== 'object' || !raw.today || !raw.week) return undefined
  return {
    today: raw.today,
    week: raw.week,
    session: raw.session ?? undefined,
    hours: Array.isArray(raw.hours) ? raw.hours : [],
    callers: Array.isArray(raw.callers) ? raw.callers : [],
    kinds: Array.isArray(raw.kinds) ? raw.kinds : [],
    gateway: raw.gateway ?? null,
  }
}

// A hook's name as the Jev log records it: cc-bridge:route → route, flow_fork_hint.py → flow_fork_hint.
export function hookName(caller: string): string {
  return caller.replace(/^cc-bridge:/, 'cockpit ').replace(/\.py$/, '')
}

// $0.0123 below a dollar, $1.23 above: Jev costs are fractions of a cent.
export function usd(n: number): string {
  return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2))
}

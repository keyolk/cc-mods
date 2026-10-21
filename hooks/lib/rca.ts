// RCA mode: a session that was handed an alert thread (an alert bot, Grafana,
// PagerDuty and the like, posted by a bot) is investigating a live incident.
// What it needs is known up front — reading prod, writing in the alerting
// service's namespace, answering in the thread — so the person's own paste
// grants it, time-boxed, instead of the session stopping at each guard.
// Pure: detect the alert, derive the grants. register.ts runs them.

import { MODES, isProdContext, type Policy } from './policy'

export type Alert = {
  url: string // the thread the person pasted
  channel: string
  ts: string // thread root
  title: string
  labels: Record<string, string> // alertname, env, product, sbregion, service, severity, …
  source?: string // the bot that posted it
}

// The thread root, posted by a bot, reads as an alert: an incident, an
// alertname label, a firing/severity marker, or an alerting tool's link.
const ALERT_WORDS = /\bincidents?\b|alertname|\bFIRING\b|\[FIRING|severity|\|\s*(critical|warning)\s*\||Grafana alert|PagerDuty|Opsgenie|Alertmanager|\bP[1-4]\b|Escalated|Acknowledged by/i

export function alertOf(threadText: string, url: string, channel: string, ts: string): Alert | undefined {
  const head = /=== THREAD PARENT MESSAGE ===\n([\s\S]*?)(?:\n=== THREAD REPLIES|$)/.exec(threadText)?.[1] ?? ''
  const from = /From: ([^\n<(]+?)\s*(?:<([^>\n]+)>)?\s*\(/.exec(head)
  const bot = !!from && (/slack-bots\.com|^botuser-/i.test(from[2] ?? '') || /\bbot\b/i.test(from[1] ?? ''))
  if (!bot || !ALERT_WORDS.test(threadText)) return undefined
  // The bold first line, often a link: *<https://…|[sb] [apse1] Name ( … )>*
  const titled = /\*<[^|>]+\|([^>]+)>\*/.exec(head)?.[1] ?? /\n\S*\s*\*([^*\n]{6,})\*/.exec(head)?.[1] ?? ''
  const labels: Record<string, string> = {}
  for (const m of threadText.matchAll(/`([a-z_]+)`\s*=\s*([^\n`]+)/g)) if (!labels[m[1]!]) labels[m[1]!] = m[2]!.trim()
  // "#2001  |  critical  |  source grafana"
  const sev = /\|\s*(critical|warning|high|low|info)\s*\|/i.exec(head)?.[1]
  if (sev && !labels.severity) labels.severity = sev.toLowerCase()
  const title = unescape(titled).trim() || labels.alertname || 'alert'
  return { url, channel, ts, title, labels, source: from?.[1]?.trim() }
}

function unescape(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
}

// The prod kube contexts an alert's product and region point at: a context
// naming both (dataplatform + apse1 → dataplatform-apse1-airflow-local-prod).
export function alertContexts(a: Alert, contexts: readonly string[]): string[] {
  const product = (a.labels.product ?? '').toLowerCase()
  const region = (a.labels.sbregion ?? a.labels.region ?? '').toLowerCase()
  if (!product || !region) return []
  return contexts.filter((c) => {
    const l = c.toLowerCase()
    return isProdContext(c) && l.includes(product) && l.includes(region)
  })
}

export type Grant = { label: string; argv: string[]; revert: string[] }

// The session_policy.py commands that put a policy back as it was: its named
// mode, or for a custom one the default mode plus each capability it set;
// then every scoped grant it held (a mode change clears them).
export function restoreArgvs(p: Policy): string[][] {
  const out: string[][] = []
  if (p.mode !== 'custom' && (MODES as readonly string[]).includes(p.mode)) out.push(['mode', p.mode])
  else {
    out.push(['mode', 'default'])
    for (const [cap, v] of Object.entries(p.explicit)) if (v) out.push([v, cap])
  }
  for (const [cap, scopes] of Object.entries(p.scopes)) for (const sc of scopes ?? []) out.push(['allow', cap, cap === 'gh_merge' ? '--repo' : '--scope', sc])
  return out
}

export const RCA_MS = 2 * 60 * 60_000

// What RCA mode turns on, from the alert:
// - reading prod (prod_eks_access), everywhere: an incident crosses services;
// - writing (exec, restarts) only in the alerting service's namespace on the
//   contexts its product and region name, and only when both are known;
// - answering in the alert's channel (slack_send to that channel).
// Each one reverts when RCA ends or its time runs out.
// RCA is the policy's `rca` mode (read prod, keep going, write and post
// blocked) plus the alert's own targets as scopes; the mode is applied first,
// since a mode change clears scopes. Reverting is restoreArgvs of the policy
// before RCA, not each grant's revert.
export function rcaGrants(a: Alert, contexts: readonly string[]): Grant[] {
  const out: Grant[] = [{ label: 'mode rca: read prod, keep going', argv: ['mode', 'rca'], revert: [] }]
  const ns = a.labels.service ?? a.labels.namespace
  for (const c of alertContexts(a, contexts)) {
    const scope = ns ? c + '/' + ns : c
    out.push({ label: 'write ' + scope, argv: ['allow', 'prod_eks_write', '--scope', scope], revert: ['inherit', 'prod_eks_write', '--scope', scope] })
  }
  out.push({ label: 'post in ' + a.channel, argv: ['allow', 'slack_send', '--scope', a.channel], revert: ['inherit', 'slack_send', '--scope', a.channel] })
  return out
}

export type RcaState = { alert: Alert; grants: Grant[]; at: number; until: number; before?: Policy } | null

// What Claude reads about it, once, in the system prompt.
export function rcaSection(r: NonNullable<RcaState>): string {
  const labels = Object.entries(r.alert.labels)
    .filter(([k]) => ['alertname', 'env', 'product', 'sbregion', 'service', 'severity'].includes(k))
    .map(([k, v]) => k + '=' + v)
    .join(', ')
  return (
    '# RCA mode\n' +
    'This session is investigating an alert: ' + r.alert.title + (labels ? ' (' + labels + ')' : '') + '\n' +
    'Thread: ' + r.alert.url + '\n' +
    'Granted by the user for this RCA until ' + new Date(r.until).toISOString().slice(11, 16) + 'Z: ' + r.grants.map((g) => g.label).join('; ') + '.'
  )
}

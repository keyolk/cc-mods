// Picking the effort (and, if asked, the model) for a turn from what the
// person asked. The judging is Jev's (bin/cc-bridge.py route); this is the
// pure part: when its answer is trusted, and what a step is then sent with.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export type RouteSettings = {
  effort: boolean // rewrite each main step's effort
  model: boolean // also pick the model (re-caches the whole context on a switch)
}

export const ROUTE_OFF: RouteSettings = { effort: false, model: false }

// Routing is two session-policy capabilities, on only when allowed: inherit
// (the default) adds nothing, block forbids it.
export function routeSettings(caps: { auto_effort?: string; auto_model?: string } | undefined): RouteSettings {
  return { effort: caps?.auto_effort === 'allow', model: caps?.auto_model === 'allow' }
}

export type RouteAnswer = { effort?: string | null; confidence?: number }

export type RouteDecision = {
  effort?: Effort
  model?: string
  confidence: number
  // Why nothing was changed, when nothing was.
  kept?: 'off' | 'unsure' | 'no-answer' | 'no-effort-model' | 'cache'
}

// Below this Jev's pick is a guess and the session's own setting stands.
export const ROUTE_THRESHOLD = 0.75

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']

// Light work goes to Sonnet; anything harder keeps the session's model rather
// than reaching for one, since a switch costs a re-cache either way.
const MODEL_FOR: Partial<Record<Effort, string>> = { low: 'sonnet', medium: 'sonnet' }

// `stepEffort` is the effort the engine was about to send: absent means the
// model takes none, and then there is nothing to rewrite.
export function decide(settings: RouteSettings, answer: RouteAnswer | undefined, stepEffort: unknown): RouteDecision {
  const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0
  if (!settings.effort && !settings.model) return { confidence, kept: 'off' }
  if (!answer || typeof answer.effort !== 'string' || !EFFORTS.includes(answer.effort)) return { confidence, kept: 'no-answer' }
  if (confidence < ROUTE_THRESHOLD) return { confidence, kept: 'unsure' }
  const effort = answer.effort as Effort
  const out: RouteDecision = { confidence }
  if (settings.effort) {
    if (stepEffort === undefined) out.kept = 'no-effort-model'
    else out.effort = effort
  }
  if (settings.model && MODEL_FOR[effort]) out.model = MODEL_FOR[effort]
  return out
}

// The full model id for a routed family. turn.step takes the id as sent: an
// alias ('sonnet') went out raw, and a proxy that does not map aliases (cco)
// answered "issue with the selected model (sonnet)". The id comes from
// ANTHROPIC_DEFAULT_<FAMILY>_MODEL when set, else the step's own id with its
// family swapped (claude-opus-5-5 → claude-sonnet-5-5). The step's [1m] marker
// is kept as it is: the context the session runs with must not shrink.
export function resolveModel(family: string, stepModel: string, envModel: string | undefined): string | undefined {
  const oneM = /\[1m\]$/.test(stepModel)
  let base = envModel?.replace(/\[1m\]$/, '').trim()
  if (!base) {
    const m = /^claude-([a-z]+)-(.+?)(\[1m\])?$/.exec(stepModel)
    if (!m) return undefined
    base = 'claude-' + family + '-' + m[2]
  }
  if (!/^claude-[a-z]+-\d/.test(base)) return undefined
  if (base.includes('-' + family + '-') === false) return undefined
  return base + (oneM ? '[1m]' : '')
}

// What the previous main step was sent with, and when.
export type RouteLast = { effort?: unknown; model: string; at: number }

// Prompt-cache friendliness. Changing effort invalidates the messages cache
// (docs, and measured here: medium↔high read 29k and rewrote ~600k), and a
// model switch writes the new model's cache from scratch. On a large, warm
// context that costs more than lower effort saves, so the pick is applied only
// at a cache boundary: the first step, a small context, or a cache already
// cold (idle past the TTL). Otherwise the previous step's effort and model are
// sent again, so a held pick never flips the session back either.
export const CACHE_SMALL_TOKENS = 30_000
export const CACHE_TTL_MS = 60 * 60_000

export function cacheGate(d: RouteDecision, s: { stepEffort: unknown; stepModel: string; last?: RouteLast; ctxTokens?: number; now: number }): RouteDecision {
  if (d.kept && d.kept !== 'no-effort-model') return d
  if (!s.last) return d
  const cold = s.now - s.last.at > CACHE_TTL_MS
  const small = typeof s.ctxTokens === 'number' && s.ctxTokens < CACHE_SMALL_TOKENS
  if (cold || small) return d
  const wantEffort = d.effort ?? s.stepEffort
  const wantModel = d.model ?? s.stepModel
  const changes = wantEffort !== s.last.effort || (d.model !== undefined && wantModel !== s.last.model)
  if (!changes) return d
  // Hold: send what the previous step was sent with.
  return {
    confidence: d.confidence,
    kept: 'cache',
    ...(s.last.effort !== s.stepEffort && typeof s.last.effort === 'string' ? { effort: s.last.effort as Effort } : {}),
    ...(s.last.model !== s.stepModel ? { model: s.last.model } : {}),
  }
}

export function routeLabel(d: RouteDecision | undefined): string {
  if (!d) return 'no decision yet'
  if (d.kept === 'off') return 'off'
  if (d.kept === 'no-answer') return 'no answer from Jev; kept the session setting'
  if (d.kept === 'cache') return 'held the previous setting to keep the prompt cache warm (' + Math.round(d.confidence * 100) + '%)'
  if (d.kept === 'unsure') return 'unsure (' + Math.round(d.confidence * 100) + '%); kept the session setting'
  const parts = [d.effort ? 'effort ' + d.effort : '', d.model ? 'model ' + d.model : ''].filter(Boolean)
  const note = d.kept === 'no-effort-model' ? ' · this model takes no effort' : ''
  return (parts.join(' · ') || 'unchanged') + ' (' + Math.round(d.confidence * 100) + '%)' + note
}

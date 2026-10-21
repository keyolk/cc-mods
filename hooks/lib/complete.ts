// Autocomplete sources: kubectl contexts, AWS profiles, Jira keys, open PRs,
// tmux windows. The lists are loaded once and cached; prompt.autocomplete
// does not wait for slow work, so lookups here are synchronous filters.

import type { PromptAutocompleteSuggestion } from 'claude-code'
import { org, stackOf } from './org'

export type Sources = {
  contexts: string[]
  profiles: string[]
  tickets: string[]
  prs: { key: string; title: string }[]
  windows: { name: string; state: string }[]
}

export const EMPTY: Sources = { contexts: [], profiles: [], tickets: [], prs: [], windows: [] }

// Which stack a name belongs to (org.json's stacks): stacks that must never
// be mixed, so every suggestion says which side it is on.
export { stackOf }

// A bare word that starts like a configured context or profile is offered
// completions without the --context/--profile flag in front of it.
function stackPrefix(bare: string): boolean {
  return org().stacks.some((s) => s.prefixes.some((p) => p.length > 1 && bare.startsWith(p)))
}

const MAX = 8

function rank(list: readonly string[], q: string): string[] {
  const lq = q.toLowerCase()
  const starts = list.filter((x) => x.toLowerCase().startsWith(lq))
  const has = list.filter((x) => !x.toLowerCase().startsWith(lq) && x.toLowerCase().includes(lq))
  return [...starts, ...has].slice(0, MAX)
}

export function suggest(token: string, text: string, src: Sources): PromptAutocompleteSuggestion[] {
  if (token.length < 2) return []
  const before = text
  // --context=foo / --context foo / --profile foo
  const ctxFlag = /--context[= ]$/.test(before.slice(0, Math.max(0, before.length - token.length))) || token.startsWith('--context=')
  const profFlag = /--profile[= ]$/.test(before.slice(0, Math.max(0, before.length - token.length))) || token.startsWith('--profile=')
  const bare = token.replace(/^--(context|profile)=/, '')
  const prefix = token.slice(0, token.length - bare.length)

  if (ctxFlag || (stackPrefix(bare) && src.contexts.some((c) => c.startsWith(bare.slice(0, 3))))) {
    const ctx = rank(src.contexts, bare).map((c) => ({ text: prefix + c, label: c, description: 'kubectl · ' + (stackOf(c) || 'context') }))
    if (ctx.length || ctxFlag) return ctx
  }
  if (profFlag || (stackPrefix(bare) && src.profiles.some((p) => p.startsWith(bare.slice(0, 3))))) {
    const prof = rank(src.profiles, bare).map((p) => ({ text: prefix + p, label: p, description: 'aws profile · ' + (stackOf(p) || '') }))
    if (prof.length || profFlag) return prof
  }
  if (/^[A-Z]{2,8}-\d*$/.test(token)) {
    return rank(src.tickets, token).map((t) => ({ text: t, label: t, description: 'jira' }))
  }
  if (token.startsWith('#') || /^[\w.-]+\/[\w.-]+#?\d*$/.test(token)) {
    const q = token.replace(/^#/, '')
    return src.prs
      .filter((p) => p.key.includes(q))
      .slice(0, MAX)
      .map((p) => ({ text: p.key, label: p.key, description: p.title }))
  }
  if (token.startsWith('@w:')) {
    const q = token.slice(3)
    return src.windows
      .filter((w) => w.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, MAX)
      .map((w) => ({ text: 'tmux window "' + w.name + '"', label: w.name, description: 'tmux · ' + (w.state || 'shell') }))
  }
  return []
}

export function parseProfiles(awsConfig: string): string[] {
  return [...awsConfig.matchAll(/^\[profile ([\w.-]+)\]/gm)].map((m) => m[1] ?? '').filter(Boolean)
}

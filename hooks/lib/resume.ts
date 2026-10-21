// Resume a session whose turn died on a connection problem once the
// connection is back: a laptop that slept, a VPN or the mesh dropping and
// coming back, the API refusing for a while. Pure: classify the failure and
// decide when to send "keep going"; register.ts probes and submits.
//
// ccproxy's own auto-continue covers one case, a response cut
// mid-stream, and injects at once. That fails again when the network is still
// down, and covers nothing that died before any output (asleep, refused,
// timed out). This waits for the network instead, and stands aside when a new
// turn started since the failure (ccproxy's inject, or the person).

export type ResumeClass = 'network' | 'server' | 'rate' | 'never'

// StopFailure's error kind and message (the "API Error: …" line).
export function classify(kind: string | undefined, message: string | undefined): ResumeClass {
  const m = String(message ?? '')
  if (/flagged|usage polic|Login expired|\/login|billing|credit|context (length|window)|prompt is too long|max_output/i.test(m)) return 'never'
  if (kind && /^(authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|billing_error|invalid_request|model_not_found|max_output_tokens|cloud_credential_error)$/.test(kind)) return 'never'
  if (/asleep|went to sleep|Connection (lost|refused|reset|error)|No response from API|stopped arriving|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|dial tcp|timed out|fetch failed/i.test(m)) return 'network'
  if (kind === 'rate_limit' || /\b429\b|rate.?limit/i.test(m)) return 'rate'
  if (kind === 'overloaded' || kind === 'server_error' || /\b5\d\d\b|overloaded|stream error/i.test(m)) return 'server'
  return kind === 'unknown' ? 'network' : 'never'
}

export type Pending = {
  at: number // when the turn failed (ms)
  cls: ResumeClass
  message: string
  attempts: number // keep-goings sent in this streak
  nextAt: number // earliest time to try (ms): backoff for server/rate
}

export const MAX_ATTEMPTS = 3
export const GIVE_UP_MS = 6 * 3600_000

// How long to wait after a failure before the first try, by class: a network
// failure waits for the probe, not a clock; server and rate limits back off.
export function backoff(cls: ResumeClass, attempts: number): number {
  if (cls === 'rate') return [120_000, 300_000, 900_000][Math.min(attempts, 2)]!
  if (cls === 'server') return [30_000, 120_000, 300_000][Math.min(attempts, 2)]!
  return 10_000
}

export type Decision = { act: 'wait' } | { act: 'drop'; why: string } | { act: 'resume' }

// One probe tick. `reachable`: the API answered over the same path the session
// uses. `turnSince`: a turn started after the failure (someone else resumed).
export function decide(p: Pending, now: number, s: { reachable: boolean; turnSince: boolean; enabled: boolean }): Decision {
  if (!s.enabled) return { act: 'drop', why: 'auto-resume is off' }
  if (s.turnSince) return { act: 'drop', why: 'a new turn started' }
  if (p.attempts >= MAX_ATTEMPTS) return { act: 'drop', why: MAX_ATTEMPTS + ' tries without an answer' }
  if (now - p.at > GIVE_UP_MS) return { act: 'drop', why: 'offline too long' }
  if (now < p.nextAt || !s.reachable) return { act: 'wait' }
  return { act: 'resume' }
}

// A timer that fired much later than asked means the machine slept.
export function slept(expectedMs: number, actualMs: number): boolean {
  return actualMs - expectedMs > 60_000
}

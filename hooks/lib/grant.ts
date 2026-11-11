// One-shot grants from the person's press in the office (office/grants.py),
// as the mod sees them, and the gates a brief will meet.
//
// A worker's session policy keeps slack_send=block. The person's press on a
// brief option that declares a send (bin/brief-grant) makes a grant in the
// office process only. When slack_send_guard.py denies the worker's send, the
// worker's cc-mods asks the office to redeem it (bin/office-redeem); the
// office checks channel, thread and text, opens that one channel for that
// session for a few seconds, and the mod retries the call once and closes it.
//
// What keeps the model from making a grant itself: no file it writes makes
// one (the office keeps grants in memory and issues them only in its /act
// handler). That handler needs the office token, which is not a secret from
// a session (a 0600 file of the same user, and in the page GET / serves). So
// the line is drawn here, at the command, as for a session_policy.py
// self-grant (lib/policy.ts isSelfGrant): a Bash command that reads the token
// file or calls the office's /act or /redeem (or the redeem script) is
// refused, and a file tool on the token file too. A session that works
// around this guard on purpose is not stopped by it (office/grants.py).

import { executedText } from './policy'

export const SLACK_SENDS = /^mcp__claude_ai_Slack__slack_(send_message|send_message_draft|schedule_message)$/
// Only a send to a channel the policy refused is redeemable: not a draft or
// a schedule, which a person's press on one text does not cover.
export const REDEEMABLE = /^mcp__claude_ai_Slack__slack_send_message$/

export type RedeemReq = { sid: string; kind: 'slack_send'; channel: string; thread: string | null; text: string }

// The redeem request for a denied call, or undefined when the call is not
// one a grant can cover (the guard's deny must be the session policy's).
export function redeemRequest(sid: string, tool: string, input: Record<string, unknown>, deny: string): RedeemReq | undefined {
  if (!sid || !REDEEMABLE.test(tool) || !/BLOCKED by session policy: slack_send\b/.test(deny)) return undefined
  const channel = typeof input.channel_id === 'string' ? input.channel_id.trim().toUpperCase() : ''
  const text = typeof input.message === 'string' ? input.message : ''
  if (!channel || !text.trim()) return undefined
  const thread = typeof input.thread_ts === 'string' && input.thread_ts.trim() ? input.thread_ts.trim() : null
  return { sid, kind: 'slack_send', channel, thread, text }
}

export type RedeemAnswer = { ok: boolean; error?: string; status?: number }

export function parseRedeem(stdout: string): RedeemAnswer {
  try {
    const j = JSON.parse(stdout || '{}')
    return { ok: j.status === 200 && j.ok === true, error: typeof j.error === 'string' ? j.error : undefined, status: typeof j.status === 'number' ? j.status : undefined }
  } catch {
    return { ok: false, error: 'office-redeem printed no answer' }
  }
}

// The deny the worker reads when no grant covers the send: what to do next,
// never how to lift the gate.
export function noGrantText(deny: string, why: string | undefined, briefGrant = 'brief-grant'): string {
  return deny + '\nNo approval from the person covers this send (' + (why ?? 'office not reachable') + '). Put the exact text on your decision brief with `' + briefGrant + ' <brief> <option> --slack <channel> [--thread <ts>] --text-file <file>` and ask; the person\'s press allows that one send.'
}

// A Slack send to a channel a redeemed send holds open is refused: the
// guard sees only the channel, and the press allowed one message.
export function heldDeny(held: ReadonlySet<string>, channel: string): string | undefined {
  const c = channel.trim().toUpperCase()
  if (!c || !held.has(c)) return undefined
  return 'BLOCKED: an approved Slack send to ' + c + ' is going out now; the person approved that one message only. Ask on a decision brief for another.'
}

// ---- the office token and its endpoints are the person's ---------------------

const TOKEN_RE = /\.claude\/state\/office\/token\b/
// A POST to the office (any port) on /act or /redeem, or the redeem script.
const ENDPOINT_RE = /(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:act|redeem)\b|\boffice-redeem\b/

// Why this Bash command is refused, or undefined. Mentions inside a heredoc
// that feeds no shell (a note, a brief) pass, as for isSelfGrant.
export function officeBypass(command: string): string | undefined {
  const text = executedText(command)
  if (TOKEN_RE.test(text)) return 'the office token'
  if (ENDPOINT_RE.test(text)) return "the office's /act or /redeem"
  return undefined
}

// A file tool aimed at the token (Read, Edit, Write, Grep on that path).
export function officeTokenPath(input: Record<string, unknown>): boolean {
  return ['file_path', 'path', 'notebook_path'].some((k) => typeof input[k] === 'string' && TOKEN_RE.test(input[k] as string))
}

export const BYPASS_DENY =
  ' is the person\'s: their presses in the office answer briefs and allow gated actions, and a session acting on it would be approving itself. Do not run it or a variant of it. Ask on a decision brief instead (bin/brief-grant declares what a press allows).'

// ---- B: the gates a brief will meet ------------------------------------------

export type Gate = 'slack_send' | 'gh_merge' | 'prod_eks_write' | 'external_send'

const GATE_RES: [Gate, RegExp][] = [
  ['slack_send', /\bslack\b[^\n]{0,60}\b(send|post|reply|message|upload)|(send|post|reply)[^\n]{0,40}\bslack\b|슬랙[^\n]{0,20}(전송|보내|올리|게시|답)|daily[ -]?check[ -]?in|체크인[^\n]{0,20}(올리|보내|upload)/i],
  ['gh_merge', /\bgh\s+pr\s+merge\b|\bmerge\s+(the\s+|this\s+|a\s+)?(pr|pull request)\b|머지|병합/i],
  ['prod_eks_write', /\b(prod|production)\b[^\n]{0,40}\b(apply|rollout|restart|scale|delete|patch|deploy)\b|\b(apply|rollout|restart|scale|delete|patch|deploy)\b[^\n]{0,40}\b(in|on|to)\s+(prod|production)\b|(prod|운영)[^\n]{0,20}(배포|재시작|적용)|kubectl\s+(apply|delete|patch|scale|rollout)[^\n]*-prod/i],
  ['external_send', /\b(e-?mail|gmail|jira)\b[^\n]{0,40}\b(send|post|comment|create)|(메일|이메일)[^\n]{0,20}(보내|전송)|지라[^\n]{0,20}(댓글|생성)/i],
]

// The outward actions a brief's words name. A heuristic for the coordinator's
// note, never a permission: a gate it misses is still a gate.
export function briefGates(brief: string): Gate[] {
  return GATE_RES.filter(([, re]) => re.test(brief)).map(([g]) => g)
}

const GATE_WORDS: Record<Gate, string> = {
  slack_send: 'a Slack send (blocked for workers: the worker declares the text with bin/brief-grant on its brief; the person\'s press allows that one send)',
  gh_merge: 'a merge (blocked for workers: you merge after READY)',
  prod_eks_write: 'a prod write (blocked for workers: needs the person\'s /policy in that worker\'s pane, or a GitOps PR)',
  external_send: 'a send outside (mail, Jira): the tool asks; ask the person on the first brief',
}

// coord_spawn's note for the coordinator, '' when the brief names no gate.
export function gateNote(gates: readonly Gate[]): string {
  if (!gates.length) return ''
  return ' Gates this brief will meet: ' + gates.map((g) => GATE_WORDS[g]).join('; ') + '. Have the worker ask every approval it needs on its first decision brief, and do not ask again for one the person already gave.'
}

// The worker's own line about it, in its prompt.
// The worker's own line about it, in its prompt. `briefGrant`: the script's
// absolute path (the plugin's bin), as coord-report goes to the worker.
export function grantRule(briefGrant = 'brief-grant'): string {
  return (
    '- An outward action your policy blocks (a Slack send) is not yours to unlock and not the person\'s chore: ask for it on your first decision brief. Write the exact message to a file, `brief ask --new …` with an option such as "보내기", then `' +
    briefGrant +
    ' <brief> 보내기 --slack <channel id> [--thread <ts>] --text-file <file>` so the office shows that text under the option. When the answer comes back `[granted: …]`, send exactly that text once (slack_send_message, message = the file\'s text): cc-mods redeems the press and the send goes through. Never ask the person to change the policy, and never ask twice for what they already approved.'
  )
}

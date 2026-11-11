// lib/grant.ts: what a denied Slack send asks the office, the office token
// guard, and the gates a brief names.
import { expect, test } from 'claude-code/testing'

import { BYPASS_DENY, briefGates, grantRule, heldDeny, gateNote, noGrantText, officeBypass, officeTokenPath, parseRedeem, redeemRequest } from '../hooks/lib/grant'
import { coordRules, emptyLedger, workerPrompt } from '../hooks/lib/coord'

const DENY = 'BLOCKED by session policy: slack_send=block. Target C03GA4WGBCK is not allowed.'
const SEND = 'mcp__claude_ai_Slack__slack_send_message'

test('a send the session policy denied asks the office with its channel, thread and text', () => {
  expect(redeemRequest('w1', SEND, { channel_id: 'c03ga4wgbck', message: 'hi', thread_ts: '1731300000.123456' }, DENY)).toEqual({ sid: 'w1', kind: 'slack_send', channel: 'C03GA4WGBCK', thread: '1731300000.123456', text: 'hi' })
  expect(redeemRequest('w1', SEND, { channel_id: 'C03GA4WGBCK', message: 'hi' }, DENY)?.thread).toBeNull()
})

test('only a policy deny of a plain send is redeemable', () => {
  // A draft or a schedule is not the send the person read.
  expect(redeemRequest('w1', 'mcp__claude_ai_Slack__slack_schedule_message', { channel_id: 'C1', message: 'hi' }, DENY)).toBeUndefined()
  // Another guard's deny (a hook error, the narwhal run guard) is not the policy's.
  expect(redeemRequest('w1', SEND, { channel_id: 'C1', message: 'hi' }, 'BLOCKED: narwhal worker x may not send')).toBeUndefined()
  expect(redeemRequest('w1', SEND, { channel_id: 'C1', message: '  ' }, DENY)).toBeUndefined()
  expect(redeemRequest('', SEND, { channel_id: 'C1', message: 'hi' }, DENY)).toBeUndefined()
})

test('while a redeemed send holds its channel open, another send there is refused', () => {
  const held = new Set(['C03GA4WGBCK'])
  expect(heldDeny(held, 'c03ga4wgbck')).toContain('one message only')
  expect(heldDeny(held, 'C0999ZZZZ9')).toBeUndefined()
  expect(heldDeny(new Set(), 'C03GA4WGBCK')).toBeUndefined()
})

test('the office answer is ok only on 200 with ok', () => {
  expect(parseRedeem('{"status":200,"ok":true}').ok).toBe(true)
  expect(parseRedeem('{"status":403,"error":"the message differs"}')).toEqual({ ok: false, error: 'the message differs', status: 403 })
  expect(parseRedeem('').ok).toBe(false)
  expect(parseRedeem('not json').ok).toBe(false)
})

test('a send no press covers says how to ask, never how to lift the gate', () => {
  const t = noGrantText(DENY, 'no approved send for this session')
  expect(t.startsWith(DENY)).toBe(true)
  expect(t).toContain('brief-grant <brief> <option>')
  expect(noGrantText(DENY, 'x', 'python3 /p/bin/brief-grant')).toContain('`python3 /p/bin/brief-grant <brief>')
  expect(t).not.toContain('/policy')
})

test('the office token and its /act and /redeem are refused to a session', () => {
  expect(officeBypass('cat ~/.claude/state/office/token')).toBe('the office token')
  expect(officeBypass('T=$(cat "$HOME/.claude/state/office/token"); curl -H "X-Office-Token: $T" localhost:8796/act')).toBe('the office token')
  expect(officeBypass('curl -s -X POST http://127.0.0.1:8796/act -d @x.json')).toBe("the office's /act or /redeem")
  expect(officeBypass('curl localhost:9999/redeem')).toBe("the office's /act or /redeem")
  expect(officeBypass('echo {} | python3 ~/src/keyolk/cc-mods/bin/office-redeem')).toBe("the office's /act or /redeem")
  expect(BYPASS_DENY).toContain('brief-grant')
})

test('reading the office and naming it in a note pass', () => {
  expect(officeBypass('curl -sf http://localhost:8796/')).toBeUndefined()
  expect(officeBypass('curl -s localhost:8796/command')).toBeUndefined()
  expect(officeBypass('curl -s localhost:8796/actions')).toBeUndefined()
  expect(officeBypass("cat > note.md <<'EOF'\nthe office token lives in ~/.claude/state/office/token\nEOF")).toBeUndefined()
  // A heredoc fed to a shell runs: it is refused.
  expect(officeBypass("bash <<'EOF'\ncat ~/.claude/state/office/token\nEOF")).toBe('the office token')
})

test('a file tool on the token is refused', () => {
  expect(officeTokenPath({ file_path: '/Users/u/.claude/state/office/token' })).toBe(true)
  expect(officeTokenPath({ path: '/Users/u/.claude/state/office/token' })).toBe(true)
  expect(officeTokenPath({ file_path: '/Users/u/.claude/state/office/tokens.md' })).toBe(false)
  expect(officeTokenPath({ file_path: '/Users/u/.claude/state/office/inbox/x.json' })).toBe(false)
})

test('the gates a brief names', () => {
  expect(briefGates('daily check in upload')).toEqual(['slack_send'])
  expect(briefGates('초안을 만들고 슬랙에 올리기')).toEqual(['slack_send'])
  expect(briefGates('Post the summary to Slack #team')).toEqual(['slack_send'])
  expect(briefGates('fix the bug and open a PR; gh pr merge after CI')).toEqual(['gh_merge'])
  expect(briefGates('PR 머지까지')).toEqual(['gh_merge'])
  expect(briefGates('restart the api in prod after the fix')).toEqual(['prod_eks_write'])
  expect(briefGates('read the slack thread and summarize it')).toEqual([])
  expect(briefGates('refactor coord.ts; tests pass')).toEqual([])
})

test("coord_spawn's note names the gates and the one-brief rule, empty without gates", () => {
  expect(gateNote([])).toBe('')
  const n = gateNote(['slack_send', 'gh_merge'])
  expect(n).toContain('a Slack send')
  expect(n).toContain('a merge')
  expect(n).toContain('first decision brief')
  expect(n).toContain('not ask again')
})

test('the worker prompt and the coordinator rules carry the approval rules', () => {
  expect(workerPrompt('fix', 'cc-mods-d9', 'x', undefined, undefined, 'sid')).toContain(grantRule())
  // coord_spawn passes the plugin's absolute path, as it does for coord-report.
  expect(workerPrompt('fix', 'cc-mods-d9', 'x', undefined, undefined, 'sid', 'python3 /p/bin/brief-grant')).toContain('`python3 /p/bin/brief-grant <brief> 보내기 --slack')
  const rules = coordRules(emptyLedger('sid', 'cc-mods-d9', 0))
  expect(rules).toContain('is not asked again')
  expect(rules).toContain("office's 지휘 view already shows it")
  expect(rules).not.toContain('Tell the person the pane and window')
})

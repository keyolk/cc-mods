// lib/notes.ts: the context rows sent where prompt.compose is out of reach.
import { expect, test } from 'claude-code/testing'

import { NOTE_PREFIX, digest, noteText, sentDigests, userTexts } from '../hooks/lib/notes'

const B = [
  { key: 'coordinator', text: '# Coordinator mode (cc-mods)\nrules' },
  { key: 'policy', text: '# Session policy (custom)\ngh_merge=block' },
]

test('notes: the first row carries every block, each under its key and digest', () => {
  const t = noteText(B, new Map())!
  expect(t).toContain(NOTE_PREFIX + 'coordinator #' + digest(B[0]!.text) + '] cc-mods context for this session.\n# Coordinator mode (cc-mods)')
  expect(t).toContain(NOTE_PREFIX + 'policy #' + digest(B[1]!.text) + ']')
  expect(t).toContain('# Session policy (custom)\ngh_merge=block')
})

test('notes: a conversation that holds every current block gets no row', () => {
  const sent = sentDigests([noteText(B, new Map())!])
  expect(noteText(B, sent)).toBeUndefined()
})

test('notes: only the block that changed goes again, and it says it replaces the earlier one', () => {
  const sent = sentDigests([noteText(B, new Map())!])
  const next = [B[0]!, { key: 'policy', text: '# Session policy (custom)\ngh_merge=allow' }]
  const t = noteText(next, sent)!
  expect(t).not.toContain('# Coordinator mode')
  expect(t).toContain('This replaces the earlier policy context.\n# Session policy (custom)\ngh_merge=allow')
  // The newest digest wins when a key appears twice in the conversation.
  expect(noteText(next, sentDigests([noteText(B, new Map())!, t]))).toBeUndefined()
})

test('notes: a block that ended says so once', () => {
  const sent = sentDigests([noteText(B, new Map())!])
  const t = noteText([B[1]!], sent)!
  expect(t).toContain('The earlier coordinator context no longer applies.')
  expect(noteText([B[1]!], sentDigests([noteText(B, new Map())!, t]))).toBeUndefined()
})

test('notes: a dropped row (compaction, /clear) is sent again', () => {
  expect(noteText(B, sentDigests(['a summary with no rows of ours']))).toBe(noteText(B, new Map()))
})

test('notes: userTexts reads text blocks of user messages only', () => {
  expect(userTexts([
    { role: 'user', content: 'plain' },
    { role: 'assistant', content: [{ type: 'text', text: NOTE_PREFIX + 'policy #00000000]' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: 'note' }] },
  ])).toEqual(['plain', 'note'])
})

test('notes: a marker quoted inside other text (a summary, another prompt) does not count as sent', () => {
  const ours = noteText(B, new Map())!
  expect(noteText(B, sentDigests(['Summary: the session was told ' + ours]))).toBe(ours)
  expect(noteText(B, sentDigests(['- 20:31 [x] (active) ' + ours.split('\n')[0]]))).toBe(ours)
})

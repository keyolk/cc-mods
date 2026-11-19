// Claude Code's session registry read file by file (hooks/lib/registry.ts):
// a torn file, as 4 of 23 were on 2026-11-20, hides neither itself nor the
// others. No engine.
import { expect, test } from 'claude-code/testing'

import { leadingJson, parseRegistry } from '../hooks/lib/registry'

const rec = (pid: number, sessionId: string, name?: string, updatedAt = 1) => JSON.stringify({ pid, sessionId, ...(name ? { name } : {}), updatedAt })

test('registry: a file with one extra } after its object is read as that object', () => {
  expect(leadingJson(rec(55744, 's1', 'cc-mods-79') + '}')).toEqual({ pid: 55744, sessionId: 's1', name: 'cc-mods-79', updatedAt: 1 })
  // Braces inside a string do not end it early.
  expect(leadingJson('{"name":"a}b","x":"\\"}"}\n}}')).toEqual({ name: 'a}b', x: '"}' })
  for (const raw of [undefined, '', '{"pid": ', 'not json', '}']) expect(leadingJson(raw)).toBeUndefined()
})

test('registry: every readable file names its session; a torn one counts, a cut one hides only itself', () => {
  const m = parseRegistry([
    { name: '55744.json', text: rec(55744, 's1', 'cc-mods-79') + '}' },
    { name: '100.json', text: rec(100, 's2', 'tweb-5a') },
    { name: '101.json', text: '{"pid": 101, "sessionId": "s3"' },
    { name: '102.json', text: rec(102, 's4') },
  ])
  expect([...m.keys()].sort()).toEqual(['s1', 's2', 's4'])
  expect(m.get('s1')).toMatchObject({ name: 'cc-mods-79', pids: [55744] })
  expect(m.get('s4')?.name).toBeUndefined()
})

test('registry: a resumed session keeps every pid, and the newest named record names it', () => {
  const m = parseRegistry([
    { name: '1.json', text: rec(1, 's1', 'old-name', 5) },
    { name: '2.json', text: rec(2, 's1', 'new-name', 9) },
    { name: '3.json', text: rec(3, 's1', undefined, 20) },
  ])
  expect(m.get('s1')).toMatchObject({ name: 'new-name', pids: [1, 2, 3] })
})

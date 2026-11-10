// office/paths.js: which runs of an answer's text are file paths worth asking
// the office about. A browser script, read here as text: only its pure parts.
import { expect, test } from 'claude-code/testing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '../office/paths.js'), 'utf8')
const { pathCands, codePath } = new Function(src + '\nreturn { pathCands, codePath }')() as {
  pathCands: (t: string) => { p: string; at: number }[]
  codePath: (t: string) => string | null
}
const ps = (t: string) => pathCands(t).map((c) => c.p)

test('paths: the screenshot draft, as `code`, is a path', () => {
  expect(codePath('~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md')).toBe('~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md')
})

test('paths: code spans that are not paths are left alone', () => {
  for (const t of ['413421', 'bun test', 'a || b', 'foo()', '--profile', 'CP-852', 'x', 'and/or', 'https://example.com/a.md']) expect(codePath(t)).toBeNull()
  expect(codePath('README.md')).toBe('README.md')
  expect(codePath('office/paths.py:12')).toBe('office/paths.py:12')
  expect(codePath('~/exp/topic/')).toBe('~/exp/topic')
})

test('paths: absolute, ~ and relative paths in plain text, without trailing punctuation', () => {
  expect(ps('초안은 ~/exp/a/b_draft.md 에 있습니다.')).toEqual(['~/exp/a/b_draft.md'])
  expect(ps('see /Users/me/exp/x.md, then ./src/a.ts:10.')).toEqual(['/Users/me/exp/x.md', './src/a.ts:10'])
  expect(ps('edited office/paths.js and tests/test_office_paths.py')).toEqual(['office/paths.js', 'tests/test_office_paths.py'])
  expect(ps('한글 ~/exp/2026_보고서/결과.md 도')).toEqual(['~/exp/2026_보고서/결과.md'])
})

test('paths: a colon inside a folder name is part of the path, a :line after it is not', () => {
  expect(codePath('~/.claude/skills/sb:slack-followup/watch_thread_gestalt.py')).toBe('~/.claude/skills/sb:slack-followup/watch_thread_gestalt.py')
  expect(ps('ran ~/.claude/skills/sb:slack-followup/watch_ticket.py:40 again')).toEqual(['~/.claude/skills/sb:slack-followup/watch_ticket.py:40'])
  expect(ps('see http://127.0.0.1:8811/paths.js')).toEqual([])
})

test('paths: URLs and prose slashes are not paths', () => {
  expect(ps('https://github.com/keyolk/cc-mods/pull/102 and/or 1/2 of them')).toEqual([])
  expect(ps('read/write access')).toEqual([])
})

import { expect, test } from 'claude-code/testing'
import { dialogText, matches, parseDialog } from '../hooks/lib/dialog'

// A worker's screen as `tmux capture-pane -p -J` gives it: scrollback, the
// rule over the dialog, its box (the tool and command), the question, options.
const SCREEN = [
  '⏺ Bash(rm node_modules && git commit -m "fix")',
  '',
  '────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   rm node_modules && git commit -m "fix: office row"',
  '   Remove the symlink and commit',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in /w/x",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
].join('\n')

test('dialog: a permission dialog on a screen is its box, question and options', () => {
  const d = parseDialog(SCREEN)!
  expect(d.question).toBe('Do you want to proceed?')
  expect(d.about).toEqual(['Bash command', 'rm node_modules && git commit -m "fix: office row"', 'Remove the symlink and commit'])
  expect(d.options.map((o) => [o.n, o.label])).toEqual([
    [1, 'Yes'],
    [2, "Yes, and don't ask again for rm commands in /w/x"],
    [3, 'No, and tell Claude what to do differently (esc)'],
  ])
  // The scrollback above the rule is not the dialog's.
  expect(dialogText(d)).not.toContain('⏺')
})

test('dialog: a press is bound to the command the coordinator checked', () => {
  const d = parseDialog(SCREEN)!
  expect(matches(d, 'rm node_modules && git commit')).toBe(true)
  expect(matches(d, '')).toBe(true)
  // The next call asks with the same question and options: not this one.
  const next = parseDialog(SCREEN.replace('rm node_modules && git commit -m "fix: office row"', 'git push --force origin main'))!
  expect(matches(next, 'rm node_modules && git commit')).toBe(false)
})

test('dialog: no cursor, one option, or a plain prompt box is no dialog', () => {
  expect(parseDialog('')).toBeUndefined()
  expect(parseDialog('> fix the bug\n')).toBeUndefined()
  expect(parseDialog('Steps:\n1. read it\n2. fix it\n')).toBeUndefined()
  expect(parseDialog('Do you want to proceed?\n❯ 1. Yes\n')).toBeUndefined()
})

test('dialog: a side panel beside the chat is not part of an option', () => {
  const d = parseDialog(['Bash command', '  ls /w', 'Do you want to proceed?', '❯ 1. Yes        │ reqs 12', '  2. No         │ ▁▂▃'].join('\n'))!
  expect(d.options.map((o) => o.label)).toEqual(['Yes', 'No'])
})

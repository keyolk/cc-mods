// One tweb pane per tmux window: the Bash guard's parse and its answer for a
// window with no browser pane, one, or only the office.

import { expect, test } from 'claude-code/testing'

import { ONE_BROWSER, isOffice, paneOpens, secondPaneDeny } from '../hooks/lib/webpane'
import { coordSection, emptyLedger, workerPrompt } from '../hooks/lib/coord'
import type { SidePane } from '../hooks/lib/webside'

const pane = (id: string, ...urls: string[]): SidePane => ({ pane: id, engine: 'electron', tabs: urls.map((url, index) => ({ index, title: '', url, active: index === 0 })) })
const OFFICE = pane('%401', 'http://127.0.0.1:8796/')
const WORK = pane('%418', 'https://concur.example/expense')

test('webpane: tweb split and tweb open are pane opens; other verbs, help and TWEB_SECOND_PANE=1 are not', () => {
  expect(paneOpens('tweb split https://a.example')).toEqual(['tweb split https://a.example'])
  expect(paneOpens('cd /x && /opt/bin/tweb open --engine chrome "https://a.example/?q=1"')).toEqual(['tweb open --engine chrome https://a.example/?q=1'])
  expect(paneOpens('tweb tab new https://a.example --pane %3; tweb navigate x; tweb panes')).toEqual([])
  expect(paneOpens('tweb split --help')).toEqual([])
  expect(paneOpens('TWEB_SECOND_PANE=1 tweb split https://a.example')).toEqual([])
  expect(paneOpens('env TWEB_SECOND_PANE=yes tweb split x')).toEqual([])
  // The bypass is per command: a second split in the same line still counts.
  expect(paneOpens('TWEB_SECOND_PANE=1 tweb split a && tweb split b')).toEqual(['tweb split b'])
  expect(paneOpens('TWEB_SECOND_PANE=0 tweb split a')).toEqual(['tweb split a'])
  expect(paneOpens('echo tweb-split; grep "tweb split" notes.md')).toEqual([])
})

test('webpane: a split is refused while the window has a browser pane other than the office, naming that pane', () => {
  // None, or only the office (the person's screen): a split may run.
  expect(secondPaneDeny('tweb split https://a.example', [])).toBeUndefined()
  expect(secondPaneDeny('tweb split https://a.example', [OFFICE])).toBeUndefined()
  expect(isOffice(OFFICE)).toBe(true)
  expect(isOffice(pane('%9', 'http://localhost:8796/coord'))).toBe(true)
  expect(isOffice(pane('%9', 'http://localhost:87960/'))).toBe(false)
  // Live: a new pane came up with restored tabs, the office one of them: a browser pane, not the office.
  const restored = pane('%449', 'file:///tmp/page.html', 'http://127.0.0.1:8796/')
  expect(isOffice(restored)).toBe(false)
  expect(secondPaneDeny('tweb split https://a.example', [restored])).toContain('(%449)')
  expect(isOffice(pane('%9'))).toBe(false)
  // One there: refused, with the tab new to run instead and the way past.
  const why = secondPaneDeny('tweb split --engine chrome https://a.example', [OFFICE, WORK])!
  expect(why).toContain('already has a browser pane (%418)')
  expect(why).toContain('`tweb tab new https://a.example --pane %418`')
  expect(why).toContain('`tweb tab engine chrome --pane %418`')
  expect(why).toContain('`TWEB_SECOND_PANE=1 tweb split --engine chrome https://a.example`')
  expect(why).not.toContain('%401')
  expect(secondPaneDeny('tweb split', [WORK])).toContain('`tweb tab new <url> --pane %418`')
  // Said to be meant, or no pane opened: never refused.
  expect(secondPaneDeny('TWEB_SECOND_PANE=1 tweb split https://a.example', [WORK])).toBeUndefined()
  expect(secondPaneDeny('tweb tab new https://a.example', [WORK])).toBeUndefined()
})

test('webpane: the coordinator and every worker read the one-pane rule', () => {
  expect(ONE_BROWSER).toContain('one tweb pane per tmux window')
  expect(ONE_BROWSER).toContain('localhost:8796')
  expect(ONE_BROWSER).toContain('TWEB_SECOND_PANE=1 tweb split <url>')
  expect(workerPrompt('do it', 'cc-mods-d9', 'w')).toContain(ONE_BROWSER)
  expect(coordSection({ ...emptyLedger('c', 'cc-mods-d9', 0), on: true }, 0)).toContain(ONE_BROWSER)
})

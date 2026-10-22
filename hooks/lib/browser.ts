// Where this session's links open: tmux-chrome reads the pane's @browser option
// (then the window's, then the global one) and sends a URL to a TWeb pane on
// Electron, on the user's Chrome or on WebKit, or the window's Chrome tab group.
// Claude Code opens links through $BROWSER (tmux-chrome-open), and that child
// inherits this session's TMUX_PANE, so a pane option is per session.

export const BROWSERS = ['tweb', 'tweb-chrome', 'tweb-webkit', 'chrome'] as const
export type Browser = (typeof BROWSERS)[number]
export type BrowserChoice = Browser | 'inherit'

export const BROWSER_LABEL: Record<Browser, string> = {
  tweb: 'TWeb (Electron)',
  'tweb-chrome': 'TWeb on your Chrome',
  'tweb-webkit': 'TWeb on WebKit',
  chrome: 'Chrome tab group',
}

export function parseBrowser(s: unknown): BrowserChoice | undefined {
  const v = String(s ?? '').trim()
  if (v === '' || v === 'inherit') return 'inherit'
  if (v === 'tweb-tauri') return 'tweb-webkit'
  return (BROWSERS as readonly string[]).includes(v) ? (v as Browser) : undefined
}

// tmux argv that makes `pane` open links in `choice`; inherit removes the
// pane's own value so the window or global option applies again.
export function browserArgv(pane: string, choice: BrowserChoice): string[] {
  return choice === 'inherit' ? ['set-option', '-p', '-t', pane, '-u', '@browser'] : ['set-option', '-p', '-t', pane, '@browser', choice]
}

// Where links from this pane go, most specific first: TMUX_CHROME_BROWSER,
// the pane's @browser, the window's, the global one, TMUX_CHROME_TWEB=1 as
// tweb, else the Chrome tab group. The same order tmux-chrome's open uses;
// answered here instead of asking `tmux-chrome browser`, which a tmux-chrome
// build without that subcommand answers with its usage text. A value outside
// the known ones is chrome, as there: a typo must not lose a URL.
export function resolveBrowser(v: { env?: string; pane?: string; window?: string; global?: string; twebFlag?: string }): Browser {
  const raw = [v.env, v.pane, v.window, v.global].map((x) => (x ?? '').trim()).find(Boolean) || (v.twebFlag && v.twebFlag !== '0' ? 'tweb' : '')
  const c = parseBrowser(raw)
  return c && c !== 'inherit' ? c : 'chrome'
}

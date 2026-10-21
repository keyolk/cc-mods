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

// Small string helpers shared by the collectors and the views. Pure: no `$`.

// Terminal cells a character takes: CJK, Hangul and most emoji take two.
// Counting UTF-16 units made Korean lines twice as wide as clip() thought,
// so every clipped Korean row still wrapped onto a second line.
export function cells(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c < 0x1100) return 1
  if (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    (c >= 0x2e80 && c <= 0xa4cf) || // CJK radicals .. Yi
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) // emoji
  )
    return 2
  return 1
}

export function width(s: string): number {
  let n = 0
  for (const ch of s) n += cells(ch)
  return n
}

// Collapse whitespace and cut to at most `n` terminal cells, with an ellipsis.
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (width(one) <= n) return one
  let out = ''
  let used = 0
  for (const ch of one) {
    const w = cells(ch)
    if (used + w > n - 1) break
    out += ch
    used += w
  }
  return out + '…'
}

// Pad to `n` terminal cells (String.padEnd counts code units, not cells).
export function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

// A row rebuilt from a loaded transcript may carry a sequence number instead
// of a time (lib/backfill.ts); draw it as "earlier", never as 1970.
const KNOWN = 1e11

export function ago(ms: number, now: number): string {
  if (ms < KNOWN) return 'earlier'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return s + 's'
  const m = Math.round(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 48) return h + 'h' + (m % 60 ? (m % 60) + 'm' : '')
  return Math.floor(h / 24) + 'd'
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  return m + 'm' + (s % 60 ? (s % 60) + 's' : '')
}

export function hhmm(ms: number): string {
  if (ms < KNOWN) return '--:--'
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export function kTokens(n: number | undefined): string {
  if (!n) return '0'
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)
}

// Shell words, for matching a Bash command line without a full parser. Quotes
// are honored so `gh pr create --title "a b"` keeps its title as one word.
export function words(cmd: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

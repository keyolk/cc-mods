// The office inbox (~/.claude/state/office/inbox/<sid>.json): text left for a
// session by the office (a reply from its card, a brief answer), by a worker
// for its coordinator (bin/coord-report), and by a coordinator for a worker
// when a peer message cannot reach it (coord.ts send). register.ts takes it
// every 2 s and submits it as the person's prompt.
//
// A plugin's $.prompt.submit is a turn of its own: it waits until the session
// is idle, and resolves only when that turn starts. Taken in the middle of a
// 25-minute turn, an instruction sat in the engine's queue for the whole
// turn while the next ones piled up in the file behind it (2026-11-10,
// office-say-first). So the file is taken only while the session is idle,
// and removed only once the submit's turn started with the text in it.
// Pure: register.ts reads and writes the files.

export type InboxMsg = {
  text: string
  at: number // seconds, of the oldest text in it
  keep?: boolean // a brief answer, a coordinator's instruction, a worker's report
  tries?: number // submits that did not take
  from?: string // the coordinator session that sent it (coord.ts send)
  slug?: string // the worker's slug in that coordinator's ledger
  summary?: string // what that worker was doing, as the coordinator's wakes name it
}

export const INBOX_STALE_S = 120
export const INBOX_KEEP_S = 24 * 3600
// A submit that did not take puts the message back for the next tick; after
// this many it is given up, and a coordinator's sender is told.
export const INBOX_TRIES = 5
// A turn this old that never reported its end is not waited on: the text
// goes to the engine's queue all the same (a missed turn.complete must not
// hold the inbox forever).
export const INBOX_HOLD_MAX_MS = 60 * 60_000
// A coordinator's instruction past this many characters goes to a file the
// worker reads, and the message carries its head and the path. Peer messages
// and prompts both took 150,000 characters whole (2026-11-10, a live probe);
// the cap keeps a runaway paste out of the worker's context, it is no
// engine limit.
export const INLINE_MAX = 100_000
export const SPILL_HEAD = 2_000

export function parseInbox(raw: string | undefined): InboxMsg | undefined {
  if (!raw) return undefined
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!o || typeof o !== 'object') return undefined
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) return undefined
  return {
    text,
    at: Number(o.at ?? 0),
    ...(o.keep === true ? { keep: true } : {}),
    ...(Number(o.tries) > 0 ? { tries: Number(o.tries) } : {}),
    ...(typeof o.from === 'string' && o.from ? { from: o.from } : {}),
    ...(typeof o.slug === 'string' && o.slug ? { slug: o.slug } : {}),
    ...(typeof o.summary === 'string' && o.summary ? { summary: o.summary } : {}),
  }
}

// What goes in as the prompt, or undefined when the message is too old: an
// unmarked one after two minutes, a kept one after a day. A kept one past two
// minutes says how late it is.
export function inboxPrompt(m: InboxMsg, nowS: number): string | undefined {
  const age = nowS - m.at
  if (age > (m.keep ? INBOX_KEEP_S : INBOX_STALE_S)) return undefined
  return age > INBOX_STALE_S ? '(' + Math.round(age / 60) + '분 전 office inbox에 들어온 메시지)\n' + m.text : m.text
}

// Whether the submit's result says the text went in: not dropped, and the
// prompt that entered still carries it. A hook may rewrite a prompt; one that
// took the text out (or a drop) is a delivery that did not happen.
export function landed(r: unknown, sent: string): true | string {
  const o = (r ?? {}) as { drop?: unknown; text?: unknown }
  if (typeof o.drop === 'string') return 'dropped: ' + o.drop
  if (typeof o.text !== 'string') return 'no prompt entered'
  const head = sent.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? ''
  return o.text.includes(head) ? true : 'the prompt that entered no longer carries it'
}

// A message that did not take, back in the inbox under what arrived since:
// its own age and marks, one more try.
export function putBack(m: InboxMsg, newer: InboxMsg | undefined): InboxMsg {
  return {
    text: newer ? m.text + '\n\n' + newer.text : m.text,
    at: m.at,
    ...(m.keep || newer?.keep ? { keep: true } : {}),
    tries: (m.tries ?? 0) + 1,
    ...(m.from ?? newer?.from ? { from: m.from ?? newer?.from } : {}),
    ...(m.slug ?? newer?.slug ? { slug: m.slug ?? newer?.slug } : {}),
    ...(m.summary ?? newer?.summary ? { summary: m.summary ?? newer?.summary } : {}),
  }
}

// One taken file that was never confirmed (the module reloaded while its
// submit waited), back in front of the inbox. It may have gone in already:
// it says so, so a worker reading it twice knows why.
export function resumed(m: InboxMsg, newer: InboxMsg | undefined): InboxMsg {
  const again = { ...m, text: '(전달 확인 전에 다시 보냄: 이미 받았다면 무시)\n' + m.text }
  return newer ? { ...putBack(again, newer), tries: m.tries ?? 0 } : again
}

// The [coord] wake a worker's cc-mods sends its coordinator when an
// instruction never went in (lib/coord.ts recheck keeps it: it names a live
// worker's slug).
export function failWake(m: InboxMsg, reason: string): string {
  const head = m.text.replace(/\s+/g, ' ').slice(0, 160)
  const name = m.slug ?? 'worker'
  return '[coord] ' + (m.summary && m.summary !== name ? m.summary + ' (' + name + ')' : name) + ': 지시 전달 실패 (' + reason + ', ' + (m.tries ?? 0) + '회 시도): "' + head + (m.text.length > 160 ? '…' : '') + '" — 다시 보내거나 파일로 넘겨라'
}

// A coordinator's instruction too long to send whole: its head and where the
// rest is.
export function spilled(text: string, path: string): string {
  return text.slice(0, SPILL_HEAD) + '\n\n(본문 ' + text.length + '자가 길어 파일로 넘겼다. 전문: ' + path + ' — 이 파일을 읽고 그대로 따르라)'
}

// Where a spilled instruction is written: a folder the worker's tools reach
// without a dialog (its research folder, else another --add-dir), else the
// inbox's own folder.
export function spillDir(addDirs: readonly string[] | undefined, slug: string, home: string): string {
  const dirs = addDirs ?? []
  return dirs.find((d) => d.endsWith('/research/' + slug)) ?? dirs.find((d) => d.includes('/research/')) ?? dirs[0] ?? home + '/.claude/state/office/inbox/long'
}

// auto_continue: a turn that ends asking "shall I go on?" with nothing to
// choose between gets "go on" for an answer, so the person does not have to
// type it. The policy line in the system prompt says the same to Claude; this
// catches the turns that still stop and ask.
//
// Whether a question is only "go on?" is Jev's call (bin/cc-bridge.py
// attention with `proceed`), in the same call that sorts ask/action/none: a
// choice, a request for information, or a step that leaves this machine
// (merge, push, send, deploy, delete, prod) stays the person's.

// The reply sent in the person's place.
export const PROCEED_REPLY = '네, 진행해 주세요. (auto_continue: 확인 없이 이어서 진행합니다)'

// Answered in a row without the person typing: past this, stop and let them look.
export const PROCEED_MAX = 3

// What the system prompt says when auto_continue is allowed.
export const PROCEED_POLICY =
  'auto_continue=allow: when the next step is clear, safe, and implied by what the user asked, do it instead of ending with "shall I…?" or "if you want, I can…". ' +
  'Ask only for a real choice between options, information only the user has, or an action that leaves this machine or cannot be undone (merge, push, send, deploy, delete, restart a shared service, prod). ' +
  'A turn that still ends with a plain proceed question is answered "go on" automatically.'

// The question a flow entry names: the last line of the answer that asks.
export function closingAsk(answer: string): string {
  const lines = answer.split('\n').map((l) => l.trim()).filter((l) => l && !/^(?:[-*]\s*)?<?https?:\/\/\S+>?$/.test(l))
  return [...lines].reverse().find((l) => /[?？]|까요|겠습니다|게요/.test(l)) ?? lines.at(-1) ?? ''
}

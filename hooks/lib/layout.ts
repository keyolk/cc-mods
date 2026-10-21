// How wide the cockpit docks: about 3 parts in 8 of the terminal, the chat
// keeping 5 (5:3), and never below 4:3 for the chat on a narrow one. Left to
// the engine's share it opened at over half of a 160-column terminal.
export function cockpitColumns(termColumns: number): number {
  const want = Math.round((termColumns * 3) / 8)
  const most = Math.floor((termColumns * 3) / 7)
  return Math.max(48, Math.min(most, want, 140))
}


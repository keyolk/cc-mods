// Guard approval: when a settings-hook guard refuses a call that the person can
// unlock, ask them right there instead of ending the turn on a deny.
//
// The guards (secret_read_guard, kubectl_context_guard, ecr_push_guard) run as
// PreToolUse settings hooks inside the mod's next(e), so their refusal comes
// back to tool.call as { deny }. This module reads that text and says which
// unlock, if any, would lift it. The unlock itself runs only after the person
// answers $.ui.ask — Claude never reaches it (isSelfGrant refuses that path).

export type Unlock = {
  label: string // shown in the question
  argv: string[] // the unlock command, run as the person
  minutes: number
}

export function unlockFor(deny: string, tool: string, input: Record<string, unknown>, home: string): Unlock | undefined {
  const hooks = home + '/.claude/hooks/'
  if (deny.includes('secret_read_guard')) {
    const path = String(input.file_path ?? '') || /^\s+-\s+(\/\S+)/m.exec(deny)?.[1]
    if (!path) return undefined
    return { label: 'allow reading secret file for 10m: ' + path, argv: ['python3', hooks + 'secret_read_unlock.py', path, '--duration', '10'], minutes: 10 }
  }
  const prod = /Non-readonly operation '([^']+)' on production cluster '([^']+)'/.exec(deny)
  if (prod && tool === 'Bash') {
    return {
      label: 'allow prod write for 15m: ' + prod[2] + ' (' + prod[1] + ')',
      argv: ['python3', hooks + 'kubectl_prod_unlock.py', prod[2] ?? '', '--duration', '15'],
      minutes: 15,
    }
  }
  if (deny.includes('ecr_push_guard') && /provenance|scratchpad|remote branch|ad hoc/i.test(deny)) {
    return { label: 'lift ECR source check for 10m', argv: ['python3', hooks + 'ecr_push_unlock.py', '--duration', '10'], minutes: 10 }
  }
  return undefined
}

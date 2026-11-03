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
  argvs: string[][] // the unlock commands, run as the person, all of them
  minutes: number
}

// The paths secret_read_guard listed: one "  - /abs/path" bullet per hit, all
// already absolute (the guard normalises them). A Bash line can hit several
// (`cat a.tfvars b.tfvars`); unlocking only the first left the retry denied
// on the second.
export function secretPaths(deny: string): string[] {
  return [...new Set([...deny.matchAll(/^\s+-\s+(\/\S+)$/gm)].map((m) => m[1]!))]
}

export function unlockFor(deny: string, tool: string, input: Record<string, unknown>, home: string): Unlock | undefined {
  const hooks = home + '/.claude/hooks/'
  if (deny.includes('secret_read_guard')) {
    const listed = secretPaths(deny)
    const paths = listed.length ? listed : [String(input.file_path ?? '')].filter(Boolean)
    if (!paths.length) return undefined
    return {
      label: 'allow reading secret file' + (paths.length > 1 ? 's' : '') + ' for 10m: ' + paths.join(', '),
      argvs: paths.map((p) => ['python3', hooks + 'secret_read_unlock.py', p, '--duration', '10']),
      minutes: 10,
    }
  }
  const prod = /Non-readonly operation '([^']+)' on production cluster '([^']+)'/.exec(deny)
  if (prod && tool === 'Bash') {
    return {
      label: 'allow prod write for 15m: ' + prod[2] + ' (' + prod[1] + ')',
      argvs: [['python3', hooks + 'kubectl_prod_unlock.py', prod[2] ?? '', '--duration', '15']],
      minutes: 15,
    }
  }
  if (deny.includes('ecr_push_guard') && /provenance|scratchpad|remote branch|ad hoc/i.test(deny)) {
    return { label: 'lift ECR source check for 10m', argvs: [['python3', hooks + 'ecr_push_unlock.py', '--duration', '10']], minutes: 10 }
  }
  return undefined
}

// God mode lifts secret_read_guard too: it is not a session_policy capability,
// so godArgvs() alone left every secret read still asking. The unlock is a TTL
// stamp shared by every session on this machine (secret_read_unlock.py has no
// session scope), so it is set to the god end and revoked when god ends.
export function godSecretArgv(home: string, minutes: number): string[] {
  return ['python3', home + '/.claude/hooks/secret_read_unlock.py', '--all', '--duration', String(Math.max(1, Math.ceil(minutes)))]
}

export function godSecretRevokeArgv(home: string): string[] {
  return ['python3', home + '/.claude/hooks/secret_read_unlock.py', '--all', '--revoke']
}

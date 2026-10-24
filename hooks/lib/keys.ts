// Store keys and the shapes kept under them. $.store is one JSON file per
// plugin shared by every session on the machine, so per-session data is keyed
// by session id and shared data (radar, PR cache, autocomplete sources) is not.
//
// `$.state` holds what drives drawings within a session; see types/index.d.ts.

export const K = {
  radar: 'radar', // Radar, shared
  prs: 'prs', // Record<key, PrStatus>, shared
  prWatch: 'pr-watch', // Record<key, { session, at }>, shared: which PRs to poll
  mcpList: 'mcp-list', // { at, items: AuthItem[] }, shared: the last `claude mcp list` (one session runs it)
  sources: 'complete-sources', // Sources, shared
  outputs: (sid: string) => 'outputs:' + sid, // Output[] for one session
  sessions: 'sessions', // Record<sid, { cwd, repo, window, at }>, shared
  openPanes: 'open-panes', // string[] — which cockpit panes were open last
  slackNames: 'slack-channel-names', // Record<channelId, '#name'>, shared
  cockpitSettings: 'cockpit-settings', // { onStart?, embed?, slashHide?, mcpHeal? }, shared: this machine's cockpit preferences
  slackUsers: 'slack-user-names', // Record<userId, '@Name'>, shared: people a DM scope names
  slackFollow: 'slack-follow', // Record<'channel:root', SlackFollow>, shared: threads followed up automatically
  slackSeen: 'slack-seen', // Record<'channel:root', ts>, shared: newest reply the person has seen
  policyTimers: (sid: string) => 'policy-timers:' + sid, // Record<label, { expiresAt, revert: string[] }>
  god: (sid: string) => 'god:' + sid, // { until, before: Policy } while god mode is on (register.ts)
} as const

export const PANES = ['flow', 'graph', 'side', 'outputs', 'policy'] as const
export type PaneId = (typeof PANES)[number]

export const PANE_TITLES: Record<PaneId, string> = {
  flow: 'flow',
  graph: 'graph',
  side: 'side',
  outputs: 'outputs',
  policy: 'policy',
}

export const PANE_PREFIX = 'cc-'

export function paneKey(id: PaneId): string {
  return PANE_PREFIX + id
}

export function paneOf(requestId: string): PaneId | undefined {
  const id = requestId.startsWith(PANE_PREFIX) ? requestId.slice(PANE_PREFIX.length) : ''
  return (PANES as readonly string[]).includes(id) ? (id as PaneId) : undefined
}

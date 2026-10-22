// $.state values: reactive, per session, survive a module reload. Writing one
// redraws every site that read it. Self-contained on purpose: the manifest's
// `types` file may not import, so the shapes here are loose and the precise
// ones live in hooks/lib/*.ts.

declare module 'claude-code' {
  interface PluginState {
    'cc-mods': {
      flow: any[]
      answers: Record<string, string>
      turns: any[]
      agents: any[]
      outputs: any[]
      side: any[]
      policy: any
      auth: any[]
      prs: any[]
      hints: any[] // ScopeHint[] seen in this session (lib/policy.ts)
      slack: Record<string, any> // thread id -> SlackThreadState (hooks/lib/slack.ts)
      neighbors: any[]
      resume: any // Pending | null (lib/resume.ts)
      elsewhere: { windows: any[]; todos: any[] }
      narwhal: { items: any[]; told: string[]; dismissed: string[]; runs: any[] } // lib/narwhal.ts
      monitors: any[]
      route: { last?: any }
      usage: { usage?: any; note?: string; quota: any[]; window: '1h' | '6h' | 'session'; jev?: any }
      goal: any
      blocked: any[]
      mcpLogin: any
      rca: any
      moved: { prompt: string; pane: string }[]
      live: any
      palette: { open: boolean; query: string; sel: number }
      help: boolean // the key help (alt+/) is open
      webSettings: { open: boolean; engine: 'electron' | 'chrome' | 'webkit'; device: string; rate: number }
      webKeyboard: 'controls' | 'page'
      webSide: { pane?: string; engine?: 'electron' | 'chrome' | 'webkit'; tabs: { index: number; title: string; url: string; active: boolean }[]; others: number; floating?: boolean; error?: string; checked?: number; panel?: 'console' | 'network' | 'auto'; console?: { at: string; level: string; text: string }[]; network?: { at: string; method: string; status?: number; type: string; url: string; failed?: boolean }[]; presence?: { driving?: { method: string; at: number }; link?: { owner: string; expiresAt: number }; conflictAt?: number }; linkUnsupported?: boolean; linkedAt?: number; link?: { state: 'ok' | 'down' | 'missing'; at: number; detail?: string; daemon?: { pid?: number; uptimeMs?: number; panes?: number; protocol?: number; engine?: string } } }
      webAuto: { id: string; at: number; verb: string; detail: string; pane?: string; state: 'running' | 'ok' | 'failed' }[]
      slackFollow: Record<string, { auto: boolean; lastRun?: string }>
      web: { running: boolean; engine?: string; url?: string; asked?: string; title?: string; shown?: boolean; floating?: boolean; error?: string }
      fork: { prompt: string; p: number; at: number; later: number } | null
      exp: Record<string, any> // archive folder path -> ExpCheck (lib/exp.ts)
      ui: {
        flowFilter: string
        flowProgress: boolean
        flowSel: number
        graphMode: string
        graphSel: string
        graphCollapsed: boolean
        outTab: string
        outScope: string
        outSel: string
        outQuery?: string // In/Out tab: the filter field's words
        watchSel?: string // Now tab: the watch row selected (its stop button shows)
        policyMsg: string
        policyMore?: string // the capability whose known candidates are expanded
        authMcp?: boolean // the Auth tab's connector list unfolded
        outSide?: 'out' | 'in' // In/Out tab: what the session made, or what it was handed
        webPick?: boolean // the Web tab's URL picker is open (the go field has the ring)
        webQuery?: string // what is typed in the go field
        webPickFolded?: boolean // the go field's URL list is folded to one line
        focus: boolean
        cockpitAt?: number // the person last used the cockpit
        promptAt?: number // the person last submitted a prompt
        focusKey?: string // where the cockpit's ring last was
        view: string
        open: boolean
      }
    }
  }
}

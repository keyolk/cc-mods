// The cockpit's key help (alt+/): every key it answers, grouped by where it
// works. Pure: the fixed keys are data here; the open tab's own letter keys
// come from what register.ts collected off the last drawing, so a tab that
// gains a hotkey shows up without touching this list.

export type HelpSection = { title: string; rows: [string, string][] }

// What `?` lists. `tab` names the open tab; `tabKeys` are its letter hotkeys
// with the label each Button carries, in drawing order.
export function helpSections(tab: string, tabKeys: readonly { key: string; label: string }[]): HelpSection[] {
  const seen = new Set<string>()
  const own: [string, string][] = []
  for (const k of tabKeys) {
    // k is the palette everywhere; a key drawn twice (a filter row and a
    // hidden twin) is listed once.
    if (k.key === 'k' || seen.has(k.key)) continue
    seen.add(k.key)
    own.push([k.key, k.label])
  }
  return [
    {
      title: 'Anywhere',
      rows: [
        ['alt+tab', 'Claude ⇄ cockpit; from TWeb Page → Claude (alt+c too)'],
        ['alt+w', 'Web tab: cockpit controls ⇄ TWeb Page keyboard'],
        ['alt+← alt+→', 'wider / narrower cockpit, from the prompt too'],
        ['alt+s', 'search settings, actions and places (from the prompt too)'],
        ['alt+/', 'this help (the ? key with alt)'],
      ],
    },
    {
      title: 'Cockpit',
      rows: [
        ['1-9', 'tabs: Now Chat Work In/Out Policy Web Usage Auth Settings'],
        ['k', 'search (as alt+s)'],
        ['Tab ⇧Tab', 'next / previous element'],
        ['↑↓←→', 'move by layout; scroll when nothing is that way'],
        ['Enter', 'press the element'],
        ['Esc', 'leave a text field (stays in the cockpit); close search or help'],
        ['alt+<letter>', 'that letter key under Korean input (not c s h j k l)'],
        ['ctrl+x x', 'close the cockpit'],
      ],
    },
    ...(own.length ? [{ title: 'This tab (' + tab + ')', rows: own }] : []),
    {
      title: 'Search',
      rows: [
        ['type', 'filter; several words match in any order'],
        ['↑↓ Tab', 'pick'],
        ['Enter', 'run; a place puts the keyboard there'],
        ['Esc alt+s', 'close'],
      ],
    },
    {
      title: 'Commands',
      rows: [
        ['/cockpit', 'open or close the cockpit'],
        ['/side [q]', 'ask a side question (Chat tab)'],
        ['/web [--chrome] url', 'open a page in the Web tab'],
        ['/policy', 'show or change the session policy'],
        ['/browser', 'where links open'],
      ],
    },
  ]
}

# cc-mods

A Claude Code mod for a tmux-centred setup: session state in tmux, toggled
cockpit panes, a credential radar, and session policy that only a person can
change.

Tested with Claude Code **2.1.296** (mods need ≥ 2.1.287; `prompt.autocomplete`
needs ≥ 2.1.290).

## What it does

| Area | What you get | Replaces |
|---|---|---|
| **tmux state** | `@cc_state` / `@cc_attention` set from the events themselves: `working` on turn start, ❗`action` the moment a permission prompt is decided `ask`, ❓`ask` the moment a question dialog draws, `working` again once it is answered, then Jev's ask/action/none at turn end, 💤 after 30 idle minutes. Adds `@cc_ctx` (context %), `@cc_agents` (running subagents + background tasks), `@cc_policy` (anything unlocked), `@cc_auth` (expired/soon). Same contract twm, brd and `tmux_neighbors.py` already read. | `tmux_window_status_{start,stop}.py` |
| **/flow** | The session as prompts and conclusions only — no tool calls. Filters: all / conclusions / decisions+findings; progress chatter folds. Select a line → ask about it in /side, or copy. Back-fills from the transcript when opened mid-session. | — |
| **/graph** | Requests → subagents (nested by parent), background Bash, Monitors, as a tree or a timeline; tokens, tool counts, duration, prompt and result per node; Mermaid export. | — |
| **/side** | Questions about the conversation that never enter it, answered by `$.model.fork` (the session's own transcript and prompt cache, no tools). Send to main / fill the prompt / copy / redo with a subagent. `/side <question>` asks without opening anything. | built-in `/btw` (ephemeral) |
| **/outputs** | PRs, artifacts, scratch files, Jira tickets, links, background tasks the session produced, with preview (Markdown, code, PNG in the terminal, log tail, an archive's listing or first lines), open (tmux-chrome), folder (`r`: Finder on it, the file selected), copy, put in context, keep/delete scratch. Files an answer hands over (a path it names, or a name under a folder it names, that exists) are starred ★ and listed first under Files, wherever they live. Scope: this session / this repo / today across sessions. Exported to `~/.claude/outputs/<date>/<sid>.json` at turn end and session end. | re-parsing transcripts (`ccx refs`, daily check-in) |
| **/policy** | Capabilities as rows you flip, mode presets, scoped grants, 15-minute timed grants. `/policy allow merge owner/repo 15m` without opening anything. Footer shows the policy (`merge🔒`, `merge(1)`, `prod:ro`). | `/session-policy` skill turns, `session_policy.py inject` |
| **self-grant block** | Claude's Bash running `session_policy.py allow|block|inherit|mode|clear` or a `*_unlock.py` is refused (fail-closed `.catch`). Only the person's own `/policy` (origin `composer`) or a pane press changes policy. | — (was a hole: the guard's deny text told Claude the command that lifts it) |
| **band** | Above the prompt, only when there is something: expired/soon AWS SSO / gh / Coder / ArgoCD / daemon (press to log in), this session's PRs (checks, approvals, unresolved threads, conflict; follow-up / review-request buttons), neighbors in the same repo, and a fork offer when a prompt looks like a separate line of work. | `tmux_neighbors.py` context injection, `flow_fork_hint.py` AskUserQuestion |
| **narwhal** | What the narwhal runs this session started need, in Now › Needs you: a question with its options as buttons (the recommended one ★) and a field for any other answer, the context or what its labels mean, a worker judged stuck, a run that finished or failed (press to bring its result into the conversation). Every item opens `narwhal monitor --run` beside the pane. The Work tab lists the runs this session started (state, progress, each task with its model and first line of outcome; press to open the monitor), and Outputs gets what they produced — PRs (followed by the PR poller like the session's own), files, and each run's answer. Polled every 20 s from the daemon's `/control/attention` and `/control/runs` (`?session=<id>`); a new question also raises `@cc_attention` to ask. Needs narwhal ≥ #91. | answering only in `narwhal monitor` |
| **auth pre-check** | An `aws --profile …` / `kubectl --context …` call while SSO is expired stops before it fails: log in and continue / run anyway / cancel. | failing, then a turn to explain |
| **gh account** | A `gh` call against a repo whose owner `org.json` maps to a login runs with that login's token (`GH_TOKEN` from `gh auth token --user`), without `gh auth switch`, so other sessions keep their account. | `gh auth switch` (170× in 30 days) |
| **PR polling** | One GraphQL query per account every 90 s for every PR any session touched, cached in `$.store` for all sessions; toast on newly failing checks or merge. | per-PR `gh pr view` / `gh pr checks` polling |
| **autocomplete** | kubectl contexts and AWS profiles labelled with their stack (`org.json`), Jira keys seen, open PRs (`#91…`), tmux windows (`@w:name`). | — |
| **policy in the system prompt** | Policy reaches Claude once via `prompt.compose` (session scope), not as context on every prompt. | `session_policy.py inject` |

Judgment that already existed in `~/.claude/hooks` is reused through
`bin/cc-bridge.py` (Jev attention, fork judgment, neighbors), not rewritten.

## Commands

The right side is **one pane, the cockpit**, with five tabs. Each tab groups
the areas that answer the same question:

```
cockpit  ❓ waiting  ctx ▰▱▱▱ 9%                         00:15
1: Now   2: Chat 4   3: Work ⏳1   4: Outputs 3   5: Policy ✗1
Now     Needs you (only when actionable) · In progress (current request + answer,
        running work, latest Monitor events) · This session (earlier requests,
        outputs)
Chat    flow of requests and conclusions, side questions under it
Work    subagents and background tasks, Monitors (Watch) under them
Outputs PRs, artifacts, files, tickets, links
Policy  session policy, credential radar under it
Web     the TWeb pane beside this one: its tabs and controls (/web <url>);
        with browserEmbed on, the page drawn in the cockpit (bin/cc-browser)
Usage   ccproxy: last request's account/model/effort, accounts with quota
        windows and resets, models, output/request trend (h 1h · w 6h)
```

Digits 1-7 switch tabs. Esc hands the keyboard back to the prompt and leaves
the cockpit open. All commands are `immediate` and open the cockpit at their
tab (`/side` → Chat, `/watch` → Work); the same command again closes it, as
does ctrl+x x.

Every interactive session opens the cockpit at start, docked right of a
fullscreen transcript, without taking the keyboard (`cockpitOnStart`, on by
default; turn it off in `/plugin` → cc-mods → configure).

One chord flips the keyboard between the prompt and the cockpit when it is
bound both ways in `~/.claude/keybindings.json` (alt+tab here, alt+c kept as
the same; Claude Code matches alt and meta as one modifier, and the terminal
must send Option as Alt — Ghostty `macos-option-as-alt = true`). Tab is not
touched by a Korean input source, so alt+tab needs no physical-key mapping.
Claude Code warns that alt+tab "may not work" (a Windows/Linux window
switcher); on macOS Option+Tab reaches it. From the prompt it borrows
`agents:setGroup` (a Chat binding to another context's action never
dispatches), which the cockpit's hidden Button carries:

```json
{ "context": "Global", "bindings": { "alt+tab": "agents:setGroup", "alt+c": "agents:setGroup" } },
{ "context": "Pane", "bindings": { "alt+tab": "agents:setGroup", "alt+c": "abovePrompt:leave", "alt+w": "agents:switchView" } },
{ "context": "PaneField", "bindings": { "alt+tab": "agents:setGroup", "alt+w": "agents:switchView" } }
```

Bind `abovePrompt:leave` in `AbovePrompt`, `AbovePromptInput`,
`AbovePromptSelect` and `PaneField` too, so it works on any element.

Esc in a text field leaves the field, not the cockpit: by default it is
`abovePrompt:leave` there, which hands the keyboard back to the prompt. Bound to
`abovePrompt:previous`, the ring moves to the element before the field and the
cockpit keeps the keys (alt+c still leaves). In the palette's query field the
same Esc closes the palette.

```json
{ "context": "PaneField", "bindings": { "escape": "tabs:next" } },
{ "context": "AbovePromptInput", "bindings": { "escape": "abovePrompt:previous" } },
{ "context": "AbovePromptSelect", "bindings": { "escape": "abovePrompt:previous" } }
```

alt+← / alt+→ widen and narrow the cockpit, from the prompt too. Inside it
they are the engine's `pane:grow` / `pane:shrink` (`ctrl+x ←/→` by default).
Those are Pane-context actions and no plugin API sets a width, so from the
prompt Global binds the chords to borrowed actions; the cockpit's hidden
Buttons then take the keyboard into it, replay the chord there through tmux
and hand the keyboard back with alt+c. A draft in the composer refuses that
focus, so with text in the prompt nothing happens (a toast says so). With the
cockpit closed, alt+← opens it. The engine keeps a keyed width in
`~/.claude.json` (`pluginPanes.dockColumns`) for later sessions, over the
cockpit's own 3/8 share; delete that key to go back to it. In a text field
(the Web tab's go field, a filter) `pane:grow` does nothing, so PaneField
binds the chords to the same borrowed actions: the ring moves onto the open
tab's button and the chord is replayed there, keeping the keyboard in the
cockpit. A TWeb page holding the keyboard (Web tab, browserEmbed on) or a
TWeb pane beside takes alt+←/→ itself. Ghostty sends
alt+←/→ as `esc:b` / `esc:f` by default; map them to the xterm form
(`keybind = alt+arrow_left=csi:1;3D`, `alt+arrow_right=csi:1;3C`).

```json
{ "context": "Global", "bindings": { "alt+left": "agents:previousGroup", "alt+right": "agents:nextGroup" } },
{ "context": "Pane", "bindings": { "alt+left": "pane:grow", "alt+right": "pane:shrink" } },
{ "context": "PaneField", "bindings": { "alt+left": "agents:previousGroup", "alt+right": "agents:nextGroup" } }
```

In a focused pane the engine hands any key no binding of the `Pane` context
claims to the prompt, which then takes the keyboard. Left and right are among
them by default; binding them as the engine's own band does keeps them in the
cockpit:

```json
{ "context": "Pane", "bindings": { "left": "abovePrompt:previous", "right": "abovePrompt:next" } }
```

A printable key no Button `hotkey` claims goes to the prompt, which then takes
the keyboard, and no binding swallows a key (`null` unbinds, it does not
claim). So the cockpit draws a hidden Button for every letter and digit first;
its own hotkeys, drawn later, win their keys, and any other letter does
nothing. Leaving the cockpit is alt+c (or a click);
Esc is bound to `abovePrompt:previous` in `Pane` and `AbovePrompt` so it no
longer drops to the prompt:

```json
{ "context": "Pane", "bindings": { "escape": "abovePrompt:previous" } }
```

## In/Out filter

The In/Out tab (4) has a filter field above its list (`g` puts the keyboard
in it; the palette's "Filter In/Out by words" too). Every word typed must
appear somewhere in an item: its kind and that kind's words (`jira` for
tickets, `doc` for artifacts, `task` for background tasks), title, URL, path,
detail or the session window it came from; any order, case-insensitive. It
narrows the kind tabs and both sides, and their counts: `slack infra` is
Slack threads whose channel or title says infra, `abc-12` tickets by key.
Esc leaves the field; ✕ clears it.
## Archive folders (`~/exp/<date>_<topic>/`)

What a session exchanged with an outside party (a vendor ticket, a Slack
Connect thread) is kept in a dated folder under `~/exp/`, in the layout the
`exp-archive` skill writes: `README.md` (with a `## Open` list of what is
still owed), `correspondence.md` (one row per message in or out),
`attachments/` with `SHA256SUMS`, `drafts/`, `work/`.

- **Linked to the session** that writes into one: a Write/Edit under it, a
  shell command that writes there (`mkdir`, `mv`, `cp`, `tee`, `>` …), or an
  answer that names it. Reading one (`ls`, `cat`) does not link it. The link
  is an `exp` output, so it is kept with the session and exported with it.
- **In/Out › Archive** (`e`) lists them with what they owe and their sums;
  the preview shows the Open items, the attachment check, the last message
  and the README. `o` opens the folder, `r` reveals it in Finder.
- **Now › Needs you** shows a folder while its Open list has items, or when
  an attachment no longer matches `SHA256SUMS` (changed or gone) or a file in
  `attachments/` has no sum. A press opens it in In/Out.

Sends to Slack Connect are often made by hand, outside Claude's tools, so the
folder, not the send, is what is tracked. Sums are checked when a folder is
linked, when it is opened, and every five minutes.

## Office (`/office`)

Every Claude Code session in tmux as a chibi in a quarter-view office, in a
TWeb pane beside this one, live (2 s). `office/office.py` serves it on
`127.0.0.1:8796`, shared by all sessions; `/office` starts it when nothing
answers there. It is named after you (`🏢 Gavin네 사무실`): `OFFICE_OWNER`,
else the first name of your account's full name, else your login name.

- **One pod per tmux window**: its sessions sit at its desks side by side, the
  window name on each desk's front.
- **Where a session stands** follows its last tool call (its transcript):
  📚 library while reading, 🛠 workshop while running a command, 📞 a phone
  booth during an MCP call, its desk while writing (typing) or with no tool (chin in hand, `…`),
  `?` / `!` over its head while it waits on you.
- **Back to its desk**: a reply, a pick or a grant sent from the office gets
  the session up at once (`❗`, hurrying) to its desk, before its own state
  catches up; and a session that has just finished stays at its desk for 90
  s holding its answer up (a page with a tick) before it wanders off, so a
  short job shows as it coming back and answering.
- **Going home**: a session whose tmux pane is gone from three consecutive
  polls walks out through the `EXIT` door in the left wall near the front and
  fades out there. If the pane still exists, a missing pane-session option does
  not start the animation. A session that returns before leaving cancels it. After a long day (8 h or 2000 tool
  calls) it leaves slumped and slow, with bags under its eyes, a grey cloud and
  `휴… 퇴근`; after a short one (under an hour) hopping with its arms up and
  `퇴근이다!`; otherwise a wave and `수고했습니다`.
- **Idle** sessions go to the ☕ lounge, which has no seat limit; after 10
  minutes they lie down in a pile in front of the sofa, asleep.
- **Subagents** (`<project>/<sid>/subagents/agent-*.jsonl`, live while written
  in the last 45 s) are small ones with an antenna from the queue in their
  narrow room at the far end, as deep as the other rooms (`🐣 N` on its door
  at the front, fewer while some are out): the door opens, the head of the
  queue walks out to its session and stands with
  it (a row in front of its desk, or around it in a room) on a dotted tether,
  shows its own work by pose and bubble, and walks back in when done.
- **Personality** from its own transcript, every tool call counted once
  (read incrementally): its **job** is the kind of tool it uses most beside
  Bash — 📣 communicator (Slack: headset), 📝 writer (Docs/Artifact: beret,
  glasses), 💻 developer (Edit/Write: headphones), 🔍 detective (Read/Grep/Web:
  fedora), 👀 watcher (Monitor: binocular eyes), 🧑‍💼 manager (Agent/Workflow:
  tie), 🛰 operator (other MCP tools: hard hat), ⌨️ hacker (nearly all Bash:
  hoodie). Each job walks its own way (a scurry, a sway, a look-around) with
  what it carries, and works with its own effect (`{ }` rising, letters from a
  pen, chat bubbles, a scanning gaze, `01` rain, radio arcs, a pointing hand).
  Its **age** is how long the session has lived (its transcript's first
  line): grey streaks after a day, silver hair and a beard after three, a cane
  and a slower walk after a week; the tooltip says how long (근속).
  Its **rank** is its total calls: 🐣 new (<100), staff, senior, manager, lead
  (silver crown), 👑 head (10,000+, gold crown); a little taller each step, and
  the desk fills with papers, a plant, a trophy.
- **Walking** goes round things: the floor is a grid with desks, furniture
  and walls blocked, A* finds a way along the aisles, the path is smoothed
  where the line is clear, turns bend and the last steps ease in. Depth sorts
  a desk by its front corner, so someone behind a desk is hidden by it and
  someone in front is not covered.
- **Facing** follows each step: walking right or left mirrors the body (what
  it carries goes with it) and turns the face three-quarters that way (eyes,
  mouth and the near cheek shift, the far cheek narrows); walking away (up the
  screen) shows the back of the head with the hat, and no tie or badge. At
  rest it faces us.
- **Hover** and a character reacts to you: one waiting on you is eager
  (sparkly eyes, hops, hearts), one working is nervous (sweat drop, tiny
  pupils, a shiver), one idle or asleep is startled awake (`!`), a subagent
  is shy (blushes, leans back). It eases in and out.
- **Quick actions**: a click on a character (or a `❓`/`❗` chip at the bottom)
  opens its card: what it last said, and
  - a choice dialog on its screen (a permission prompt, AskUserQuestion): each
    option a button, which sends that digit to its pane while the dialog is up;
  - otherwise one-press replies (`1번으로 해 주세요` for the numbered choices
    its answer ends on, yes/no for a question, `계속 진행해 주세요`) and a free
    reply. The text waits in `~/.claude/state/office/inbox/<sid>.json` and that
    session's cc-mods submits it as your own prompt (2 s poll, dropped after 2
    minutes), so vim mode or a draft in the box cannot garble it;
  - `✋ stop` (Escape) while it works, and `↗` to its window (`cc-focus`).
- **Policy on approval**: when a waiting session needs a policy change to go
  on, its card proposes one, picked by Jev (`bin/cc-bridge.py policy`) from
  the guards' own refusals in its transcript (`/policy allow merge
  owner/repo`, `/policy allow prod-w ctx/ns 15m`) or, without one, from what
  its last answer asks for. `A` (or the button) approves it: the office runs
  the policy CLI for that session with the grant it proposed (never one sent
  by the page) and puts it back after its minutes. Timers live in the office
  server; a grant outlives a server restart until changed by hand.
- **Links and related work**: URLs in what a session said open in your
  browser, absolute paths show in Finder; the card lists its PRs, threads,
  tickets, artifacts and files (from cc-mods' `~/.claude/outputs` export,
  what it made first), each one click away. Well-known places are badges in
  their own colour with their logo and a short name (`PR o/r#14`, `Jira
  INF-123`, `Slack #channel`, Grafana, Google Docs/Sheets, Notion, Linear,
  Figma, Sentry, PagerDuty, Datadog, Argo CD, …; `office/brands.js`, logos
  from simple-icons, CC0).
- **The waiting queue** along the bottom: everyone who needs you, a
  confirmation (❗) before a question (❓), then whoever has waited longest,
  each with how long. `N`/`Tab` opens the next one's card (`P`/`⇧Tab` the
  previous): the camera glides and zooms to it and a ring and arrow mark it.
  A reply or a dialog pick moves on to the next one by itself.
- **Sessions talking**: a message one session sends another (SendMessage,
  read from the sender's transcript; the recipient's peer name resolved
  through `~/.claude/sessions/<pid>.json`) flies across as a paper plane on an
  arc; on landing a bubble over the recipient says who sent what. One to a
  session not in the office flies off past the wall. The last 15 minutes are
  kept: hovering a character (or opening its card) draws dashed threads to
  whom it talked, with a count, and its card lists them (`→` sent, `←` got).
- **A head as full as its context**: past 50% a scribble of thoughts hangs
  over it, past 65% the hair stands up and it sweats, past 80% papers, `?` and
  gears orbit it and it steams, past 90% the eyes spiral and pages fly off.
- **Compaction**: while Claude Code compacts (its pane says "Compacting
  conversation"), the session presses its temples and the papers spiral into
  a summary box over its head (`🗜 압축 중…`); right after (a `compact_boundary`
  in the transcript) the head is clear and sparkles under `🧹 정리 완료 ·
  96%→18%`. Every compaction so far is a summary box stacked by its desk
  (`×N`; hover says how many and when the last was).
- **No double answers**: a card says at once, under its title, when the
  session is working (the tool, for how long) or when a reply sent from the
  office has not been taken yet (`📨`), kept current as it changes; quick
  replies dim while it works. A reply then is refused once with that reason
  (the server checks the session's state and its inbox); pressing again sends
  it anyway, as a queued follow-up.
- **미루기**: one button (`Z`, or `⌥Z` in the reply box) opens a menu: 30
  minutes, an hour, the rest of today, or `🤐 until you speak first`, and,
  when already set aside, call it back now (digits pick). A set-aside agent
  leaves the Tab/N queue and stops lighting its pod up, whatever it waits on;
  speaking to it first lifts any of them (a reply, a pick or a grant from the
  office, or anything you type to it yourself: a human prompt in its
  transcript after you set it aside), and a timed one also ends on its time.
  A timed one wears `💤` (`💤!` with something to say); one waiting for you to
  speak has its mouth zipped shut and, with something to say, strains (the
  pull tab jiggling):
  cheeks puffed and reddening, a hand up and waving, a muffled `음! 음음!`
  bubble going nowhere. Chips: `💤 name · N분`, `🤐 name · 할 말 참는 중 N분`.
  Kept in `~/.claude/state/office/mute.json`.
- **Desks differ** by window: wood, white, dark, pastel or standing desks; a
  striped, checked or round rug; in a pod with a free seat a plant, a
  bookshelf, a beanbag, a whiteboard, a sleeping cat, a water cooler, an
  arcade cabinet or a floor lamp (walkers go round it). What is on the desk
  follows the job: two screens for code, a laptop and a lamp for writing, a
  wide screen for watching, a little rack for ops, a book pile for reading.
- **Desks show the work**: what a session took in and made (its cc-mods
  outputs) sits on its desk. A two-tier tray: the lower tier what it was
  handed (PRs, threads, tickets, links from you or that it read), the upper
  tier what it sent out (its PRs in GitHub black with the logo, Slack replies
  in aubergine, tickets in Jira blue). A yellow pad pile for scratch files, a
  printout pile for files it wrote, binders for exp archives, a framed picture
  for artifacts; piles grow with the count. Hover one for what and how many; a
  click opens the card with that shelf on top, every item in it (`/detail?kind=`).
- **The desk opens**: a click on a desk (not on one of its things) opens its
  drawers in the card, a tab a kind: 📥 받은 것, 📤 보낸 것, 📝 스크래치, 📄
  파일, 🗂 exp, 🖼 아티팩트, each item a badge or chip one click away; `[`/`]`
  switch tabs. A click on one thing opens the drawers at its tab.
- **Rooms say what they are for**: a plaque sits on the back wall's top over
  each room and the subagents' queue (with how many are there, or out working);
  the meeting room has its own sign. Hovering a room's floor lights it up and
  says when a session comes there and who is there. The tmux sessions' names
  sit on plaques right against the left wall, over a band in their colour.
  The library has parquet, a long reading table with green lamps and a ladder;
  the workshop a concrete floor with a hazard stripe, a tool pegboard, a bench
  whose terminal shows what the people in the room are running and a machine
  whose gears turn and steam while someone is there; the phone booths a navy
  carpet and three booths (an `ON AIR` lamp, the handset off the hook while
  used), the logo and name of the service on the line over the caller; the
  lounge a patterned carpet, a café table with donuts and a
  vending machine. Over a visitor, while you hover its room or it, a tag says what it reads
  (`📖 file`) or runs (`$ command`), or which service it calls. What they do there differs too: turning pages,
  pulling a book off the shelf, a magnifier; typing on a laptop, plugging in a
  cable with sparks, the handset at the ear in a booth; sipping coffee, stretching,
  a donut, a handheld game.
- **Several at once, and meetings**: `V` (or the `☑ 고르기` chip in the top row)
  turns on pick mode. Clicking either a person or their desk picks the same
  session. A drag lassoes sessions whose person or desk is inside it (a dashed
  ring on the person and a blue outline on the desk); `⇧click` / `⇧drag` do the
  same where the terminal lets Shift+mouse through. A bar then offers `🗂 창
  옮기기`, `🗣 회의`, `📣 공지` and `💤 미루기`. A meeting (2 to 8, a topic typed in the bar)
  walks them into the glass meeting room (the corner between the lounge and the
  crowd, as deep as the rooms) round its table; each is told,
  through its inbox, who else is there by the names `SendMessage` takes, who
  leads (the first picked) and where the minutes go
  (`~/.claude/state/office/meetings/<id>.md`), and to keep to its policy. Their
  messages fly over the table; the whiteboard shows the topic and the
  minutes' last lines. It ends when the lead writes `회의 끝` in the minutes,
  when you end it (its queue chip's `✕`, twice) or after two hours, and they go
  back to their desks. The chip's topic, or the table, opens the minutes. An
  announcement goes to each picked one's inbox; messages waiting there are
  kept and the new one added after them.
- **Move windows while picking**: in pick mode, drag either a picked person or
  their desk (the whole tmux window) onto another pod to merge it into that
  window, or onto another tmux session's block to send it there. Normal desk
  dragging no longer moves a window accidentally. The drop asks first (`⏎`
  moves, `Esc` drops it), then the office runs tmc's own moves, `tmc window
  merge|send` (the TUI's `x m` / `x s`; keyolk/tmc#18). The windows are
  resolved from tmux by the sessions they hold, never taken from the page;
  `OFFICE_TMC` points at another tmc.
- **Files open inside**: a file chip or path marked 👁 (HTML, SVG, PDF,
  images, Markdown, text, JSON; an exp folder's README) opens in a viewer
  beside the card; `O` or `↗ 밖으로` opens it outside, `Esc` closes it. Only
  paths in that session's outputs are served (`/file`), in a sandbox with no
  reach into the office page. claude.ai artifacts and GitHub refuse to be
  framed, so links open outside, by default where that session's own links
  go: `tmux-chrome-open` with its pane, so its `@browser` picks TWeb on your
  Chrome (signed in) or the tab group.
- **Visual skins**: `⚙` switches the scene renderer, not only CSS. A skin in
  `office/skins.js` supplies UI CSS, title, room presentation, canvas palette,
  and optional scene, desk, character and frame renderer hooks. `🏢 모던
  오피스` keeps the original. `⚔ 클래식 판타지 길드홀` is an original
  early-2000s 2D-sprite-on-3D-isometric-world treatment: parchment-and-wood
  chrome; records archive, forge, crystal comms and tavern; oak, stone, rune
  and woven-rug floors; timber posts, stone feet, wall torches, a guild crest,
  lantern warmth and subtle screen grain. Its workers use a separate 32×48
  low-resolution sprite renderer with nearest-neighbour scaling, directional
  walk frames, stepped hair, job headgear and props, rank crowns and zipped
  mouths. Each session keeps one fantasy people (human, elf, dwarf, orc,
  halfling or tiefling); subagents are hovering, winged fairies. Guild
  furniture replaces bookshelves, forge machinery, café, sofa, vending
  machine, radiators, chairs, decorations and the glass meeting room. Timber
  balustrades replace cubicle partitions, an arched oak gate replaces the EXIT
  door, and pointed leaded-glass windows with oak shutters replace office
  windows and blinds.
  The phone booth becomes a carved crystal-comms alcove, with a floating orb
  rather than a handset or phone icon. Desks replace monitors with rune
  tablets, crystal orbs, scrying mirrors, magical devices, books, parchment and
  messenger scrolls. The choice stays in this browser. Skins never change room
  identity, geometry, hit boxes or routing.
- **Where things open is yours to pick**: `⚙` (or `,`) in the top row sets
  where web links and files open outside (that session's setting, TWeb on
  your Chrome / Electron / WebKit, the Chrome tab group, the default browser
  or app, Finder) and whether a viewable file opens inside first. A chip's
  right click (or `⇧O` in the viewer) asks once and remembers the pick; kept
  in this browser.
- **The card in tabs, its buttons always in view**: `💬 답변`, `📥 받은 것`,
  `📤 보낸 것`, `📎 파일` (from its outputs; `[` `]` cycle and `⌥1`-`⌥4`
  open one directly). In a resource tab, `↑`/`↓` or `j`/`k` chooses an item
  and `Enter` opens it. The things to press (quick replies, the reply box,
  stop, go, 미루기, next) sit in a foot at the card's bottom; the answer takes
  the space between and scrolls inside it, so it is never hidden under the
  foot. A card under 420px tall folds the foot to a one-line reply box and one
  flow of buttons (`Enter` sends), and a card is at least 340px tall. Drag the card's title to move it and its lower-left corner
  to resize it. Press `M` to maximize/restore, use `⌥`+arrows to change its
  width and height, or `⌥⇧`+arrows to move it; the browser remembers both its
  size and position.
- **Answers read as Markdown**: headings, nested lists, tables, code blocks,
  quotes, rules, `code` and **bold**, with links and brand badges as before.
- **Zoom back**: `0`, a double click or the `⤢ 전체 보기` chip in the top row
  (shown once you have zoomed or panned) glides back to the whole office.
- **tmux sessions are blocks**: each tmux session's windows get their own
  rows with a floor tint and a sign (`🗂 tmux 2 · 16명`), and a long cubicle
  partition (fabric below, frosted glass above) runs between blocks, with
  aisles to walk through.
- **Walls** look like an office: wainscot and a skirting board, windows with
  blinds and a radiator under each (warm in the cold months), a clock by the
  lift and a status board over the library (sessions, working, waiting, who
  is next, the time). The sky in the windows and how far the blinds are down
  follow the local hour.
- **Shared resources**: the model accounts every session draws on hang on a
  board beside the status board (`🔋 공용 자원`; the guild hall's `🔮 마나
  장부`): a lamp per account (●ok ◐ nearly out ⏸ cooldown ✗ expired), a bar
  per quota window (5h, 7d, a pool) going amber under 30% and red under 10%,
  or the cooldown's time left. The header's `🔋` chip carries the lamps and
  each account's lowest percent so it reads without zooming; hovering either
  lists them in full. A dotted bar is the last value seen, not a live one.
  See [Office resources](#office-resources-sources) for where they come from.
- **No mouse needed**: when a card opens the keyboard is already in its
  reply box (TWeb passes keys to a focused text field), so: type, `Enter`
  (`⇧Enter` a new line); in an empty box `1`-`9` press a button; `Tab`/`⇧Tab`
  go to the next/previous agent. Card letters (`G` to its window, `Z`
  미루기, `S` stop, `A` grant, `N`/`P`, `M`) also work with `⌥` from
  anywhere, the reply box included. In a TWeb pane that is the dependable
  form: once Esc leaves the box, TWeb's normal mode takes bare `g` (`gg`),
  `z` (`zi`/`zo`), `x` (close tab), `f`, `j`/`k` before the page sees them, but
  passes `⌥` chords on. Keys go to the topmost layer only: an open menu
  (미루기, where to open) takes digits, `↑`/`↓`, `Enter` and `Esc`, and holds
  the focus so `Esc` closes just the menu; the next `Esc` closes the card.
  Letters match the physical key; under the Korean layout TWeb sends a
  keydown with no key or code and the jamo on the keypress after it, which
  the office reads back through the 두벌식 map. From any other window, tmux `prefix O`
  (`bin/cc-office-next`; `prefix o` is extrakto's) brings the office pane in
  front and opens the next one waiting:
  `bind-key O run-shell -b '~/src/keyolk/cc-mods/bin/cc-office-next'`
- **Long answers**: the card shows the whole last answer (up to 12k chars),
  opened at its end, and scrolls without the mouse: `PgUp`/`PgDn` anywhere
  (the reply box included), `↑`/`↓` in an empty reply box, and outside it
  `j`/`k`, `Space`/`⇧Space`, `Home`/`End`.
- **Keys** (`?` lists them): `1`-`9` press the card's numbered button (a
  dialog option or a quick reply), `R` or `/` the reply box (`⌘Enter` sends,
  `Esc` leaves it), `S` stop, `G` its window, `Esc` close, arrows pan, `+`/`-`
  zoom, `F` fit. They also work with the Korean layout on (`ㅜ` for `N`, …).
- Every POST needs the token the server writes into its page and a local
  `Host`: another site in the browser cannot drive a session through it.

### Office resources: sources

The harness changes (ccproxy today, cco or plain Claude Code tomorrow), so the
office never reads a tool's output in the page. `office/resources.py` holds
*sources*: a command and a parser that turns its output into one shape,

```json
{"source": "ccproxy", "label": "ccproxy", "ok": true,
 "accounts": [{"id": "claude-a", "provider": "anthropic",
               "state": "ok|soon|cooldown|expired|off|unknown",
               "gauges": [{"name": "5h", "left_pct": 71, "reset_at": 1792825200}],
               "note": "spend cap", "stale": false, "until": 1793131200}]}
```

and `/state` carries the list as `resources`. The page (`office/resources.js`)
draws only that shape, and a skin draws it its own way with
`drawResources(ctx, board, items, t)`. A new harness is a new entry in
`SOURCES`; nothing in the page changes.

| source | command | what it gives |
|---|---|---|
| `ccproxy` | `ccproxy status --offline --json` | each account: state, 5h/7d or pool left, cooldown end |
| `cco` | `cco status --once --json` | whether each provider answers (cco reports no per-account quota yet) |

Sources read only local or offline state, never an upstream API: one office
server serves every browser, at most once a minute per source, in the
background so `/state` never waits on one, and a failed read keeps the last
good values marked stale (see the degraded-network investigation). Which run
comes from `~/.config/cc-mods/office.json`:

```json
{"resources": ["ccproxy", "cco"]}
```

Without it every source whose command is installed is tried.

## Organisation (`~/.config/cc-mods/org.json`)

What the mod knows about where it runs is kept outside the repository, in
`~/.config/cc-mods/org.json`. With no file, every feature that needs one of
these values is off and the rest works: no Jira links, no stack labels, no
SSO pre-check or AWS row, no default Slack target, no per-owner gh account.

```json
{
  "slack": { "team": "acme", "defaultTargets": { "C0123ABCD45": "#team-pr-review" } },
  "jira": { "baseUrl": "https://acme.atlassian.net", "projects": ["ABC", "OPS"] },
  "github": { "accounts": { "my-personal-login": "my-personal-login", "acme": "" } },
  "stacks": [
    { "name": "Prod", "prefixes": ["prod-", "cloud-"] },
    { "name": "Edge", "prefixes": ["edge-"] }
  ],
  "awsSsoProfiles": ["cloud", "edge"],
  "awsSsoStartUrl": "https://d-1234567890.awsapps.com/start",
  "argocdDomains": { "tools.acme.io": "", "edge.acme.io": " (edge)" },
  "coderInstances": { "east": "https://coder-east.example.com", "west": "https://coder-west.example.com" },
  "regionFiles": ["~/.acme/regions.yaml"]
}
```

| Key | Used for |
|---|---|
| `slack.team` | building thread links when a Slack tool gives only channel + ts |
| `slack.defaultTargets` | channels a send needs no grant for (shown fixed in Policy) |
| `jira.baseUrl`, `jira.projects` | which `KEY-123` in text are tickets, and their links |
| `github.accounts` | owner → gh login whose token a `gh` call and the PR poller use; `""` or unlisted is gh's active account |
| `stacks` | kubectl context / AWS profile prefixes per stack, for autocomplete labels (first match wins) |
| `awsSsoProfiles` | profile prefixes whose `aws` calls are checked for an expired SSO session first |
| `awsSsoStartUrl` | the IAM Identity Center start URL whose session the Auth tab shows (no AWS row without it) |
| `argocdDomains` | ArgoCD host suffix → label suffix in the Auth tab |
| `coderInstances` | Coder instance label → HTTPS deployment URL; Auth reads Coder's local selected URL/session without periodic network probes and offers `coder login <url>` for a missing session |
| `regionFiles` | region maintenance-window YAML files shown on IaC PR rows |

## Web: a TWeb pane beside (default)

By default (`browserEmbed` off) a page opens in a TWeb pane right of the
session: `/web <url>`, the Web tab's go field and palette picks run
`tmux split-window -h … tweb open --engine <e> <url>`. A TWeb pane already in
the window on the engine the URL wants (engine rules apply) is navigated
instead of splitting again. Links Claude opens reach the same pane through
tmux-chrome (`@cc_web` is not set in this mode).

The tab's first line is the link to TWeb: `● tweb linked` with the supervisor
(`tweb daemon status`: pid, uptime, panes hosted, engine), or `✗ tweb
unreachable` / `✗ tweb not installed` with the error `tweb panes` printed. The
Web entry in the tab row carries the same sign from any tab (● linked, ✗ not,
◐ Claude is driving the browser); off the Web tab it is re-checked at most
once a minute.

The pane says the same to the person at the page (tweb with `tweb link`,
keyolk/tweb#191). While the Web tab knows a pane, the cockpit renews
`tweb link --owner "cc-mods <this pane>" --ttl 90 --pane <id>` (at most every
20 s), and the pane shows `⇄ cc-mods %42` until the link lapses. An agent's
page-changing command shows there as a solid `◐ AGENT <verb>`, from this session
or any other agent; a key or click from the person during it flashes a warning.
The Web tab's second line reports both: whether the pane shows this cockpit as
linked, and `⚠` for a minute after the person acted on a page an agent was
driving. A tweb without `tweb link` is named as one to update.

The Web tab then reports and commands that pane; TWeb's own pane UI draws the
page and owns its keys. It lists the pane's tabs (press one to switch, ✕ to
close, + new tab) and has back, forward, reload, ⌨ focus (alt+w: the keyboard
moves to the pane), ⧉ float / pin, DevTools (Chrome engine) and ✕ close
(kills the pane). Each command is `tweb <command> --pane <id>`. The tab lists
the window's TWeb panes (`tweb panes --json`) at most every 3 s while drawn,
so a pane closed or navigated by hand shows there too. `new pane on` picks the
engine a new pane starts on.

Under the tabs, ▸ console / ▸ network show the pane's latest records
(`tweb console|network --json --pane`, read every 2 s while open; `clear`
empties TWeb's buffer). ▸ automation lists the browser commands agents ran
this session: Bash lines with `tweb <verb>` and tweb MCP tools, each with its
arguments, pane and ✓/✗. While one runs (and 8 s after) the controls row
shows ◐ Claude is driving.

Settings › Web tab on (or `browserEmbed: true`) draws pages inside the Web tab
instead; the next section is about that mode.

## Web keyboard contexts (browserEmbed on)

The header always says who owns the keyboard: **Claude**, **Cockpit** or
**TWeb**. In Web (6), alt+w switches Cockpit controls ⇄ TWeb Page; clicking the
page also enters Page. In Page every key goes to TWeb, Escape included: the
engine handles Escape itself and raises no hook event for it (measured), so
`escape` in `Pane` and `PaneField` is bound to the borrowed action `tabs:next`
that the cockpit's hidden button takes. In Page it sends byte `1b` to TWeb;
elsewhere it does what Esc did (close search/help, else the ring moves to the
element before).

A focused page takes every other key too, alt+w and alt+tab included, so the
way out is caught by tmux as well: while the pane has `@cc_web_page`, alt+w
runs `~/.local/bin/cc-web-leave`, which sends a real Escape to Claude Code
(on a focused page that hands the keyboard back to the cockpit) and tells the
bridge (`POST /leave`), so the header returns to Cockpit; alt+tab does the
same and goes on to Claude's prompt. Elsewhere both pass through.

The same Escape binding also switches macOS to the ABC input source in a
Claude Code pane (`@cc_pane_session`, published by this mod), with
[`macism`](https://github.com/laishulu/macism). With `editorMode: vim` and a
Korean (or any composing) input source, normal-mode keys reach the IME
first: `i` becomes `ㅑ`, held as an unfinished syllable, and vim never sees
it. Leaving insert mode with Escape now leaves the IME on letters too.

```
bind-key -n Escape if-shell -F '#{@cc_web_page}' 'run-shell -b "~/.local/bin/cc-web-esc \"#{@cc_web}\""' { if-shell -F '#{@cc_pane_session}' { run-shell -b '/opt/homebrew/bin/macism com.apple.keylayout.ABC >/dev/null 2>&1' } ; send-keys Escape }
bind-key -n M-w if-shell -F '#{@cc_web_page}' 'run-shell -b "~/.local/bin/cc-web-leave \"#{pane_id}\" \"#{@cc_web}\""' 'send-keys M-w'
bind-key -n M-Tab if-shell -F '#{@cc_web_page}' 'run-shell -b "~/.local/bin/cc-web-leave \"#{pane_id}\" \"#{@cc_web}\" prompt"' 'send-keys M-Tab'
```

TWeb's own `w` (float the page as a desktop window) reaches TWeb only from its
own pane UI; in the Web tab every key goes to the page. The tab has a ⧉ float
button (and a palette entry) that runs TWeb's `float` / `pin` commands. The visible CTRL/PAGE button
does the same switch.

A hooks module cannot focus a `Client` (`$.ui.focus` accepts only
Button/Input/Select). For a terminal **docked** pane, alt+w uses the rendered
Client coordinates to send one synthetic SGR click through tmux; the actual
Client pointer event confirms Page mode. Inline/non-terminal surfaces ask for
one real click instead. If the synthetic click misses, the UI stays in CTRL
and shows a toast rather than claiming TWeb owns keys.

## Watches on Now

The Now tab's In progress card lists every watch this session runs: Monitors
(PR follow-up, Slack threads, anything a Monitor watches, the cockpit's own
held watches) and threads on automatic Slack follow-up. Press a row to select
it; a ■ stop button appears under it. Stop runs TaskStop for a Monitor (the
same tool call the model would make; the cockpit's own TaskStop hook ends a
held watch) and removes the row, or turns auto follow-up off for a thread.
Two presses, so a stray click stops nothing.

## Slack follow-up

A Slack thread in In/Out (pasted, read or posted to) can be followed up with
the `sb:slack-followup` skill. Select the thread: `u` (follow up) starts the
skill on it now; `w` (auto follow-up) turns automatic follow-up on or off for
that thread, shown as ⟳ on its row. With auto on, the cockpit's 3-minute Slack
poll starts the skill once for each new batch of replies from someone else;
what was there when auto was turned on counts as handled, and the same reply
never starts it twice. Mid-turn it waits for the turn to end. The skill shows
any reply for approval before it is sent, so auto never posts on its own. The
palette lists "Follow up <thread>" too. The setting is stored per thread for
this machine.

## MCP auto-reconnect

A server that was in use can drop (a proxy reset, sleep, a server-side session
that expired) and stays dropped until someone reconnects it in /mcp. When an MCP
tool call fails with a connection error (connection closed or reset, not
connected, -32000), the cockpit runs `/mcp reconnect <that server>` as the turn
ends: a hook cannot run a command while it holds the turn. The server name comes
from the credential radar (`claude mcp list`), matched by the engine's tool-name
normalization. One try per server per 2 minutes, three per session. No timer
and no `reconnect all`: servers that never connected (sign-in needed, unused)
are left alone, and nothing runs while idle. Settings › Cockpit › MCP turns it
off.

## Settings (8)

Where links Claude opens go (inherit / TWeb / TWeb on Chrome / Chrome tab group,
with what tmux-chrome resolves now and `$BROWSER`), whether TWeb pages draw in
the Web tab, the Web tab's engine/device/fps, whether the cockpit opens at start
(stored for this machine, over the `cockpitOnStart` option), routing (auto
effort/model) and the keys.

**Slash candidates.** Claude Code draws `/command` candidates across the whole
terminal, over a docked cockpit, and exposes no render hook or width setting
for that list. By default the cockpit closes while the prompt edits its first
slash token (`/`, `/side`, …), then reopens on the same tab without taking the
keyboard when the token ends (space), is deleted, changed by history/fill/undo,
or submitted. Settings › Cockpit › slash list turns this off for this machine.

**Engine by URL.** Under Web tab › by URL, a page whose URL matches a rule opens
on that rule's engine: `claude.ai chrome` puts claude.ai and its subdomains on
Chrome, where the login and device trust are. A pattern is a host (`*` matches
any run of characters, `*.okta.com`) with an optional path prefix
(`github.com/acme`); the first match wins, and no match keeps the engine
above. It applies to `/web <url>`, the go field and links sent to the tab; a
page that lands on a matching URL later (a redirect, a clicked link) reopens on
that engine. An engine asked for by name (`/web --electron …`, the engine row)
wins for that page. The list is stored for this machine; until it is edited
there it comes from the `browserEngineRules` option (`claude.ai=chrome` by
default, comma separated).

## auto_continue: "shall I go on?" answered for you

`/policy allow auto` (or the `autopilot` / `release` modes) turns it on. Two
layers:

1. The system prompt's policy section tells Claude to do a clear, safe next
   step instead of ending with "shall I…?".
2. A turn that still ends on such a question is answered for the person.
   The Jev call that already sorts each turn into ask/action/none
   (`bin/cc-bridge.py attention`) gets a fourth option, `proceed`: the
   answer only asks whether to go on with a step it named, nothing to choose,
   nothing only the person knows, and the step stays on this machine. At
   confidence 0.6 or more the cockpit waits 3 s, then sends
   `네, 진행해 주세요.` in the person's place. Typing in those 3 s cancels it.

A merge, push, send, deploy, delete, shared-service restart or anything prod
is never `proceed`: Jev reads it as `ask`, and the policy guards still gate
the ones they cover. After 3 answers in a row without the person typing, the
next question is left for them. Each answer is a `decision` row in Chat.

## Slack sends in session policy

`slack_send` is a session-policy capability (`~/.claude/hooks/session_policy.py`,
read by `slack_send_guard.py` on every Slack send). The team review channel
always goes without asking; scoped targets (channel or DM ids) too; `allow` lets
any target go; `block` denies all but the review channel; `inherit` asks, as
before. `/policy allow slack #channel` or `/policy allow slack @person` (or the
Policy tab's field) looks the name up through the Slack MCP server and stores the
id. The Policy tab's **Allowed targets** lists, per capability, what is allowed
(✓, ✕ removes it) and what this session looks like it needs (+ allows it):
blocked commands, prod contexts used, PR and cwd repos, Slack threads touched and
Slack targets sent to.

## Arrow keys

Up and down move the focus to the row above or below by layout, keeping the
column (Policy: merge `block` → prod `block`); with nothing that way they
scroll the body. Left and right keep the engine's previous/next. The engine
only turns an arrow into `ui.scroll` while it has rows to scroll, so the
frame draws a spacer row above and below and the cockpit pins the engine's
offset at 1; `lib/nav.ts` estimates where each element sits from the tree.
(A Button `action` cannot catch plain arrows: actions press on chords and
modified keys only.)

## Key help

alt+/ (the `?` key with alt) in the cockpit lists every key it answers: the ones that work anywhere
(alt+c, alt+s), the cockpit's own (tabs, moving, Esc, width, close), the open
tab's letter keys as that tab draws them, the search keys and the slash
commands. Esc, Enter or alt+/ again closes it. A bare `?` cannot open it: a
Button hotkey takes only a-z and 0-9, and an action Button presses only on a
chord or a modified key, so a bare `?` falls through to the prompt and opens
Claude Code's own help. alt+/ borrows an action no cockpit screen handles:

```json
{ "context": "Pane", "bindings": { "alt+/": "agents:find" } },
{ "context": "PaneField", "bindings": { "alt+/": "agents:find" } }
```

## Palette

Slack threads this session touched (a permalink in your prompt, an answer or a
tool result, and threads the Slack tools read or posted to) are one entry per
thread under Outputs › Slack (`s`), and the palette opens them (type `slack`).
Each is re-read every 3 minutes through the connected Slack MCP server: it
shows the channel name and, when someone else replied since you last looked,
`N new · <who>` in Outputs and a row in the Now tab's Needs you (plus a toast).
Looking means: the first time it is tracked, Claude reading or replying to it,
your own reply, or opening it from the cockpit.

Closed until asked for. `k`, or `alt+s` from anywhere in the cockpit (its
query field included), opens a search over every setting and action; `alt+s`
again closes it. A session starts with it closed. The chord reaches a hidden
Button through an engine action no cockpit screen handles:

```json
{ "context": "Pane", "bindings": { "alt+s": "settings:search" } },
{ "context": "PaneField", "bindings": { "alt+s": "settings:search" } },
{ "context": "Global", "bindings": { "alt+s": "settings:search" } }
```

(also in `AbovePrompt` and `AbovePromptInput`). It searches tabs, policy capabilities, routing, where links open, the Web
tab's engine/device/frame rate/DevTools, and cockpit commands. Typing filters
(fuzzy, by title and keywords), Enter runs the first match, a click runs any.
Several words match each on its own, in any order (`side question`, `chat decisions`).
It also lists places inside tabs — the side question field, each In/Out list
(PRs, Jira, Slack, …) and Inputs, the Chat filters, the Policy target field —
and a pick that goes somewhere puts the keyboard there: `alt+c alt+s side
question Enter` leaves you typing the side question.

Routine Monitor events (checks pending/passing, pushes, comments) take no
rows in the transcript: their status is in the cockpit, and while it is closed
one band row (`▎watch ⟳ … · /cockpit`). An event that matters (failing,
conflict, merged, changes requested) or a turn that wrote or asks stays (`❗ watch · …`).

```
/cockpit   home
/watch     Monitor events: which folded, which showed
/flow  /graph  /side [question]  /outputs [pr|artifact|scratch|ticket|link|bg|exp]
/policy [allow|block|inherit <cap> [scope] [15m] | mode <m> | clear]
/auth      refresh the credential radar and print it
/title [label]   label this pane in tmux (empty clears)
/yank [n]  copy the last (or n-th last) answer to the clipboard and a tmux buffer
/fold      fold finished tool calls to one line (/focus is a built-in)
```

Policy short names: `merge` `prod` `prod-w` `auto` `tmux`.

## Install the tools it calls

The cockpit shells out to three binaries. Each publishes prebuilt binaries
for macOS and Linux (amd64, arm64) on a `v*` tag, so nobody needs the Rust or
Go toolchain to set cc-mods up:

| Tool | Repo | Used by |
|---|---|---|
| `tweb` (+ `twebd`, `tweb-webkit`, `tweb-native-input`) | keyolk/tweb | Web tab, `/browser`, browserEmbed |
| `narwhal` | keyolk/narwhal | Needs you / Work: narwhal runs |
| `ccproxy` | sendbird/ccproxy (internal) | Usage tab |

```bash
bin/cc-mods-tools status          # installed / local build / latest release
bin/cc-mods-tools install         # the missing ones, into ~/.local/bin
bin/cc-mods-tools update          # move the ones it installed to the latest release
bin/cc-mods-tools update narwhal --force   # also replace a local `make install` build
```

The list is `tools.json`. Each archive is checked against the release's
`checksums.txt` / `SHA256SUMS`, re-signed ad hoc on macOS, and moved into place
with a rename (never copied over a running binary). What it installed is
recorded in `~/.local/state/cc-mods/tools.json` by sha256; a binary there that
does not match, such as your own `make install`, is a local build and is left
alone unless `--force`. Tokens come from `gh auth token`, picked per owner from
`org.json` `github.accounts` as the mod does; `sendbird/ccproxy` needs a gh
login that can read sendbird repos. `tmux-chrome` is scripts plus a Chrome
extension and is still installed from its repo (`install.sh`).

A tool reaches users only when it is tagged: bump, merge, tag the merge commit
(`ccproxy` also requires `internal/buildinfo/VERSION` to match the tag).

## Load it

```bash
claude --plugin-dir /path/to/cc-mods          # one session
```

For every session, add to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-mods" } }
```

then retire the settings hooks it replaces, so nothing fires twice
(observed: fork offered by both):

```bash
bin/cc-mods-migrate status    # what would move, and whether mods can load
bin/cc-mods-migrate apply     # refuses while the hooks-modules rollout is off
bin/cc-mods-migrate revert    # put them back
```

The guards (`secret_read_guard`, `kubectl_context_guard`, `session_policy.py
guard`, …) stay. The policy guard is a second line behind the mod and blocks
self-grants on its own too.

## Rollout gate

Claude Code gates installed and `--plugin-dir` mods behind a server flag. When
it is cached off, the debug log says
`hooks module cc-mods@inline not loaded: … rollout switch was saved off` and
`claude plugin test` refuses to run. The mod was verified live in a session
started before the flag turned off (see *Verified*); do not edit
`~/.claude.json` to force it.

## Develop

```bash
bun install
bun run check        # tsc + claude plugin validate + eslint
bun run test:lib     # pure functions, runs anywhere (bun, with a shim for claude-code/testing)
claude plugin test   # engine-backed tests in tests/mod.test.ts (needs the rollout on)
```

Layout: `hooks/register.ts` wires events and owns every `$` call (validation
only allows `$` in top-level functions of the module file); `hooks/lib/*` and
`hooks/views/*` are pure and unit-tested; `types/index.d.ts` declares `$.state`.

## Verified (2026-10-13, live session, 2.1.296)

- `1 mod active · cc-mods`, 16 hooks, hot reload on save
- `/policy` pane rendered; `/policy allow merge owner/repo 2m` wrote the
  policy file through `session_policy.py`; footer `merge(1)`
- Claude asked to run `session_policy.py allow gh_merge`: refused, file unchanged
- tmux: `@cc_state working→waiting`, `@cc_attention action` (Jev), `@cc_ctx 9`,
  `@cc_policy 1`, `@cc_auth expired`, `@cc_agents 1` while Explore ran,
  `@cc_attention ask` the moment AskUserQuestion drew
- `/flow`, `/graph` (Explore ✅ 6s 424 tok 2 tools, bg task), `/outputs`
  (ticket, scratch, bg) rendered from a real multi-tool turn
- band: auth items, fork offer at p=0.79

Found and fixed during that run: injected `<task-notification>` /
`<agent-message>` turns counted as requests; bg nodes never closed; question
answered left the window at ❓; MCP needs-auth entries (unused connectors) kept
the band red; outputs tab row overflowed.

Not yet verified live (rollout turned off mid-test): the fixes above, the PR
band against a real PR, autocomplete rows, `/side` answers, image preview.

## Monitor events stay out of the flow

A Monitor (a PR follow-up polling every 30s) wakes the session for every
event, and each wake used to print a check-in turn into the transcript. Now:

- The model still reads every event. Only the drawing changes.
- An event that says something (checks failing, conflict, merged, changes
  requested, unresolved threads) is shown as before and gets a flow entry.
- A routine event (checks pending/passing, merge blocked, a push, new
  comments) folds to two muted lines: `⟳ <watch> · <what changed>` and
  `↳ <first line of the answer>`. Its tool calls are hidden.
- A routine event whose turn wrote something (git push, a PR comment, an
  edit, a question for you) unfolds when the turn ends.
- ctrl+o shows the full rows. The Watch section (Work tab) counts what was folded.

## Routing: Jev picks the effort

`/route on` (or the Routing toggles in the Policy tab) lets Jev pick each
turn's effort from the person's prompt: low, medium, high or xhigh. cc-bridge
`route` asks while the engine builds the request (~0.85s), and `turn.step`
rewrites the main steps' effort when Jev is at least 75% sure; otherwise, or
after 1.5s with no answer, the session's own setting stands. Subagents are left
as they are. `/route model on` also sends light work to Sonnet — a model switch
re-caches the whole context, so it is off by default. The setting is shared by
every session (store key `route`).

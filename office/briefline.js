// The briefs in the command view (지휘), always in reach: one line under the
// task box (the newest five as chips, 전체 to the line with every recent
// one; b, ⌥B, walks them), and a picked session's newest brief over both its
// looks. The list of recent briefs under the table is gone: the line is it.
// Loaded before command.js, which calls these.

const BRIEF_CSS = `
/* One line, whatever the width: 전체 first, then the chips, scrolling sideways. */
#command .briefs { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; padding: 5px 12px; border-bottom: 2px solid rgba(59,42,53,.14); background: #fffaf0; overflow-x: auto; scrollbar-width: none; }
#command .briefs > * { flex: 0 0 auto; }
#command .briefs .bchip { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid rgba(59,42,53,.35); border-radius: 999px; background: #fff; padding: 0 8px; cursor: pointer; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#command .briefs .bchip.sel { border-color: #2a2033; background: #fff3c4; }
#command .briefs .bchip.all { background: #fffaf0; border-style: dashed; }
#command .sbrief { padding: 4px 12px; border-bottom: 1px dashed rgba(59,42,53,.18); background: #fffaf0; }
#command .sbrief:empty { display: none; }
#command .briefb { font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; border: 2px solid var(--line); border-radius: 999px; background: #fff3c4; padding: 0 8px; margin-top: 3px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: BRIEF_CSS }))

// The brief line under the box: the newest briefs (/command's recent, newest
// first), a chip each, and 전체, which puts every recent one on the line
// (and takes them off again).
const BRIEF_CHIPS = 5
const briefLine = { all: false }
const cmdBriefs = () => (cmd.data?.recent || []).slice(0, briefLine.all ? undefined : BRIEF_CHIPS)
function cmdRenderBriefs() {
  const el = cmdEl.querySelector('.briefs')
  if (!el) return
  const all = cmd.data?.recent || [], bs = cmdBriefs(), left = el.scrollLeft, sel = cmd.sel?.path || ''
  el.innerHTML = '<span class="m" title="b · TWeb에서는 ⌥B로 차례로 열기">📄 브리프 <span class="key">B</span></span>'
    + (bs.length ? (all.length > BRIEF_CHIPS ? '<button class="bchip all" data-all="1" title="' + (briefLine.all ? '최근 ' + BRIEF_CHIPS + '개만' : '최근 브리프 모두 이 줄에') + '">' + (briefLine.all ? '접기' : '전체 ' + all.length) + '</button>' : '')
      + bs.map((b) => '<button class="bchip' + (sel === b.path ? ' sel' : '') + '" data-brief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.title + ' · ' + b.file) + '">' + (b.pending ? '⏳ ' : '') + cmdEsc(b.title) + '</button>').join('') : '<span class="m">없음</span>')
  // The 3 s redraw keeps where the line was scrolled; a newly picked chip
  // comes into view, and anything else picked brings back its start (전체).
  el.scrollLeft = left
  const on = el.querySelector('.bchip.sel')
  if (el.dataset.sel !== sel) el.scrollLeft = on ? Math.max(0, on.offsetLeft - el.clientWidth + on.offsetWidth + 12) : 0
  el.dataset.sel = sel
}

function cmdBriefClick(ev) {
  const b = ev.target.closest('button')
  if (!b) return
  if (b.dataset.all) { briefLine.all = !briefLine.all; cmdRenderBriefs(); return }
  cmdPick({ file: b.dataset.brief.split('/').pop(), path: b.dataset.brief, title: b.dataset.title })
  cmdRender()
}

// b (⌥B, ⇧ backwards): the next brief of the line opens where a brief does;
// from anything else, the newest. No brief: the key is the floor's.
function cmdBriefWalk(e) {
  const bs = cmdBriefs()
  if (!bs.length) return false
  e.preventDefault()
  const at = bs.findIndex((b) => cmd.sel && cmd.sel.path === b.path), d = e.shiftKey ? -1 : 1
  const b = bs[at < 0 ? (d > 0 ? 0 : bs.length - 1) : (at + d + bs.length) % bs.length]
  cmdPick({ file: b.path.split('/').pop(), path: b.path, title: b.title })
  cmdRender()
  return true
}

// The newest brief a picked session is recorded on: what it asks says it
// (/command?sid=), else its row in the table.
function cmdSessionBrief(sid) {
  if (cmd.ask && cmd.ask.sid === sid && cmd.ask.brief) return cmd.ask.brief
  return cmdWorkers().find((x) => x.w.sid === sid)?.w.brief || null
}

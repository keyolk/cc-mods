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
#command .donefoot { margin-top: 10px; border-top: 2px dashed rgba(59,42,53,.18); padding-top: 6px; }
#command .donefoot h3 { margin: 0 0 4px; }
#command .donefoot .dn { border: 2px solid #8fbf8f; border-radius: 10px; background: #f1faf1; padding: 5px 8px; margin-bottom: 5px; font: 12px/1.45 -apple-system, "Apple SD Gothic Neo", sans-serif; }
#command .donefoot .dn.sel { border-color: #2a2033; }
#command .donefoot .dn .t { font-size: 13px; cursor: pointer; }
#command .donefoot .dn .r { margin: 2px 0; }
#command .donefoot .dn a { word-break: break-all; margin-right: 8px; }
#command .donefoot .dn button { font: inherit; font-size: 11px; border: 2px solid var(--line); border-radius: 999px; background: #fff; padding: 0 8px; cursor: pointer; }
#command .donefoot .fold { cursor: pointer; color: #7a7090; font-size: 12px; }
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
      + bs.map((b) => '<button class="bchip' + (sel === b.path ? ' sel' : '') + '" data-brief="' + cmdEsc(b.path) + '" data-title="' + cmdEsc(b.title) + '" title="' + cmdEsc(b.title + ' · ' + b.file) + '">' + (b.done ? '✅ ' : b.pending ? '⏳ ' : '') + cmdEsc(b.title) + '</button>').join('') : '<span class="m">없음</span>')
  // The 3 s redraw keeps where the line was scrolled; a newly picked chip
  // comes into view, and anything else picked brings back its start (전체).
  el.scrollLeft = left
  const on = el.querySelector('.bchip.sel')
  if (el.dataset.sel !== sel) el.scrollLeft = on ? Math.max(0, on.offsetLeft - el.clientWidth + on.offsetWidth + 12) : 0
  el.dataset.sel = sel
}

// ✅ 최근 완료 under the table: briefs marked done (`brief done`; /command's
// `done`, newest first): the result in one line, its links, and the command
// that undoes it, one press to copy. One done more than a day ago (`old`)
// is folded; a brief only answered is not here (it has no ✅ on its chip).
const briefDone = { open: false }
const cmdDone = () => cmd.data?.done || []
function doneFoot() {
  const all = cmdDone()
  if (!all.length) return ''
  const fresh = all.filter((d) => !d.old), old = all.filter((d) => d.old), sel = cmd.sel?.path || ''
  const row = (d) => '<div class="dn' + (sel === d.path ? ' sel' : '') + '"><div class="t" data-dbrief="' + cmdEsc(d.path) + '" data-title="' + cmdEsc(d.title) + '" title="브리프 열기">✅ ' + cmdEsc(d.title) + ' <span class="m">' + cmdEsc(cmdAgo(d.at)) + (d.by ? ' · ' + cmdEsc(d.by) : '') + '</span></div>'
    + '<div class="r">' + cmdEsc(d.result) + '</div>'
    + ((d.links || []).length || d.revert ? '<div>' + (d.links || []).map((l) => '<a href="#" data-dlink="' + cmdEsc(l) + '">' + cmdEsc(l.replace(/^https?:\/\//, '')) + '</a>').join('') + (d.revert ? '<button data-drevert="' + cmdEsc(d.revert) + '" title="' + cmdEsc(d.revert) + '">↩ 되돌리기 명령 복사</button>' : '') + '</div>' : '')
    + '</div>'
  return '<div class="donefoot"><h3>✅ 최근 완료 <span class="m">' + all.length + '건 · 답을 실행하고 결과를 확인한 브리프</span></h3>'
    + fresh.map(row).join('')
    + (old.length ? '<div class="fold" data-dfold="1">' + (briefDone.open ? '▾' : '▸') + ' 24시간 지난 완료 ' + old.length + '</div>' + (briefDone.open ? old.map(row).join('') : '') : '')
    + '</div>'
}

// A click in the list on one of the ✅ rows; false when it was not one.
function doneClick(ev) {
  const t = ev.target
  const f = t.closest('[data-dfold]')
  if (f) { briefDone.open = !briefDone.open; cmdRender(); return true }
  const r = t.closest('[data-drevert]')
  if (r) { authCopy(r.dataset.drevert).then((ok) => toast(ok ? '↩ 되돌리기 명령을 복사했습니다' : '복사하지 못했습니다')); return true }
  const l = t.closest('a[data-dlink]')
  if (l) {
    ev.preventDefault()
    const v = l.dataset.dlink
    if (/(^|\/)briefs\/\d{4}-\d{2}-\d{2}-[\w.-]+\.html$/.test(v)) { cmdPick({ file: v.split('/').pop(), path: v, title: v.split('/').pop() }); cmdRender() }
    else window.open(v, '_blank', 'noopener')
    return true
  }
  const b = t.closest('[data-dbrief]')
  if (b) { cmdPick({ file: b.dataset.dbrief.split('/').pop(), path: b.dataset.dbrief, title: b.dataset.title }); cmdRender(); return true }
  return false
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

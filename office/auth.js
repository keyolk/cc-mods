// cc-mods' credential radar in the office (the 🔑 chip and its panel), the
// same for every session: what needs a login first, then what is fine, then
// the org's claude.ai connectors without one folded behind a count (Claude
// Code lists every one it offers, used or not).
//
// The office never runs a fix itself. A press on a row that needs one hands
// it to a live session (office.py auth_handoff: /state's authTo names it),
// whose cockpit runs it as its own press would and shows how it went. With no
// such session, or for a /mcp row (it logs in to one session's connection),
// the press copies the fix instead. Either way the panel says so, where the
// eye already is: the page's toast (#hint) sits under it, at the same corner.
// Uses office.html's esc, clock and toast.

const AUTH_MARK = { expired: '⛔', soon: '⏳', unknown: '❔', ok: '✅' }

// What a press on a row does: { run, copy, where, to } when a session takes
// the fix (`to`, /state's authTo), { copy, where } for a fix to paste, { how }
// for a row that needs a login but has none to paste, null for a fine one.
function authAction(i, to) {
  if (!i || i.state === 'ok') return null
  if (i.fix && to && i.id && !i.fix.startsWith('/')) return { run: i.id, copy: i.fix, where: '터미널', to }
  if (i.fix) return { copy: i.fix, where: i.fix.startsWith('/') ? '아무 세션 프롬프트' : '터미널' }
  return { how: '아무 세션에서나 /auth로 다시 확인' }
}

function authHtml(a, said, to) {
  const row = (i) => {
    const act = authAction(i, to)
    const kind = act ? (act.run ? 'run' : act.copy ? 'copy' : 'how') : ''
    const title = act ? (act.run ? '누르면 ' + act.to.name + ' 세션이 로그인을 시작합니다' : act.copy ? '누르면 명령을 복사합니다' : act.how) : ''
    const press = act ? ' tabindex="0" title="' + esc(title) + '" data-act="' + kind + '"' + (act.run ? ' data-id="' + esc(act.run) + '" data-to="' + esc(act.to.name) + '"' : '') + (act.copy ? ' data-fix="' + esc(act.copy) + '" data-where="' + esc(act.where) + '"' : ' data-how="' + esc(act.how) + '"') : ''
    return '<div class="r' + (act ? ' act' : '') + '"' + press + '>' + (AUTH_MARK[i.state] || '❔') + ' <b>' + esc(i.label) + '</b>' + (i.mine ? ' <span class="m">(직접 설정)</span>' : '')
      + (act && act.run ? ' <span class="go">▶ 로그인</span>' : act && act.copy ? ' <span class="go">📋 복사</span>' : '')
      + '<div class="m">' + esc(i.detail) + (i.expiresAt ? ' · 만료 ' + esc(clock(i.expiresAt)) : '') + '</div>' + (act && act.copy ? '<div class="m">고치려면 <code>' + esc(act.copy) + '</code></div>' : '') + '</div>'
  }
  const bad = a.items.filter((i) => i.state !== 'ok' && !i.connector), ok = a.items.filter((i) => i.state === 'ok'), idle = a.items.filter((i) => i.state !== 'ok' && i.connector)
  return '<div class="h">🔑 인증 · 모든 세션 공통 <span class="m">K · Esc</span></div>'
    + (said ? '<div class="said">' + esc(said) + '</div>' : '')
    + (bad.length ? '<div class="h">⚠ 로그인이 필요한 것 ' + bad.length + ' <span class="m">' + (to ? '누르면 ' + esc(to.name) + ' 세션이 로그인 시작' : '누르면 명령 복사') + '</span></div>' + bad.map(row).join('') : '<div class="h">✅ 로그인이 필요한 것이 없습니다</div>')
    + (ok.length ? '<div class="h">✅ 정상 ' + ok.length + '</div>' + ok.map(row).join('') : '')
    + (idle.length ? '<details' + (authFold.open ? ' open' : '') + '><summary class="m">claude.ai 커넥터 ' + idle.length + '개는 로그인 안 됨 (쓰지 않으면 괜찮음)</summary>' + idle.map(row).join('') + '</details>' : '')
    + '<div class="m">' + (a.at ? esc(clock(a.at)) + '에 확인 · ' : '') + '로그인은 아무 세션에서나 /auth</div>'
}

// The connectors' fold, kept across a redraw (a new radar result).
const authFold = { open: false }

// The panel is drawn again only when what it shows changed. /state polls
// every few seconds; a rewrite on each one dropped the click that straddled
// it, the text selected in a <code>, and the open fold.
function authPaint(el, html) {
  if (el.dataset.html === html) return false
  el.innerHTML = html
  el.dataset.html = html
  return true
}

// navigator.clipboard where the page may use it, else the old copy command
// through a hidden box. Resolves true when the text was copied.
async function authCopy(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* not allowed here: try the old way */ }
  try {
    const t = document.createElement('textarea')
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'
    document.body.appendChild(t); t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return !!ok
  } catch { return false }
}

// One listener on the panel, which outlives its rows. Returns the line to
// show at the panel's top, or null when the press was not on a row. `send`
// posts the row's id (office.html authSend) and resolves to the session that
// took it, or null: then the press copies the fix, as with no session.
async function authPress(ev, send) {
  const r = ev.target.closest && ev.target.closest('[data-act]')
  if (!r) return null
  if (r.dataset.act === 'how') return '❔ ' + r.dataset.how
  if (r.dataset.act === 'run' && send) {
    const to = await send(r.dataset.id)
    if (to) return '▶ 로그인 시작: ' + to.name + ' · 진행과 결과는 그 세션 화면에 뜹니다'
  }
  const ok = await authCopy(r.dataset.fix)
  return ok ? '📋 복사했습니다 · ' + r.dataset.where + '에 붙여 넣으세요: ' + r.dataset.fix : '⚠ 복사하지 못했습니다 · 직접 입력하세요: ' + r.dataset.fix
}

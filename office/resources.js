// Shared resources: the accounts and quotas every session draws on, on a board
// on the left wall beside the status board.
//
// The page knows one shape only (office/resources.py): sources, each with
// accounts, each with a state and gauges. Which harness filled it (ccproxy,
// cco, plain Claude Code) does not matter here, so a new harness needs no
// change in this file. A skin draws it its own way by defining
// drawResources(ctx, board, items, t); without one, this default board does.

const RES_STATE = {
  ok: { color: '#6fdc8c', mark: '●', ko: '사용 가능' },
  soon: { color: '#ffcf5a', mark: '◐', ko: '거의 소진' },
  cooldown: { color: '#9aa3b5', mark: '⏸', ko: '쿨다운' },
  expired: { color: '#ff6b6b', mark: '✗', ko: '만료' },
  off: { color: '#6b6f7d', mark: '○', ko: '꺼짐' },
  unknown: { color: '#b9c0cf', mark: '?', ko: '알 수 없음' },
}
// Left fill of a gauge: green, then amber under 30%, red under 10%.
const gaugeColor = (pct) => (pct <= 10 ? '#ff6b6b' : pct <= 30 ? '#ffcf5a' : '#6fdc8c')

// Time left to a unix second, short: 3h12m, 2d4h, 45m.
function resLeft(until, now = Date.now() / 1000) {
  let s = Math.max(0, Math.round(until - now))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  return d ? d + 'd' + (h ? h + 'h' : '') : h ? h + 'h' + (m ? m + 'm' : '') : m + 'm'
}

// Flat list of rows to draw: a header per source, then its accounts.
function resRows(items) {
  const rows = []
  for (const src of items || []) {
    rows.push({ head: true, src })
    for (const a of src.accounts || []) rows.push({ head: false, src, a })
  }
  return rows
}

// One line for an account, for the board and the tooltip alike.
function resLine(a) {
  const g = (a.gauges || []).map((x) => x.name + ' ' + x.left_pct + '%').join(' · ')
  const tail = a.state === 'cooldown' && a.until ? '⏸ ' + resLeft(a.until) : g || a.note || RES_STATE[a.state]?.ko || ''
  return tail
}

// Tooltip HTML for the board.
function resTip(items) {
  if (!items || !items.length) return '<div class="t">🔋 공용 자원</div><div class="m">읽을 수 있는 자원 정보가 없습니다 (~/.config/cc-mods/office.json의 resources)</div>'
  const out = ['<div class="t">🔋 공용 자원</div>']
  for (const src of items) {
    out.push('<div class="m" style="margin-top:4px">' + esc(src.label) + (src.ok ? '' : ' · 읽기 실패' + (src.error ? ': ' + esc(src.error) : '')) + '</div>')
    for (const a of src.accounts || []) {
      const st = RES_STATE[a.state] || RES_STATE.unknown
      const line = resLine(a), extra = [a.note && !line.includes(a.note) ? a.note : '', a.stale ? '마지막으로 본 값' : ''].filter(Boolean).join(' · ')
      out.push('<div><span style="color:' + st.color + '">' + st.mark + '</span> ' + esc(a.id) + ' — ' + esc(line) + (extra ? ' <span class="m">(' + esc(extra) + ')</span>' : '') + '</div>')
    }
  }
  return out.join('')
}

// The default board: a dark panel on the left wall. Its face is laid out flat
// on an offscreen canvas (rows of text and bars line up there, which wall text
// drawn piece by piece in the iso projection did not), then mapped onto the
// wall quad with one affine transform.
const RES_FACE = document.createElement('canvas')
const RES_FACE_W = 460, RES_FACE_H = 270, RES_FACE_K = 2
RES_FACE.width = RES_FACE_W * RES_FACE_K; RES_FACE.height = RES_FACE_H * RES_FACE_K
function drawResourceFace(items, t, theme = {}) {
  const q = RES_FACE.getContext('2d'), W = RES_FACE_W, H = RES_FACE_H
  const bg = theme.bg || '#26323f', ink = theme.ink || '#e6eef8', dim = theme.dim || '#9aa3b5', font = theme.font || 'Jua, sans-serif'
  q.setTransform(RES_FACE_K, 0, 0, RES_FACE_K, 0, 0)
  q.fillStyle = bg; q.fillRect(0, 0, W, H)
  q.textBaseline = 'middle'
  q.font = 'bold 22px ' + font; q.fillStyle = theme.title || '#fff8e6'; q.textAlign = 'left'; q.fillText(theme.heading || '🔋 공용 자원', 14, 22)
  const rows = resRows(items)
  if (!rows.length) { q.font = '16px ' + font; q.fillStyle = dim; q.fillText('정보 없음', 14, 60); return }
  // Rows share what is left of the face; a long list gets smaller rows.
  const top = 46, step = Math.min(24, (H - top - 52) / rows.length), fs = Math.max(9, Math.min(16, step * 0.62))
  rows.forEach((r, i) => {
    const y = top + i * step + step / 2
    if (r.head) {
      q.font = 'bold ' + (fs * 0.85) + 'px ' + font; q.fillStyle = r.src.ok ? dim : '#ffb36b'; q.textAlign = 'left'
      q.fillText(r.src.label + (r.src.ok ? '' : ' ⚠ ' + (r.src.error || '')).slice(0, 40), 14, y)
      return
    }
    const a = r.a, st = RES_STATE[a.state] || RES_STATE.unknown
    const blink = a.state === 'expired' || a.state === 'soon' ? 0.55 + Math.abs(Math.sin(t * 3)) * 0.45 : 1
    q.globalAlpha = blink; q.fillStyle = st.color; q.beginPath(); q.arc(24, y, fs * 0.32, 0, Math.PI * 2); q.fill(); q.globalAlpha = 1
    q.font = fs + 'px ' + font; q.fillStyle = a.stale ? dim : ink; q.textAlign = 'left'
    const name = a.id.length > 17 ? a.id.slice(0, 16) + '…' : a.id
    q.fillText(name, 36, y)
    // The right part: a bar per gauge, or the cooldown / note text.
    const x0 = 186, x1 = W - 12, gs = a.gauges || []
    if (gs.length && a.state !== 'cooldown') {
      const gap = 6, w = (x1 - x0 - gap * (gs.length - 1)) / gs.length, bh = Math.min(fs * 1.05, step - 4)
      gs.forEach((gg, k) => {
        const bx = x0 + k * (w + gap), pct = Math.max(0, Math.min(100, gg.left_pct))
        q.fillStyle = '#141b24'; q.fillRect(bx, y - bh / 2, w, bh)
        q.fillStyle = gaugeColor(pct); q.fillRect(bx, y - bh / 2, w * pct / 100, bh)
        if (a.stale) { q.setLineDash([3, 2]); q.strokeStyle = 'rgba(255,255,255,.45)'; q.lineWidth = 1; q.strokeRect(bx + 0.5, y - bh / 2 + 0.5, w - 1, bh - 1); q.setLineDash([]) }
        q.font = 'bold ' + (fs * 0.72) + 'px ' + font; q.textAlign = 'center'
        q.fillStyle = pct > 45 ? '#0d1218' : '#f2f5fa'; q.fillText(gg.name + ' ' + pct + '%', bx + w / 2, y + 0.5)
      })
    } else {
      q.font = (fs * 0.85) + 'px ' + font; q.fillStyle = st.color; q.textAlign = 'right'
      q.fillText(resLine(a).slice(0, 24), x1, y)
    }
  })
}
function drawResourceBoard(ctx, board, items, t, theme) {
  const { g, poly, leftQuad, P } = ctx
  const { y0, y1, z0, z1 } = board
  poly(leftQuad(y0 - 0.06, y1 + 0.06, z0 - 3, z1 + 3), (theme && theme.frame) || '#8a6a52')
  drawResourceFace(items, t, theme)
  // On the left wall the face reads toward -y: its left edge is y1.
  const [ox, oy] = P(-0.3, y1, z1), [rx, ry] = P(-0.3, y0, z1), [bx, by] = P(-0.3, y1, z0)
  g.save(); g.transform((rx - ox) / RES_FACE.width, (ry - oy) / RES_FACE.width, (bx - ox) / RES_FACE.height, (by - oy) / RES_FACE.height, ox, oy)
  g.imageSmoothingEnabled = true; g.drawImage(RES_FACE, 0, 0); g.restore()
}

// The header chip: a lamp per account and, for one with gauges, the lowest
// one's percent, so the state reads without zooming to the wall. Hidden when
// no source answered.
function resChipHtml(items) {
  const parts = []
  for (const src of items || []) for (const a of src.accounts || []) {
    const st = RES_STATE[a.state] || RES_STATE.unknown
    const low = (a.gauges || []).reduce((m, x) => Math.min(m, x.left_pct), 101)
    const val = a.state === 'cooldown' ? '' : low <= 100 ? low : ''
    parts.push('<span style="color:' + st.color + '" title="' + esc(src.label + ' ' + a.id) + '">' + st.mark + '</span>' + (val !== '' ? '<b style="color:' + gaugeColor(low) + '">' + val + '</b>' : ''))
  }
  return parts.length ? '🔋 ' + parts.join(' ') : ''
}

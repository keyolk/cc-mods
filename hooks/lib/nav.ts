// Arrow-key navigation over a drawn cockpit tree. The engine moves a pane's
// focus ring in one line (previous/next), so on a screen laid out in rows and
// columns (the Policy tab's capability rows) "down" landed on the element to
// the right. This estimates where each focusable element sits, from the same
// tree the hook returns, and picks the one above, below, left or right.
// Pure: register.ts moves the ring with $.ui.focus.

// `hidden`: drawn under display none (the letter catchers). Kept for the ring
// order (skipHidden), never a target.
export type NavItem = { key: string; x: number; y: number; w: number; h?: number; hidden?: boolean; client?: boolean }

const FOCUSABLE = new Set(['Button', 'Input', 'Select'])

function kidsOf(n: any): any[] {
  const raw = n?.children ?? n?.props?.children
  return Array.isArray(raw) ? raw : raw != null ? [raw] : []
}

function textWidth(n: any): number {
  if (typeof n === 'string' || typeof n === 'number') return String(n).length
  if (!n || typeof n !== 'object') return 0
  const p = n.props ?? {}
  if (n.type === 'Input') return Math.max(20, String(p.label ?? '').length + String(p.placeholder ?? p.value ?? '').length + 4)
  const own = kidsOf(n).reduce((a: number, k: any) => a + textWidth(k), 0)
  return own || String(p.label ?? '').length
}

// Lays the tree out roughly: a column stacks its children, a row places them
// side by side (columnGap between), borders and padding add their cells.
// Returns the box's size; focusable elements are pushed with their origin.
function place(n: any, x: number, y: number, out: NavItem[], width = 1e9): { w: number; h: number } {
  if (n == null || typeof n !== 'object') return { w: textWidth(n), h: typeof n === 'string' ? 1 : 0 }
  const p = n.props ?? {}
  if (p.display === 'none') {
    // Not drawn, but its buttons are still stops in the engine's ring.
    const inner: NavItem[] = []
    for (const k of kidsOf(n)) place(k, 0, 0, inner)
    for (const i of inner) out.push({ ...i, x: -1, y: -1, hidden: true })
    return { w: 0, h: 0 }
  }
  const t = n.type
  if (FOCUSABLE.has(t)) {
    const w = textWidth(n)
    if (p.key ?? n.key) out.push({ key: String(p.key ?? n.key), x, y, w })
    return { w, h: 1 }
  }
  if (t === 'Text') return { w: textWidth(n), h: 1 }
  if (t === 'Client') {
    const w = Number(p.width) || 0
    const h = Number(p.height) || 1
    if (p.key ?? n.key) out.push({ key: String(p.key ?? n.key), x, y, w, h, client: true })
    return { w, h }
  }
  const border = p.borderStyle ? 1 : 0
  const padX = (p.paddingLeft ?? p.paddingX ?? p.padding ?? 0) + border
  const padY = (p.paddingTop ?? p.paddingY ?? p.padding ?? 0) + border
  const mTop = p.marginTop ?? p.marginY ?? p.margin ?? 0
  const kids = kidsOf(n)
  let w = 0
  let h = 0
  const inner = width - 2 * padX
  if (p.flexDirection === 'row') {
    // A wrapping row (the Policy tab's modes) starts a new line where the
    // next child would pass the pane's edge.
    const wrap = p.flexWrap === 'wrap'
    const gap = p.columnGap ?? p.gap ?? 0
    let cx = x + padX
    let line = 0
    let lineH = 0
    // alignItems center puts a short child (a one-row button) on the middle
    // row of a tall neighbour (a bordered field), so the Web tab's ⚙ sits on
    // the fields' text row, not above it.
    const sizes = kids.map((k) => place(k, 0, 0, [], inner))
    // flexGrow children share what the others leave (the Web tab's two fields
    // split the row), so columns line up with what the pane draws.
    const grow = kids.map((k) => Number(k?.props?.flexGrow ?? 0))
    const growSum = grow.reduce((a, b) => a + b, 0)
    if (growSum > 0 && inner < 1e8 && !wrap) {
      const fixed = sizes.reduce((a, z, i) => a + (grow[i] ? 0 : z.w), 0) + gap * Math.max(0, kids.length - 1)
      const rest = Math.max(0, inner - fixed)
      sizes.forEach((z, i) => {
        if (grow[i]) z.w = Math.floor((rest * grow[i]!) / growSum)
      })
    }
    const rowH = p.alignItems === 'center' ? Math.max(0, ...sizes.map((z) => z.h)) : 0
    for (const [ki, k] of kids.entries()) {
      const kw = sizes[ki]!.w
      if (wrap && cx > x + padX && cx + kw > x + padX + inner) {
        line += lineH + (p.rowGap ?? 0)
        lineH = 0
        cx = x + padX
      }
      const dy = rowH && !wrap ? Math.floor((rowH - sizes[ki]!.h) / 2) : 0
      const s = place(k, cx, y + mTop + padY + line + dy, out, grow[ki] ? sizes[ki]!.w : inner)
      if (grow[ki]) {
        // The field inside a grown box spans the box: widen what place() saw.
        for (const it of out) if (it.x >= cx && it.x < cx + sizes[ki]!.w && it.y >= y && it.w < sizes[ki]!.w - 4) it.w = Math.max(it.w, sizes[ki]!.w - 4)
      }
      const sw = grow[ki] ? sizes[ki]!.w : s.w
      cx += sw + (sw ? gap : 0)
      lineH = Math.max(lineH, s.h + dy)
      w = Math.max(w, cx - x + padX)
    }
    h = line + lineH
  } else {
    let cy = y + mTop + padY
    for (const k of kids) {
      const s = place(k, x + padX, cy, out, inner)
      cy += s.h + (s.h ? p.rowGap ?? p.gap ?? 0 : 0)
      w = Math.max(w, s.w + 2 * padX)
    }
    h = cy - y - mTop - padY
  }
  return { w, h: h + 2 * padY + mTop + (p.marginBottom ?? p.marginY ?? p.margin ?? 0) }
}

export function navItems(tree: unknown, width?: number): NavItem[] {
  const out: NavItem[] = []
  place(tree, 0, 0, out, width ?? 1e9)
  return out.filter((i) => !i.client)
}

// Client regions are not in the engine's focus ring, but their layout cells
// let a terminal-only caller synthesize a click into one (register.ts Web
// Page mode). Kept separate so arrow navigation never targets one.
export function clientItems(tree: unknown, width?: number): NavItem[] {
  const out: NavItem[] = []
  place(tree, 0, 0, out, width ?? 1e9)
  return out.filter((i) => i.client)
}

export type NavDir = 'up' | 'down' | 'left' | 'right'

// The element the ring should land on from `from`: for up/down the nearest
// row in that direction, then the element whose span is closest to the
// current one's column; for left/right the nearest element on the same row.
// undefined when there is none (the caller scrolls instead).
export function navTarget(all: readonly NavItem[], from: string | undefined, dir: NavDir): NavItem | undefined {
  const items = all.filter((i) => !i.hidden)
  const cur = items.find((i) => i.key === from)
  if (!cur) return dir === 'down' || dir === 'right' ? items[0] : items.at(-1)
  const mid = (i: NavItem) => i.x + i.w / 2
  if (dir === 'left' || dir === 'right') {
    const same = items.filter((i) => i.y === cur.y && (dir === 'right' ? i.x > cur.x : i.x < cur.x))
    return same.sort((a, b) => (dir === 'right' ? a.x - b.x : b.x - a.x))[0]
  }
  const rows = items.filter((i) => (dir === 'down' ? i.y > cur.y : i.y < cur.y))
  if (!rows.length) return undefined
  const y = dir === 'down' ? Math.min(...rows.map((i) => i.y)) : Math.max(...rows.map((i) => i.y))
  return rows.filter((i) => i.y === y).sort((a, b) => Math.abs(mid(a) - mid(cur)) - Math.abs(mid(b) - mid(cur)))[0]
}

// Where the ring should land when the engine moves it onto a hidden button
// (the cockpit's letter catchers): the next visible element in the direction
// it was going. `order` is the ring order (the drawn tree's), `from` where the
// ring was. The direction is the shorter way round from `from` to `hidden`:
// Tab from the last element wraps forward onto the first catcher, Shift+Tab
// from the first visible element steps back onto the last one.
export function skipHidden(order: readonly string[], hidden: string, from: string | undefined, isHidden = (k: string) => k.startsWith('catch-') || k === 'palette-toggle'): string | undefined {
  const n = order.length
  const h = order.indexOf(hidden)
  if (h < 0 || !order.some((k) => !isHidden(k))) return undefined
  const f = from ? order.indexOf(from) : -1
  const forward = f < 0 || (h - f + n) % n <= (f - h + n) % n
  for (let step = 1; step <= n; step++) {
    const k = order[(h + (forward ? step : -step) + n * step) % n]!
    if (!isHidden(k)) return k
  }
  return undefined
}

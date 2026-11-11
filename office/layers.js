// What Esc closes: the layer opened last. The office's overlays (🔑 인증,
// ⚙ 설정, ⌨ 단축키, 👁 viewer, a session's card, 🎖 지휘) each go on this
// stack when they open, and Esc takes off only the top one. Before this each
// overlay had its own Esc line in officeKey and command.js's commandKey ran
// first: with 인증 opened over 지휘, Esc closed 지휘 and left 인증 up (the
// person: "인증 pane 처럼 제일 위에 있는게 먼저 꺼져야 … stack 으로 동작해야").
//
// A layer is { id, up, close }: up() says whether it is still open (one
// closed by its ✕, a click outside or a toggle key is dropped when Esc next
// looks), close() closes it. Opening a layer already on the stack moves it
// to the top. A layer may also take an Esc of its own first (step: the
// 지휘 view backs out of an armed choice, then a picked row, before it
// closes): step() returns true when it used the Esc and stays up.
// Loaded before the other modules: office.html's officeKey asks it first.

const layers = []

function layerUp(id, up, close, step) {
  const at = layers.findIndex((l) => l.id === id)
  if (at >= 0) layers.splice(at, 1)
  layers.push({ id, up, close, step: step || null })
}

// The layers still open, oldest first (the closed ones are dropped).
function layerOpen() {
  for (let i = layers.length - 1; i >= 0; i--) {
    let up = false
    try { up = !!layers[i].up() } catch { up = false }
    if (!up) layers.splice(i, 1)
  }
  return layers.map((l) => l.id)
}

// The top layer's id, or null.
function layerTop() {
  const open = layerOpen()
  return open.length ? open[open.length - 1] : null
}

// Esc: the top layer's own step, else its close. True when a layer took it.
function layerEsc() {
  if (!layerTop()) return false
  const top = layers[layers.length - 1]
  if (top.step && top.step()) return true
  top.close()
  layers.pop()
  return true
}

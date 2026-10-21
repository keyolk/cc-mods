// The Web tab's region: a Client so pointer and keys over it reach the hooks
// module (surface.post → ui.message) and from there the TWeb engine.
//
// The page is drawn over exactly these cells (bin/cc-browser finds them below
// the page header row, views/web.ts, and takes their size from the mod). TWeb draws
// under text, so the region draws nothing but blanks once the page shows; the
// hint is for the moment before. Kept free of imports: it runs on the
// drawing thread.

type Props = { hint: string }
type State = { started: true }

export default function WebRegion(props: Props, surface: any) {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer((e: any) =>
      surface.post({ t: 'p', type: e.type, x: e.x, y: e.y, button: e.button, shift: e.shift, alt: e.alt, ctrl: e.ctrl }),
    )
    surface.onKey((e: any) => surface.post({ t: 'k', key: e.key, ctrl: e.ctrl, shift: e.shift, meta: e.meta }))
    surface.setState({ started: true } as State)
  }
  const lines = []
  for (let i = 0; i < Math.max(1, surface.rows); i++) lines.push(Text({ children: [i === 1 && props.hint ? '  ' + props.hint : ' '] }))
  return Box({ flexDirection: 'column', children: lines })
}

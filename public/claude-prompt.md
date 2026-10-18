I use RGB Studio, an app that drives the RGB lights in my PC with OpenRGB. It needs to know where each light physically is, so colors can flow through my setup in the right order. Please edit my layout file below to match my real setup, which I'll describe after it.

How the file works (all sizes in centimetres):

- `case.size` is `[depth, height, width]` of my PC case: depth runs rear → front, height bottom → top, width motherboard tray → side glass. `case.placement` is one of `desk-left`, `desk-right`, `floor-left`, `floor-right`.
- `case.spot` (optional) places the case exactly: `{ "x", "z", "turn" }`, where x and z are the middle of the case's footprint in cm from the back-left corner of the desk area (x to the right, z toward me), and turn is in degrees, counter-clockwise seen from above. With `turn: 0` the case's front faces right and its glass faces me. Use `null` to put it beside the desk according to `placement`.
- `desk.size` is `[width, depth]` of the desk area my keyboard, mouse and monitor sit on.
- Each entry in `lights` is one light zone. **Keep the keys exactly as they are**: they identify my real devices. `label` is just a name you may change.
- `area` is `case` or `desk`, and `pos` is `[x, y, z]` inside that area:
  - case: x = from the rear panel toward the front panel, y = up from the bottom, z = out from the motherboard tray toward the glass
  - desk: x = from the left edge to the right, y = height above the desk, z = from the back edge (wall) toward me
- `plane` is the flat surface the light lies in: `xz` lies flat (bottom or top fans, keyboards), `yz` stands facing front or rear (front or rear fans), `xy` faces the glass or me (RAM, motherboard lights, monitor lights).
- `shape`: `ring` (fans; `size` is the radius, `rings` is 1, or 2 for fans lit on both faces), `bar` (`size` is its length), `matrix` (keyboards; `size` is the width), `dots` (single LEDs).
- `angle` turns the light within its plane, in degrees. `flip: true` reverses the LED order if colors run the wrong way. For a fan lying flat, `sweep: true` makes rising effects cross it from the glass side instead of lighting the whole fan at once.
- `hidden: true` means nothing is plugged into that zone.
- `body` draws a simple model: `fan`, `ram`, `keyboard`, `mouse`, `headset` or `null`.
- `props` are plain boxes for context, like a monitor: `{ "area", "label", "pos" (center), "size" [x, y, z], "style": "box" | "screen" | "stand" }`. Use `null` to let the app generate them.

Typical spots in a 45 × 47 × 22 case: bottom fans at y = 2.5 with plane `xz`, rear fan at x = 2 with plane `yz`, front fans at x = 43 with plane `yz`, top fans at y = 44.5 with plane `xz`. 140 mm fans have a radius of about 6, and 120 mm fans about 5.

Reply with only the complete, updated JSON file, so I can paste it back into RGB Studio (Share / import → Import).

My layout file:

```json
{{RIG}}
```

My setup:

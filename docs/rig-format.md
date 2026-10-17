# Rig file format

RGB Studio stores where your lights physically are as a small JSON file. **Share / import** in the sidebar copies it, and **Import** loads one back, for example one Claude rewrote from a description of your build (**Ask Claude** copies a ready-made prompt for that).

All sizes and positions are in centimetres.

```json
{
  "format": "rgb-studio-rig/1",
  "case": { "size": [45, 47, 22], "placement": "floor-right", "spot": null },
  "desk": { "size": [160, 70] },
  "props": null,
  "lights": {
    "NZXT RGB Controller|0123456789ABCDEF#0": {
      "label": "140mm fan (Channel 1)",
      "area": "case", "shape": "ring", "pos": [29.7, 2.5, 11], "plane": "xz",
      "size": 6, "angle": 0, "rings": 2, "flip": false, "hidden": false, "body": "fan"
    }
  }
}
```

## Case and desk

| Field | Meaning |
| --- | --- |
| `case.size` | `[depth, height, width]`: depth runs rear → front, height bottom → top, width motherboard tray → side glass. |
| `case.placement` | `desk-left`, `desk-right`, `floor-left` or `floor-right`. On the floor, the desk stands on legs 75 cm high. |
| `case.spot` | Optional exact spot: `{ "x", "z", "turn" }`. x and z are the middle of the case's footprint, measured from the back-left corner of the desk area (x to the right, z toward you). `turn` is in degrees, counter-clockwise seen from above; at 0 the case's front faces right and its glass faces you. `null` puts it beside the desk according to `placement`. |
| `desk.size` | `[width, depth]` of the desk area your keyboard, mouse and monitor sit on. |

## Lights

`lights` maps each light zone's key to where it is. Keys look like `device name|serial#zone`. They come from OpenRGB, so keep them exactly as they are; zones missing from the file keep RGB Studio's own guess.

| Field | Meaning |
| --- | --- |
| `label` | Any name you like. |
| `area` | `case` or `desk`. |
| `pos` | `[x, y, z]` inside the area. Case: x from the rear panel toward the front, y up from the bottom, z out from the motherboard tray toward the glass. Desk: x from the left edge to the right, y height above the desk, z from the back edge (the wall) toward you. |
| `plane` | The flat surface the light lies in: `xz` lies flat (bottom or top fans, keyboards), `yz` stands facing front or rear (front and rear fans), `xy` faces the glass or you (RAM, motherboard lights, monitor lights). |
| `shape` | `ring` (fans; `size` is the radius), `bar` (`size` is the length), `matrix` (keyboards; `size` is the width) or `dots` (single LEDs). |
| `rings` | `1`, or `2` for fans lit on both faces. |
| `angle` | Turns the light within its plane, in degrees. |
| `flip` | `true` reverses the LED order, if colors run the wrong way. |
| `sweep` | For fans lying flat (`plane` `xz`): `true` makes effects treat the fan as tilted up to face the glass, so rising effects sweep across it from the glass side instead of lighting it all at once. |
| `hidden` | `true` when nothing is plugged into that zone. |
| `body` | The model drawn around it: `fan`, `ram`, `keyboard`, `mouse` or `null`. |

Desk lights in the `xy` plane that sit behind a monitor (a `screen` prop) light up the wall behind the desk in the 3D view.

## Props

`props` are plain boxes drawn for context, such as a monitor and its stand. Each one is `{ "area", "label", "pos", "size", "style" }`: `pos` is the box's center, `size` is `[x, y, z]`, and `style` is `box`, `screen` or `stand`. Use `null` to let RGB Studio generate them from your devices.

Typical spots in a 45 × 47 × 22 case: bottom fans at y = 2.5 in plane `xz`, a rear fan at x = 2 in plane `yz`, front fans at x = 43 in plane `yz`, top fans at y = 44.5 in plane `xz`. 140 mm fans have a radius of about 6, and 120 mm fans about 5.

# Player files

**Save to PC** in RGB Studio records your looks for the background player (`player/RGBStudioPlayer.exe`), which plays them with nothing else running. Both files live in `%APPDATA%\RGB Studio\`.

## `player.json`

```json
{
  "version": 1,
  "fps": 20,
  "savedAt": "2026-10-18T12:00:00.000Z",
  "devices": [
    {
      "name": "NZXT RGB Controller",
      "location": "HID: \\\\?\\hid#...",
      "ledCount": 60,
      "control": "BASE64…",
      "tracks": [{ "leds": [0, 1, 2], "frames": 120, "offset": 0 }],
      "still": "BASE64…"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `fps` | Frames per second of every track. |
| `devices[].name`, `location` | Which OpenRGB device this is. Match both against the device's controller data; skip devices that aren't there. |
| `ledCount` | How many LEDs the device has. Every color update sends this many. |
| `control` | Body of an `RGBCONTROLLER_UPDATEMODE` (1101) packet that puts the device into its per-LED mode, or `null` to leave the device alone (it runs its own built-in effect). Send it before colors, again after reconnecting, and after the device list changes. |
| `tracks` | The animated look. Each track covers some of the device's LEDs (`leds`, LED indices) and holds `frames` frames starting at byte `offset` of `player.bin`. LEDs in no track stay black. |
| `still` | The still colors, used for **Still colors** and when the player closes: `ledCount × 3` bytes, R G B per LED. |

## `player.bin`

The track data, back to back. A track is `frames × leds.length × 3` bytes: frame by frame, then LED by LED (in the order of `leds`), then R, G, B.

## Playback

One clock for everything: with `t` seconds since playback started, each track shows frame `floor(t × fps) mod frames`. Tracks loop seamlessly, so all devices stay in step.

## Sending colors

Standard OpenRGB SDK on `127.0.0.1:6742`, protocol 5. Every packet starts with a 16-byte header: `ORGB`, then `device index`, `packet id` and `body size` as little-endian `u32`.

- **Color update:** `RGBCONTROLLER_UPDATELEDS` (1050). The body is `u32` body size (including this field), `u16` LED count, then 4 bytes per LED: R, G, B, 0.
- **Control:** the `control` body above, as packet 1101.

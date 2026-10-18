# RGB Studio

A simpler way to light up a PC with [OpenRGB](https://openrgb.org). Pick a look, and every fan, RAM stick, keyboard, mouse and monitor light shows it in sync. Colors flow through your setup by where each light physically is, not by device.

![RGB Studio](docs/screenshot.png)

- **Looks:** 21 ready-made scenes (Synthwave, Aurora, Lava Lamp, Storm, Comet, Matrix and more), each one editable: pick the motion, colors, speed, brightness, gradient width and how much the dark gaps glow. Give the desk its own look, or run one look across everything.
- **Motions:** flow, bounce, breathe, twinkle, comet, drift, beam, bubbles, lightning and fill.
- **Your setup in 3D:** your case, desk and monitor, lit live. Drag each light to where it really sits, move and turn the case, and pick which way colors travel: up, across, out from the center, or in a spiral around the case. Lights on the back of a monitor glow on the wall behind it.
- **Save to PC:** a small tray player keeps your look playing, in sync, after the editor closes. Pick still colors for when you're not using it.

## Requirements

- Windows, with [OpenRGB](https://openrgb.org) 0.9 or newer running its SDK server on port 6742. The OpenRGB Windows service does this, or turn on *SDK Server* in the OpenRGB app.
- [Node.js](https://nodejs.org) 20 or newer.

## Run it

Double-click `start.cmd`, or:

```
npm install
npm start
```

This opens http://127.0.0.1:6750 in your browser. RGB Studio only listens on your own PC.

The editor closes by itself about 15 seconds after you close the tab. Run `node server.js --keep-alive` to keep it running.

## Keeping your lights after it closes

The editor draws your look live, so it stops when the editor closes. **Save to PC** records it for the player:

- **The player** (`player\RGBStudioPlayer.exe`) is a small app with an icon in your taskbar tray. It plays your saved look, in sync across every device, and picks up new saves by itself. While the editor is open it waits, then takes over again once you close it. Its menu has **Open editor**, **Animated look** or **Still colors**, **Start with Windows** (off until you turn it on), and **Close**.
- **Still colors** are what your lights show when you're not using them: from the player's menu, after you close the player, and while your PC starts. Pick a color for the case and one for the desk, or freeze a snapshot of your look. RGB Studio stores them on devices that support it and in an OpenRGB profile named "RGB Studio". To show them after a restart or sleep as well, the save dialog offers to make that the OpenRGB service's startup profile. That step needs administrator rights once.

To build the player, run `player\build.cmd`. It uses the C# compiler that comes with Windows, so there's nothing to install. The player needs only OpenRGB. The files it plays are described in [docs/player-format.md](docs/player-format.md).

## Other RGB software

Other RGB apps fight OpenRGB over the same devices:

- **Logitech G HUB** can take the keyboard and mouse back from OpenRGB while it's running. If they stop following RGB Studio, close G HUB while you use it, or give those devices a built-in effect in RGB Studio.
- **NZXT CAM:** stopping it from opening at startup is enough.
- **Corsair iCUE, Armoury Crate, Mystic Light** and similar should be closed or uninstalled.

## The 3D view

| Do this | To |
| --- | --- |
| Drag a light | move it along the surface it's mounted on |
| Click the case, then drag it | move the case (turn it in the sidebar) |
| Drag empty space, or middle-drag | orbit |
| Right-drag, or Shift + drag | pan |
| Scroll | zoom toward the pointer |

## Describe your own setup

Device names and LED counts come from OpenRGB, but RGB Studio can't know where you mounted things. Drag lights in the 3D view, or use **Share / import** in the sidebar:

- **Copy** gives you your layout as JSON, to back up or share.
- **Ask Claude** copies a ready-made prompt with your layout. Paste it into Claude (or another assistant), describe your build in plain words ("three front intake fans, two top exhaust, RGB strip under the desk"), and paste the reply back into **Import**.

The format is described in [docs/rig-format.md](docs/rig-format.md).

## How it works

```
server.js              local web server, effect loop and API
src/openrgb.js         OpenRGB SDK client (protocol 5, no dependencies)
src/effects.js         scenes, and the renderer that turns LED positions into colors
src/rig.js             default positions for each kind of device, and rig validation
src/persist.js         stores still colors on devices and in the OpenRGB profile
src/player-export.js   Save to PC: records each look as a seamless loop for the player
player/                the tray player (C#, built with player\build.cmd)
src/startup.js         sets the OpenRGB service's startup profile (via tools/set-startup-profile.js)
shared/rig-geometry.js where each LED sits, shared by the server and the 3D view
public/                the page, including the three.js rig view
tools/probe.js         prints every device, zone and mode OpenRGB reports (npm run probe)
```

Settings and your layout are saved to `settings.json` next to `server.js`.

Some effects are inspired by ideas from [OpenRGBEffectsPlugin](https://gitlab.com/OpenRGBDevelopers/OpenRGBEffectsPlugin); no code is taken from it.

## License

[MIT](LICENSE)

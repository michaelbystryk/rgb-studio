// Where each LED sits for the effects: its position along the flow and on the views people look at. Kept apart from the server so it can be checked on its own.
import { buildLights } from './rig.js';
import { facing } from './effects.js';
import { FLOWS, SPINS, effectPositions, areaSize, areaToWorld, worldBox, flowPosition, spiralTurn, spinPosition, squeezeGaps } from '../shared/rig-geometry.js';

const DESK_EFFECT_HEIGHT = 50;  // cm of height above the desk that 3D effects span

// Shorten the empty stretches along the flow, keeping `keep` of each. Outward flows are scaled first
// so the farthest light is where the flow ends, like every other direction.
function finish(list, dir, keep) {
  if (!list.length) return;
  if (!dir) {
    const far = Math.min(...list.map(led => led.p));
    if (far < 0) list.forEach(led => { led.p /= -far; });
  }
  squeezeGaps(list.map(led => led.p), keep).forEach((p, i) => { list[i].p = p; });
  // Bubbles start on lights, never in empty space: a few dozen LEDs spread through the list.
  const anchors = Array.from({ length: Math.min(48, list.length) }, (_, k) => facing(list[Math.floor((k * list.length) / Math.min(48, list.length))]));
  list.forEach(led => { led.anchors = anchors; });
}

// Each LED's place for the effects (see renderFrame), from where its light sits in the rig and the
// flow settings: per device, per LED, { p, n, area, face?, turn?, lap?, anchors }.
export function layoutLeds(devices, keys, settings) {
  const lights = buildLights(devices, keys, settings.rig);
  const leds = devices.map(d => Array.from(d.leds, () => ({ p: 0, n: [0.5, 0.5, 0.5], area: 'case' })));
  const spots = { case: [], desk: [], rig: [] };
  for (const l of lights) {
    if (l.hidden) continue;
    const z = devices[l.device].zones[l.zone];
    effectPositions(l, l.count, z.matrix).forEach((pos, i) => {
      if (settings.flow.together) spots.rig.push({ l, i, pos: areaToWorld(settings.rig, l.area, pos) });
      else spots[l.area].push({ l, i, pos });
    });
  }
  for (const [group, list] of Object.entries(spots)) {
    if (!list.length) continue;
    const dir = FLOWS[group][settings.flow[group]];
    let lo, span, box;
    if (group === 'rig') {
      // One flow over every light, measured in the shared world so it can rise from the case up the monitor.
      const { min, size } = worldBox(list.map(s => s.pos));
      [lo, span, box] = [min, size, size];
    } else {
      // An area's own frame, stretched to take in any light that sits outside it (a headset in
      // front of the desk), so the flow still runs from 0 to -1.
      const size = areaSize(settings.rig, group);
      const { min, size: extent } = worldBox(list.map(s => s.pos));
      lo = min.map(v => Math.min(0, v));
      span = size.map((v, k) => Math.max(v, min[k] + extent[k]) - lo[k]);
      box = group === 'desk' ? [size[0], DESK_EFFECT_HEIGHT, size[2]] : size;
    }
    const placed = list.map(({ l, i, pos }) => {
      const rel = pos.map((v, k) => v - lo[k]);
      const led = { area: l.area };
      if (group === 'rig') {
        led.n = rel.map((v, k) => (box[k] ? v / box[k] : 0.5));
        led.face = [led.n[0] - 0.5, led.n[1] - 0.5]; // the whole rig seen from the front, so one radar or bubble spans it
      } else {
        led.n = pos.map((v, k) => v / box[k]);
        if (dir === 'spiral') led.turn = spiralTurn(rel, span);
      }
      // A spin goes once round the middle of the view (see facing), ending where it started.
      if (SPINS.includes(dir)) [led.p, led.lap] = [-spinPosition(facing(led), dir), true];
      else led.p = flowPosition(rel, span, dir);
      leds[l.device][l.ledStart + i] = led;
      return led;
    });
    finish(placed, dir, settings.gaps[group] / 100);
  }
  return { lights, leds };
}

// Checks every motion against every flow setting on a sample rig like a real one: case on the floor
// to the right of the desk, fans lying flat on its floor, RAM, a motherboard light and a keyboard,
// mouse and headset on the desk. Nothing is sent to OpenRGB. `node tools/check-effects.js`
//
// For each motion, direction, Together or Separate, and Empty space it looks for:
//   - LEDs that never light during a loop
//   - colors that travel the wrong way (against the flow)
//   - long pauses with every light dark while Empty space is skipped
//   - player loops whose end doesn't lead back into their start
//   - with Together, a case and desk that flash or bubble on their own instead of as one rig
import { renderFrame, MOTIONS } from '../src/effects.js';
import { layoutLeds } from '../src/layout.js';
import { DEFAULT_RIG } from '../src/rig.js';
import { FLOWS, cycleSeconds } from '../shared/rig-geometry.js';

const zone = (index, name, ledsCount, ledStart, matrix = null) => ({ index, name, ledsCount, ledStart, matrix });
const keyboardMatrix = () => {
  const width = 22, height = 6, map = [];
  let led = 0;
  for (let y = 0; y < height; y++) map.push(Array.from({ length: width }, () => (led < 117 ? led++ : 0xffffffff)));
  return { width, height, map };
};
const DEVICES = [
  { type: 'dram', name: 'RAM', serial: 'a', zones: [zone(0, 'DRAM', 10, 0)] },
  { type: 'dram', name: 'RAM', serial: 'b', zones: [zone(0, 'DRAM', 10, 0)] },
  { type: 'ledstrip', name: 'Fan controller', serial: 'c', zones: [zone(0, 'Fan 1', 20, 0), zone(1, 'Fan 2', 20, 20), zone(2, 'Fan 3', 20, 40)] },
  { type: 'motherboard', name: 'Motherboard', serial: 'd', zones: [zone(0, 'Aura Mainboard', 3, 0), zone(1, 'Aura Addressable 1', 60, 3)] },
  { type: 'keyboard', name: 'Keyboard', serial: 'e', zones: [zone(0, 'Keyboard', 117, 0, keyboardMatrix())] },
  { type: 'mouse', name: 'Mouse', serial: 'f', zones: [zone(0, 'Logo', 1, 0), zone(1, 'DPI', 1, 1)] },
  { type: 'headset', name: 'Headset', serial: 'g', zones: [zone(0, 'Left', 1, 0), zone(1, 'Right', 1, 1)] },
].map((d, index) => ({ ...d, index, leds: Array.from({ length: d.zones.reduce((n, z) => n + z.ledsCount, 0) }) }));
const KEYS = DEVICES.map(d => `${d.name}|${d.serial}`);
const RIG = {
  ...DEFAULT_RIG,
  case: { ...DEFAULT_RIG.case, size: [45, 47, 22], placement: 'floor-right', spot: null },
  lights: {
    'Fan controller|c#0': { pos: [35.5, 2.5, 11], plane: 'xz', sweep: true, angle: -120 },
    'Fan controller|c#1': { pos: [14.4, 2.5, 11], plane: 'xz', sweep: true, angle: 225 },
    'Fan controller|c#2': { flip: true, angle: 180 },
    'Motherboard|d#0': { pos: [7.5, 34, 2] },
    'Keyboard|e#0': { pos: [72.5, 2, 44], sweep: true },
  },
};

const PALETTE = ['#ff0000', '#00ff00', '#0000ff'];
const FPS = 40;
// Motions that pass along the flow, and so must reach every light, in order.
const TRAVELING = ['flow', 'comet', 'fill', 'beam'];
const loopSeconds = look => cycleSeconds(look.speed) * ({ flow: 1, bounce: 2, breathe: 4 }[look.motion] ?? PALETTE.length);

function run(settings, look) {
  const { lights, leds } = layoutLeds(DEVICES, KEYS, settings);
  const visible = [];
  for (const l of lights) if (!l.hidden) for (let i = 0; i < l.count; i++) visible.push([l.device, l.ledStart + i, l]);
  const seconds = loopSeconds(look), frames = Math.round(seconds * FPS);
  const render = t => DEVICES.map(d => renderFrame(leds[d.index], look, t, d.index));
  const bright = hex => Math.max(...[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)));
  const peak = visible.map(() => ({ v: -1, t: 0 })), lit = visible.map(() => false);
  let dark = 0, longestDark = 0, apart = 0;
  for (let k = 0; k < frames; k++) {
    const t = (k / frames) * seconds, frame = render(t);
    let any = false;
    const areaLit = { case: false, desk: false }, areaBright = { case: false, desk: false };
    visible.forEach(([d, i, l], j) => {
      const v = bright(frame[d][i]);
      if (v > 0) areaLit[l.area] = true;
      if (v > 40) areaBright[l.area] = true;
      if (v > 40) { lit[j] = true; any = true; }
      if (v > peak[j].v) peak[j] = { v, t };
    });
    // One part bright while the other is fully dark (a fading flash can round to off a frame early).
    if ((areaBright.case && !areaLit.desk) || (areaBright.desk && !areaLit.case)) apart++;
    dark = any ? 0 : dark + 1;
    longestDark = Math.max(longestDark, dark);
  }
  const loopsBack = JSON.stringify(render(seconds)) === JSON.stringify(render(0));
  return { leds, visible, lit, peak, longestDark: longestDark / frames, apart: apart / frames, loopsBack, seconds };
}

// How well two lists rise together, -1..1.
function correlation(a, b) {
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let ab = 0, aa = 0, bb = 0;
  a.forEach((x, i) => { ab += (x - ma) * (b[i] - mb); aa += (x - ma) ** 2; bb += (b[i] - mb) ** 2; });
  return aa && bb ? ab / Math.sqrt(aa * bb) : 1;
}

const problems = [];
let checked = 0;
const configs = [];
for (const rigDir of Object.keys(FLOWS.rig)) configs.push({ together: true, rig: rigDir, case: 'up', desk: 'right' });
const caseDirs = Object.keys(FLOWS.case), deskDirs = Object.keys(FLOWS.desk);
for (let i = 0; i < Math.max(caseDirs.length, deskDirs.length); i++) {
  configs.push({ together: false, rig: 'up', case: caseDirs[i % caseDirs.length], desk: deskDirs[i % deskDirs.length] });
}

for (const flow of configs) {
  for (const gap of [0, 100]) {
    const settings = { rig: RIG, flow, gaps: { case: gap, desk: gap, rig: gap } };
    const name = flow.together ? `together ${flow.rig}` : `separate case ${flow.case}, desk ${flow.desk}`;
    for (const motion of MOTIONS.filter(m => m !== 'still')) {
      for (const [spread, comets] of motion === 'comet' ? [[0, 1], [100, 1], [30, 3]] : [[0, 1], [100, 1]]) {
        const look = { motion, palette: PALETTE, speed: 60, brightness: 100, spread, background: 0, comets };
        const r = run(settings, look);
        checked++;
        const where = `${motion} (spread ${spread}${motion === 'comet' ? `, ${comets} at once` : ''}), ${name}, empty space ${gap}`;
        const never = r.visible.filter((_, j) => !r.lit[j]).map(([, , l]) => l.label);
        if (never.length && ['flow', 'bounce', 'breathe', 'comet', 'noise', 'beam', 'fill'].includes(motion)) {
          problems.push(`${where}: never lights ${[...new Set(never)].join(', ')} (${never.length} LEDs)`);
        }
        if (!r.loopsBack && ['flow', 'bounce', 'breathe', 'comet', 'beam', 'fill'].includes(motion)) problems.push(`${where}: player loop doesn't come back to its start`);
        if (flow.together && motion === 'lightning' && r.apart > 0) problems.push(`${where}: case and desk flash separately ${(r.apart * 100).toFixed(0)}% of the time`);
        if (motion === 'bubbles' && r.longestDark > 0.05) problems.push(`${where}: everything dark for ${(r.longestDark * 100).toFixed(0)}% of the loop`);
        if (gap === 0 && ['comet', 'beam'].includes(motion) && r.longestDark > 0.08) {
          problems.push(`${where}: everything dark for ${(r.longestDark * 100).toFixed(0)}% of the loop`);
        }
        // Direction: the time each LED is brightest should follow its place along the flow.
        if (TRAVELING.includes(motion) && motion !== 'beam' && spread === 0) {
          const pos = r.visible.map(([d, i]) => -r.leds[d][i].p);
          const per = cycleSeconds(look.speed);
          const t0 = r.peak[pos.indexOf(Math.min(...pos))].t;
          const times = r.peak.map(pk => (((pk.t - t0) % per) + per) % per);
          const c = correlation(pos, times);
          if (c < 0.8) problems.push(`${where}: colors don't follow the flow (correlation ${c.toFixed(2)})`);
        }
      }
    }
  }
}

// Positions along the flow itself: every direction should run from 0 at its start to about -1.
for (const flow of configs) {
  for (const gap of [0, 100]) {
    const { lights, leds } = layoutLeds(DEVICES, KEYS, { rig: RIG, flow, gaps: { case: gap, desk: gap, rig: gap } });
    const ps = lights.filter(l => !l.hidden).flatMap(l => leds[l.device].slice(l.ledStart, l.ledStart + l.count).map(x => x.p));
    const lo = Math.min(...ps), hi = Math.max(...ps);
    if (hi > 1e-9 || lo < -1 - 1e-9) problems.push(`flow positions for ${JSON.stringify(flow)}, empty space ${gap}: ${hi.toFixed(2)} to ${lo.toFixed(2)}, should stay within 0 to -1`);
  }
}

console.log(`${checked} combinations checked.`);
if (problems.length) {
  console.log(`${problems.length} problems:`);
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
} else console.log('No problems found.');

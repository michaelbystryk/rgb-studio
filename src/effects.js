// Scenes and the per-frame renderer that turns LED positions into colors.
import { hexToRgb, rgbToHex, rgbToHsv, samplePalette } from './color.js';
import { cycleSeconds } from '../shared/rig-geometry.js';

// How a look moves over time:
//   still     — the gradient (or a single color) holds still
//   flow      — the gradient travels across the rig
//   bounce    — the gradient sweeps one way, then back (a "visor" or scanner)
//   breathe   — the whole rig fades in and out while the gradient drifts slowly
//   twinkle   — LEDs flash palette colors at random over a dim gradient
//   comet     — one band of light runs across a dark rig, each pass in the next palette color
//   noise     — ("Drift") slow, organic blobs of palette color drift through the rig, like a lava lamp
//   beam      — a beam sweeps around the middle of the case and desk, like a lighthouse
//   bubbles   — rings of light grow from random spots and fade
//   lightning — sudden flashes that flicker and fade over a dark rig
//   fill      — the rig fills up with a color in the flow direction, empties, then the next color
export const MOTIONS = ['still', 'flow', 'bounce', 'breathe', 'twinkle', 'comet', 'noise', 'beam', 'bubbles', 'lightning', 'fill'];
// Motions whose dark parts (or dark palette colors) the look's `background` can fill with a dim
// gradient: every one that moves.
export const BACKDROP_MOTIONS = MOTIONS.filter(m => m !== 'still');

// Every palette color keeps at least one channel near zero: mixes of all three read as white on LEDs.
export const SCENES = {
  cyberpunk: { label: 'Cyberpunk', motion: 'flow', palette: ['#0010ff', '#0070ff', '#5000ff', '#a000ff'] },
  synthwave: { label: 'Synthwave', motion: 'flow', palette: ['#ff00c0', '#8000ff', '#0040ff', '#c000ff'] },
  vaporwave: { label: 'Vaporwave', motion: 'flow', palette: ['#ff0090', '#00e0ff', '#8000ff'] },
  aurora: { label: 'Aurora', motion: 'noise', palette: ['#00ff60', '#00ffc0', '#0060ff', '#8000ff'] },
  lava: { label: 'Lava Lamp', motion: 'noise', palette: ['#ff0040', '#ff6000', '#ff00a0', '#a000ff'] },
  ocean: { label: 'Deep Ocean', motion: 'flow', palette: ['#0030ff', '#00a0ff', '#00ffc0', '#0070ff'] },
  bubbles: { label: 'Bubbles', motion: 'bubbles', palette: ['#00c0ff', '#0040ff', '#00ffc0'], background: 10 },
  storm: { label: 'Storm', motion: 'lightning', palette: ['#8000ff', '#0040ff', '#00c0ff'], background: 20 },
  radar: { label: 'Radar', motion: 'beam', palette: ['#00ff40', '#00ffc0'], background: 12 },
  comet: { label: 'Comet', motion: 'comet', palette: ['#ff00c0', '#00e0ff', '#8000ff', '#00ff60'] },
  powerup: { label: 'Power Up', motion: 'fill', palette: ['#ff00c0', '#8000ff', '#0040ff', '#c000ff'] },
  matrix: { label: 'Matrix', motion: 'twinkle', palette: ['#00ff00', '#00a000', '#00ff40', '#003000'], background: 25 },
  sakura: { label: 'Sakura', motion: 'breathe', palette: ['#ff0060', '#ff00c0', '#c000ff', '#ff0030'] },
  sunset: { label: 'Sunset', motion: 'flow', palette: ['#ff2000', '#ff8000', '#ff0060', '#8000ff'] },
  ember: { label: 'Ember', motion: 'flow', palette: ['#ff0000', '#ff3000', '#ff7000', '#ff1800'] },
  halloween: { label: 'Halloween', motion: 'flow', palette: ['#ff5000', '#a000ff', '#00ff20'] },
  christmas: { label: 'Christmas', motion: 'twinkle', palette: ['#ff0000', '#00ff00'], background: 25 },
  police: { label: 'Police', motion: 'bounce', palette: ['#ff0000', '#0000ff'] },
  rainbow: { label: 'Rainbow', motion: 'flow', palette: ['#ff0000', '#ffc000', '#00ff40', '#00c0ff', '#4000ff', '#ff00c0'] },
  solid: { label: 'Solid color', motion: 'still', palette: ['#5000ff'] },
  off: { label: 'Off', motion: 'still', palette: ['#000000'] },
};

const BREATHE_FLOOR = 0.08;   // breathing never goes fully dark
const BACKDROP_MAX = 0.5;     // background glow at 100%, as a share of full brightness
const TWINKLE_CHANCE = 0.35;  // share of LEDs that flash in each cycle
const COMET_HEAD = 0.04;      // how sharply the comet's leading edge rises
export const MAX_COMETS = 4;  // comets in flight at once (the look's `comets`, 1 by default)
export const cometsOf = look => Math.max(1, Math.min(MAX_COMETS, Math.round(look.comets ?? 1)));
const BUBBLES_AT_ONCE = 4;
const FILL_EDGE = 0.12;       // how soft the edge of a fill is, as a share of the rig

const clamp01 = v => Math.max(0, Math.min(1, v));
const fract = v => v - Math.floor(v);
const triangle = x => 1 - Math.abs((((x % 2) + 2) % 2) - 1);
const smooth = k => k * k * (3 - 2 * k);

// Deterministic 0..1 noise from an integer, so random effects don't need stored state.
function hash(n) {
  n = Math.imul((n | 0) ^ ((n | 0) >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Smooth 3D value noise in 0..1, plus a few octaves of it for detail.
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const at = (i, j, k) => hash(Math.imul(ix + i, 73856093) ^ Math.imul(iy + j, 19349663) ^ Math.imul(iz + k, 83492791));
  const lerp = (a, b, k) => a + (b - a) * k;
  const plane = k => lerp(lerp(at(0, 0, k), at(1, 0, k), fx), lerp(at(0, 1, k), at(1, 1, k), fx), fy);
  return lerp(plane(0), plane(1), fz);
}
const fbm = (x, y, z) => 0.6 * noise3(x, y, z) + 0.3 * noise3(2 * x, 2 * y, 2 * z) + 0.1 * noise3(4 * x, 4 * y, 4 * z);

// An LED's position on the view people actually look at, centered on 0: the case from the side
// (rear to front, bottom to top), the desk from above (left to right, front to back).
export const facing = l => l.face ?? (l.area === 'desk' ? [l.n[0] - 0.5, 0.5 - l.n[2]] : [l.n[0] - 0.5, l.n[1] - 0.5]);

// Colors for one device. Each LED is { p, n, area, turn? }: p is its position along the flow
// (0 where the flow starts, about -1 where it ends; see flowPosition), n its position in its area
// scaled to 0..1 on each axis, and turn (spiral flow only) how far around the case it sits.
// `seed` keeps each device's random effects independent.
export function renderFrame(leds, look, t, seed = 0) {
  const brightness = look.brightness / 100;
  const spread = look.spread / 100;
  const stops = look.palette.map(c => rgbToHsv(hexToRgb(c)));
  const colors = look.palette.map(hexToRgb);
  const cycle = cycleSeconds(look.speed);
  const cycles = 0.25 + spread * 1.75; // how many palette repeats fit across an area
  // Gradient position. A spiral puts one palette repeat around each lap, so the colors meet up.
  const grad = l => (l.turn === undefined ? l.p * cycles : -(l.n[1] * cycles + l.turn));
  const shade = (rgb, k) => rgbToHex(rgb.map(v => v * brightness * k));
  const at = (l, phase, k = 1) => shade(samplePalette(stops, grad(l) + phase), k);

  const frame = render();
  const backdrop = BACKDROP_MOTIONS.includes(look.motion) ? ((look.background ?? 0) / 100) * BACKDROP_MAX : 0;
  if (!backdrop) return frame;
  return frame.map((hex, i) => {
    const lit = hexToRgb(hex);
    return shade(samplePalette(stops, grad(leds[i])).map((v, c) => Math.max(lit[c] / brightness || 0, v * backdrop)), 1);
  });

  function render() {
    switch (look.motion) {
      case 'flow':
        return leds.map(l => at(l, t / cycle));

      case 'bounce':
        return leds.map(l => at(l, triangle(t / cycle)));

      case 'breathe': {
        const level = BREATHE_FLOOR + (1 - BREATHE_FLOOR) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / cycle));
        return leds.map(l => at(l, t / (cycle * 4), level));
      }

      case 'twinkle':
        return leds.map((l, i) => {
          const id = seed * 4096 + i;
          const local = t / cycle + hash(id);
          const slot = Math.floor(local), f = local - slot;
          if (hash(id * 7919 + slot) > TWINKLE_CHANCE) return '#000000';
          const k = f < 0.1 ? f / 0.1 : ((1 - f) / 0.9) ** 2; // quick flash, slow fade
          return shade(colors[Math.floor(hash(id * 31 + slot) * colors.length)], k);
        });

      case 'comet': {
        // The head sweeps from just before the start to just past the end, so each pass enters
        // and leaves the rig fully. Each comet takes one cycle to cross; with several at once, a
        // new one sets off every cycle / comets, and where they overlap the brighter one shows.
        const tail = 0.05 + spread * 0.45;
        const span = 1 + tail + COMET_HEAD;
        const comets = cometsOf(look);
        const launches = (t / cycle) * comets, last = Math.floor(launches);
        const heads = [];
        for (let m = last; m > last - comets; m--) {
          heads.push({ head: ((launches - m) / comets) * span - COMET_HEAD, color: colors[((m % colors.length) + colors.length) % colors.length] });
        }
        return leds.map(l => {
          let best = 0, color = colors[0];
          for (const h of heads) {
            const d = h.head + l.p;
            const k = d < 0 ? Math.max(0, 1 + d / COMET_HEAD) : Math.max(0, 1 - d / tail) ** 2;
            if (k > best) { best = k; color = h.color; }
          }
          return shade(color, best);
        });
      }

      case 'noise': {
        // Blob size follows the spread slider; the field drifts along the flow and slowly churns.
        const scale = 3.5 - spread * 2.5;
        const drift = t / (cycle * 2);
        return leds.map(l => {
          const [x, y, z] = l.n;
          const v = fbm(x * scale, y * scale + l.p * 0.3, z * scale + drift);
          return shade(samplePalette(stops, v * 2.2 + drift * 0.15), 1);
        });
      }

      case 'beam': {
        // A beam turns around the middle of each area, leaving a fading trail like a radar screen.
        // `spin` (see spinPosition) is where it reaches each LED, with the empty stretches shortened.
        const width = 0.1 + spread * 0.35;
        const turn = fract(t / cycle);
        const color = samplePalette(stops, t / (cycle * colors.length));
        return leds.map(l => {
          const [a, b] = facing(l);
          const behind = fract(turn - (l.spin ?? Math.atan2(b, a) / (2 * Math.PI))); // 0 at the beam, growing behind it
          return shade(color, behind < width ? (1 - behind / width) ** 1.5 : 0);
        });
      }

      case 'bubbles': {
        // A few bubbles are always growing, each starting at its own moment and place. Each is a
        // bright rim around a softly lit inside, and fades as it grows.
        const radius = 0.35 + spread * 0.65, rim = 0.1;
        const bubbles = Array.from({ length: BUBBLES_AT_ONCE }, (_, j) => {
          const life = t / cycle + j / BUBBLES_AT_ONCE;
          const id = Math.floor(life) * BUBBLES_AT_ONCE + j;
          return { age: fract(life), center: [hash(id * 3) - 0.5, hash(id * 3 + 1) - 0.5], pick: hash(id * 11 + 2), color: colors[Math.floor(hash(id * 7 + 5) * colors.length)] };
        });
        return leds.map(l => {
          const [a, b] = facing(l);
          const out = [0, 0, 0];
          for (const bub of bubbles) {
            // On a light (see anchors in layout.js), so no bubble grows unseen in empty space.
            const center = l.anchors?.length ? l.anchors[Math.floor(bub.pick * l.anchors.length)] : bub.center;
            const r = bub.age * radius, d = Math.hypot(a - center[0], b - center[1]);
            const k = (d < r ? 0.3 + 0.7 * (d / r) ** 4 : Math.max(0, 1 - (d - r) / rim)) * (1 - bub.age);
            for (let c = 0; c < 3; c++) out[c] = Math.max(out[c], bub.color[c] * k);
          }
          return shade(out, 1);
        });
      }

      case 'lightning': {
        // Each area gets its own storm, or the whole rig one when colors travel together: in every
        // time slot a strike may land, flicker and fade.
        const slotLength = cycle / 2;
        const strikeIn = area => {
          const salt = area === 'desk' ? 977 : 0;
          let best = { k: 0, color: colors[0] };
          for (let back = 0; back < 2; back++) {
            const slot = Math.floor(t / slotLength) - back;
            if (hash(slot * 13 + salt) > 0.7) continue;
            const age = t - (slot + hash(slot * 17 + salt) * 0.8) * slotLength;
            if (age < 0) continue;
            const flicker = age < 0.06 ? 1 : age < 0.12 ? 0.25 : 1;
            const k = flicker * Math.exp(-age / (0.25 + spread * 0.6));
            if (k > best.k) best = { k, color: colors[Math.floor(hash(slot * 19 + salt) * colors.length)] };
          }
          return best;
        };
        const strikes = { case: strikeIn('case'), desk: strikeIn('desk') };
        // Strikes land where the flow starts, so the flash is brightest there.
        return leds.map(l => {
          const s = l.face ? strikes.case : strikes[l.area];
          return shade(s.color, s.k * (0.6 + 0.4 * clamp01(1 + l.p)));
        });
      }

      case 'fill': {
        // Each pass fills, empties from the start, then stays dark for a while before the next
        // color. The spread slider sets that dark gap: none, up to twice as long as the fill.
        const gap = spread * 2;
        const pass = t / cycle, n = Math.floor(pass);
        const u = (pass - n) * (2 + gap); // 0..1 filling, 1..2 emptying, then dark
        const color = colors[n % colors.length];
        return leds.map(l => {
          const s = -l.p;
          const k = u < 1 ? clamp01((u * (1 + FILL_EDGE) - s) / FILL_EDGE)
            : u < 2 ? clamp01((s - (u - 1) * (1 + FILL_EDGE) + FILL_EDGE) / FILL_EDGE)
            : 0;
          return shade(color, smooth(k));
        });
      }

      default:
        return leds.map(l => at(l, 0));
    }
  }
}

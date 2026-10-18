// Rig geometry, shared by the server (flow positions) and the browser (drawing and dragging).
//
// A rig has two areas, each with its own frame in centimetres:
//   case: x = rear → front, y = bottom → top, z = motherboard tray → glass
//   desk: x = left → right, y = height above the desk, z = back (wall) → front (you)
//
// Each light lies flat in one plane of its area ('xy', 'xz' or 'yz'). Its LEDs are laid out in
// the light's own 2D frame (u, v), with w along the plane's normal, then rotated by `angle`
// and placed at `pos`.

export const CASE_GAP = 6;        // space between the case and the desk area, in cm
export const DESK_HEIGHT = 75;    // used when the case stands on the floor
const RING_GAP = 2.5;             // distance between the two LED rings of a "duo" fan
const DOT_GAP = 1.2;
const KEY_ASPECT = 1.1;           // keyboard rows are slightly taller than columns are wide

// (u, v, w) in a light's own frame → offset in its area's frame.
export function planeToArea(plane, [u, v, w]) {
  if (plane === 'xz') return [u, w, -v];
  if (plane === 'yz') return [w, v, -u];
  return [u, v, w];
}

// LED positions in the light's own frame, before rotation and placement.
export function ledLayout(light, count, matrix) {
  const order = i => (light.flip ? count - 1 - i : i);
  if (light.shape === 'ring') {
    const rings = count % (light.rings || 1) === 0 ? light.rings || 1 : 1;
    const per = count / rings;
    return Array.from({ length: count }, (_, i) => {
      const ring = Math.floor(i / per);
      const a = Math.PI / 2 - (2 * Math.PI * (order(i) % per)) / per; // clockwise from the top
      return [light.size * Math.cos(a), light.size * Math.sin(a), (ring - (rings - 1) / 2) * RING_GAP];
    });
  }
  if (light.shape === 'bar') {
    return Array.from({ length: count }, (_, i) => [count > 1 ? (order(i) / (count - 1) - 0.5) * light.size : 0, 0, 0]);
  }
  if (light.shape === 'matrix' && matrix) {
    const { width, height, map } = matrix;
    const w = light.size, h = (w * height * KEY_ASPECT) / width;
    const out = Array.from({ length: count }, () => [0, 0, 0]);
    map.forEach((row, y) => row.forEach((led, x) => {
      if (led < count) out[led] = [((x + 0.5) / width - 0.5) * w, (0.5 - (y + 0.5) / height) * h, 0];
    }));
    return out;
  }
  return Array.from({ length: count }, (_, i) => [(order(i) - (count - 1) / 2) * DOT_GAP, 0, 0]);
}

// Bounding size (u, v) of a light's footprint in its own frame, used for drawing its body.
export function lightExtent(light, matrix) {
  if (light.shape === 'ring') return [light.size * 2, light.size * 2];
  if (light.shape === 'matrix' && matrix) return [light.size, (light.size * matrix.height * KEY_ASPECT) / matrix.width];
  if (light.shape === 'bar') return [light.size, 0];
  return [0, 0];
}

// LED positions in the area's frame.
export function ledPositions(light, count, matrix) {
  const a = ((light.angle || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ledLayout(light, count, matrix).map(([u, v, w]) => {
    const [x, y, z] = planeToArea(light.plane, [u * c - v * s, u * s + v * c, w]);
    return [light.pos[0] + x, light.pos[1] + y, light.pos[2] + z];
  });
}

// Where effects treat each LED as being. Usually that is where it really is, but a light lying flat
// (a fan on the case floor, a keyboard on the desk) with `sweep` set is treated as tilted up, standing
// on its own spot: its glass side (on the desk, the side nearest you) becomes its bottom, so effects
// that rise sweep across it instead of lighting it all at once.
export function effectPositions(light, count, matrix) {
  const pos = ledPositions(light, count, matrix);
  if (!light.sweep || light.plane !== 'xz') return pos;
  const [, cy, cz] = light.pos;
  const lift = light.shape === 'ring' ? light.size : Math.max(...pos.map(p => p[2])) - cz;
  return pos.map(([x, y, z]) => [x, cy + lift + (cz - z), cz + (y - cy)]);
}

// Flow positions with the empty stretches between parts shortened, so effects spend their time on
// lights rather than crossing empty space. `keep` is the share of each gap that stays (1 = as
// measured). Steps up to GAP_FLOOR count as part of one light and stay as they are. The empty
// space before the first light and after the last one counts as a gap too, and the result still
// runs from 0 to -1.
export const GAP_FLOOR = 0.03;
export function squeezeGaps(ps, keep) {
  if (keep >= 1 || ps.length < 2) return ps;
  const sorted = [...new Set([0, ...ps, -1])].sort((a, b) => b - a); // p runs from 0 down to -1
  const at = new Map([[sorted[0], 0]]);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i - 1] - sorted[i];
    total += gap > GAP_FLOOR ? GAP_FLOOR + (gap - GAP_FLOOR) * keep : gap;
    at.set(sorted[i], total);
  }
  const scale = total > 0 ? (sorted[0] - sorted.at(-1)) / total : 0;
  return ps.map(p => sorted[0] - at.get(p) * scale);
}

export const areaSize = (rig, area) => (area === 'case' ? rig.case.size : [rig.desk.size[0], 0, rig.desk.size[1]]);

// Where the middle of the case's footprint sits, in cm from the desk area's back-left corner, and
// its turn in degrees (counter-clockwise seen from above). `rig.case.spot` sets it; otherwise the
// case stands beside the desk: on the left with its front toward the desk and glass toward you,
// on the right turned so its glass faces the desk and its front faces you.
export function caseSpot(rig) {
  if (rig.case.spot) return rig.case.spot;
  const [length, , width] = rig.case.size;
  const [deskWidth, deskDepth] = rig.desk.size;
  return rig.case.placement.endsWith('right')
    ? { x: deskWidth + CASE_GAP + width / 2, z: deskDepth / 2, turn: -90 }
    : { x: -(CASE_GAP + length / 2), z: deskDepth / 2, turn: 0 };
}

// Where each area's origin sits in the shared world (y up), and its turn about the vertical axis
// in radians. The desk area is the reference.
export function areaFrames(rig) {
  const [length, , width] = rig.case.size;
  const spot = caseSpot(rig);
  const turn = (spot.turn * Math.PI) / 180, c = Math.cos(turn), s = Math.sin(turn);
  // The case turns around the middle of its footprint, so its corner moves with it.
  const [hx, hz] = [length / 2, width / 2];
  return {
    desk: { origin: [0, rig.case.placement.startsWith('floor') ? DESK_HEIGHT : 0, 0], turn: 0 },
    case: { origin: [spot.x - (hx * c + hz * s), 0, spot.z - (-hx * s + hz * c)], turn },
  };
}

// A point in an area's frame → the shared world, turned and placed exactly as the 3D view does
// (x' = x·cos + z·sin, z' = -x·sin + z·cos about the vertical axis, then moved to the area's origin).
export function areaToWorld(rig, area, [x, y, z]) {
  const { origin, turn } = areaFrames(rig)[area], c = Math.cos(turn), s = Math.sin(turn);
  return [origin[0] + x * c + z * s, origin[1] + y, origin[2] - x * s + z * c];
}

// Smallest box around world points: its corner and its size. Callers subtract `min` before flowPosition.
export function worldBox(points) {
  const min = [0, 1, 2].map(k => Math.min(...points.map(p => p[k])));
  const max = [0, 1, 2].map(k => Math.max(...points.map(p => p[k])));
  return { min, size: max.map((v, k) => v - min[k]) };
}

// Directions colors can travel in, as unit vectors in the area's frame. `null` means outward from
// the center, 'spiral' winds up around the case, and the spins turn around the middle of the view
// people look at (see spinPosition). `rig` is for all lights together, in the
// shared world frame (the desk's axes, y up).
const D = Math.SQRT1_2;
export const FLOWS = {
  case: { up: [0, 1, 0], down: [0, -1, 0], front: [1, 0, 0], rear: [-1, 0, 0], diagonal: [D, D, 0], out: null, spiral: 'spiral', clockwise: 'clockwise', anticlockwise: 'anticlockwise' },
  desk: { right: [1, 0, 0], left: [-1, 0, 0], back: [0, 0, -1], front: [0, 0, 1], out: null, clockwise: 'clockwise', anticlockwise: 'anticlockwise' },
  rig: { up: [0, 1, 0], down: [0, -1, 0], right: [1, 0, 0], left: [-1, 0, 0], front: [0, 0, 1], back: [0, 0, -1], out: null, clockwise: 'clockwise', anticlockwise: 'anticlockwise' },
};

export const SPINS = ['clockwise', 'anticlockwise'];

const SPIRAL_TURNS = 2; // laps around the case from bottom to top

// How far around the case a point is, seen from above: 0..1, one lap.
export function spiralTurn(pos, size) {
  const a = Math.atan2(pos[2] / size[2] - 0.5, pos[0] / size[0] - 0.5) / (2 * Math.PI);
  return a - Math.floor(a);
}

// Palette position of a point: one unit spans the whole area, and colors travel along `dir`.
// For a spiral, it's the distance along a coil that rises around the case. Distance is measured
// from the side the flow starts on, so p is 0 there and falls toward -1 whichever way it runs;
// comet and fill count on that.
export function flowPosition(pos, size, dir) {
  const n = pos.map((v, i) => (size[i] ? v / size[i] : 0.5));
  if (!dir) return -2 * Math.hypot(n[0] - 0.5, n[1] - 0.5, n[2] - 0.5);
  if (dir === 'spiral') return -(n[1] * SPIRAL_TURNS + spiralTurn(pos, size)) / (SPIRAL_TURNS + 1);
  // Divided by the corner-to-corner distance along dir, so a diagonal also ends at -1.
  return -dir.reduce((sum, d, i) => sum + d * (d < 0 ? n[i] - 1 : n[i]), 0) / dir.reduce((sum, d) => sum + Math.abs(d), 0);
}

// How far round a spin flow an LED sits, 0..1, starting straight up like a clock hand. `face` is the
// LED on the view people look at, centered on 0 (across, up); `dir` is 'clockwise' or 'anticlockwise'.
export function spinPosition([a, b], dir) {
  const s = Math.atan2(dir === 'clockwise' ? a : -a, b) / (2 * Math.PI);
  return s - Math.floor(s);
}

// One full palette cycle takes 20 s at speed 0, 1.5 s at 100 and about 0.5 s at MAX_SPEED, on an
// exponential curve. Hardware modes can't go faster than their own top speed, so they cap at 100.
export const MAX_SPEED = 140;
export const cycleSeconds = speed => 20 * Math.pow(0.075, speed / 100);

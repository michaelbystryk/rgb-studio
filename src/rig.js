// The rig: where every light zone sits. Defaults are guessed from what OpenRGB reports; the user's
// edits are stored as per-light overrides in settings.rig.lights.
import { FLOWS } from '../shared/rig-geometry.js';

export const DEFAULT_RIG = {
  case: { size: [45, 47, 22], placement: 'desk-left' },
  desk: { size: [160, 70] },
  props: null, // null = generate a monitor and stand from the devices found
  lights: {},
};
export const PLACEMENTS = ['desk-left', 'desk-right', 'floor-left', 'floor-right'];
export const SHAPES = ['ring', 'bar', 'matrix', 'dots'];
export const PLANES = ['xy', 'xz', 'yz'];
export const BODIES = ['fan', 'ram', 'keyboard', 'mouse', 'headset', null];
const LIGHT_FIELDS = ['area', 'shape', 'pos', 'plane', 'size', 'angle', 'rings', 'flip', 'sweep', 'hidden', 'body', 'label'];

const DESK_TYPES = new Set(['keyboard', 'mouse', 'mousemat', 'headset', 'headset_stand', 'gamepad', 'speaker', 'microphone', 'keypad', 'monitor', 'laptop']);

// A device's stable key survives index changes (e.g. after a rescan). The serial number is the
// best identity; the connection path is the fallback for devices that report none.
export function deviceKeys(devices) {
  const bySerial = devices.map(d => `${d.name}|${d.serial}`);
  return devices.map((d, i) =>
    d.serial && bySerial.indexOf(bySerial[i]) === bySerial.lastIndexOf(bySerial[i]) ? bySerial[i] : `${d.name}|${d.location}`);
}

const TYPE_NAMES = { keyboard: 'Keyboard', mouse: 'Mouse', monitor: 'Monitor', mousemat: 'Mouse pad', headset: 'Headset', headset_stand: 'Headset stand', speaker: 'Speaker', keypad: 'Keypad' };
const fanOf = zone => zone.segments?.find(s => /fan/i.test(s.name)) || (/fan/i.test(zone.name) ? zone : null);
const shortName = d => d.name.replace(/\s*\((Wired|Wireless)\)$/, '');

function labelFor(d, z, nth) {
  const fan = fanOf(z);
  if (fan) return `${(fan.name.match(/\d{3}mm/) || [''])[0]} fan (${z.name.replace(/^Hue 2 /, '')})`.trim();
  if (d.type === 'dram') return `RAM stick ${nth + 1}`;
  if (d.type === 'motherboard') return /mainboard/i.test(z.name) ? 'Motherboard light' : z.name;
  if (DESK_TYPES.has(d.type) && TYPE_NAMES[d.type]) return d.zones.length === 1 ? TYPE_NAMES[d.type] : `${TYPE_NAMES[d.type]} ${z.name.replace(/ zone$/i, '').toLowerCase()}`;
  return d.zones.length === 1 ? shortName(d) : `${shortName(d)}: ${z.name}`;
}

// Fan mounting spots for a case of the given size, in the order fans of each size fill them.
function fanSlots([L, H, W]) {
  const flat = (x, y) => ({ pos: [x, y, W / 2], plane: 'xz' });
  const upright = (x, y) => ({ pos: [x, y, W / 2], plane: 'yz' });
  const slots = {
    'bottom-rear': flat(0.32 * L, 2.5), 'bottom-front': flat(0.66 * L, 2.5),
    rear: upright(2, H - 11),
    'top-rear': flat(0.32 * L, H - 2.5), 'top-front': flat(0.66 * L, H - 2.5),
    'front-top': upright(L - 2, H - 12), 'front-middle': upright(L - 2, H / 2), 'front-bottom': upright(L - 2, 12),
  };
  return {
    slots,
    big: ['bottom-rear', 'bottom-front', 'front-top', 'front-middle', 'front-bottom', 'top-rear', 'top-front'],
    small: ['rear', 'top-rear', 'top-front', 'front-top', 'front-middle', 'front-bottom', 'bottom-rear', 'bottom-front'],
  };
}

// Distance between the outsides of a headset's earcups (matches the model in rig-view.js).
const HEADSET_WIDTH = 19;

// The monitor's middle on the desk; desk lights and props are placed around it.
const monitorX = rig => rig.desk.size[0] * 0.45;

function defaultLight(rig, d, z, ctx) {
  const [L, H, W] = rig.case.size;
  const [DW, DD] = rig.desk.size;
  const mx = monitorX(rig);
  const next = k => (ctx[k] = (ctx[k] ?? -1) + 1);
  const base = { area: 'case', shape: 'dots', pos: [L / 2, H / 2, W / 2], plane: 'xy', size: 0, angle: 0, rings: 1, flip: false, hidden: false, body: null };

  if (DESK_TYPES.has(d.type)) {
    const desk = { ...base, area: 'desk', plane: 'xz' };
    if (d.type === 'keyboard') return { ...desk, shape: z.matrix ? 'matrix' : 'bar', pos: [DW * 0.45, 2, DD * 0.62], size: 44, body: 'keyboard' };
    if (d.type === 'mouse') {
      const k = next('mouseZone');
      return { ...desk, pos: [mx + 38, 3.8, DD * 0.62 - 2 + k * 4], body: k === 0 ? 'mouse' : null };
    }
    // A headset sits where your head is: in front of the desk at ear height, facing the monitor.
    // Its first light is on the outside of the left earcup (where the model is drawn), the rest on
    // the right one.
    if (d.type === 'headset') {
      const k = next('headsetZone');
      return { ...desk, plane: 'yz', pos: [mx + (k === 0 ? -HEADSET_WIDTH : HEADSET_WIDTH) / 2, 30, DD + 16], body: k === 0 ? 'headset' : null };
    }
    if (d.type === 'monitor') {
      // Matched by zone name; anything unrecognized lines up along the back of the screen.
      if (/logo|alien/i.test(z.name)) return { ...desk, plane: 'xy', pos: [mx + 18, 32, 9.5] };
      if (/number|digit/i.test(z.name)) return { ...desk, plane: 'xy', pos: [mx - 18, 32, 9.5] };
      if (/power/i.test(z.name)) return { ...desk, plane: 'xy', pos: [mx + 32, 12, 13.3] };
      return { ...desk, plane: 'xy', pos: [mx - 30 + next('monitorZone') * 10, 45, 9.5] };
    }
    return { ...desk, pos: [15 + next('desk') * 15, 2, DD * 0.4] };
  }

  const fan = fanOf(z);
  if (fan) {
    const big = /14\d|280|420/.test(fan.name);
    const { slots, big: bigOrder, small: smallOrder } = fanSlots(rig.case.size);
    const slot = (big ? bigOrder : smallOrder).find(s => !ctx.usedSlots.has(s));
    const count = z.ledsCount;
    if (!slot) return { ...base, shape: 'ring', size: big ? 6 : 5, body: 'fan' };
    ctx.usedSlots.add(slot);
    return { ...base, ...slots[slot], shape: 'ring', size: big ? 6 : 5, rings: count >= 16 && count % 2 === 0 ? 2 : 1, body: 'fan' };
  }
  // RAM light bars stand upright along the top edge of each stick, facing the glass.
  if (d.type === 'dram') return { ...base, shape: 'bar', pos: [26 + next('ram') * 0.9, H - 14, 4.5], angle: 90, size: 12, body: 'ram' };
  if (d.type === 'motherboard') {
    // Addressable headers report placeholder sizes even when nothing is plugged in.
    if (/addressable|argb|header/i.test(z.name)) return { ...base, hidden: true };
    return { ...base, pos: [6, H - 9, 2] };
  }
  if (d.type === 'gpu') return { ...base, shape: 'bar', pos: [L * 0.5, H * 0.45, 14], size: 24 };
  if (d.type === 'cooler') return { ...base, shape: 'ring', pos: [L * 0.42, H - 15, 7], size: 3.5 };
  if (d.type === 'ledstrip') return { ...base, shape: 'bar', pos: [L / 2, 3 + next('strip') * 4, W - 1], size: L - 6 };
  return { ...base, pos: [L / 2, H / 2 - next('other') * 3, W / 2] };
}

// Every zone of every device as a light: defaults, then the user's overrides.
export function buildLights(devices, keys, rig) {
  const ctx = { usedSlots: new Set() };
  const lights = [];
  // Pass 1: fans placed by the user claim their spots first, so defaults don't land on top of them.
  devices.forEach((d, di) => d.zones.forEach(z => {
    const o = rig.lights[`${keys[di]}#${z.index}`];
    if (o?.pos && fanOf(z)) {
      const { slots } = fanSlots(rig.case.size);
      for (const [name, s] of Object.entries(slots)) if (Math.hypot(...s.pos.map((v, i) => v - o.pos[i])) < 4) ctx.usedSlots.add(name);
    }
  }));
  devices.forEach((d, di) => {
    const nth = ctx[d.type] = (ctx[d.type] ?? -1) + 1;
    d.zones.forEach(z => {
      const key = `${keys[di]}#${z.index}`;
      const def = defaultLight(rig, d, z, ctx);
      lights.push({
        ...def, label: labelFor(d, z, nth), ...(rig.lights[key] || {}),
        key, device: d.index, zone: z.index, type: d.type, count: z.ledsCount, ledStart: z.ledStart,
      });
    });
  });
  return lights;
}

// Boxes that give the scene context (monitor, stand). Purely visual.
export function defaultProps(rig, devices) {
  if (!devices.some(d => d.type === 'monitor')) return [];
  const mx = monitorX(rig);
  return [
    { area: 'desk', label: 'Monitor', pos: [mx, 32, 11.5], size: [72, 42, 3], style: 'screen' },
    { area: 'desk', label: 'Monitor stand', pos: [mx, 12, 8], size: [6, 22, 3], style: 'stand' },
    { area: 'desk', label: 'Monitor foot', pos: [mx, 0.5, 9], size: [26, 1, 16], style: 'stand' },
  ];
}

// ---- validation of user input -------------------------------------------------------------

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return Math.max(lo, Math.min(hi, n));
};
const vec = (v, n, lo, hi) => {
  if (!Array.isArray(v) || v.length !== n) throw new Error('expected a list of ' + n + ' numbers');
  return v.map(x => num(x, lo, hi));
};
const oneOf = (v, list) => {
  if (!list.includes(v)) throw new Error(`expected one of ${list.join(', ')}`);
  return v;
};

// Checks and normalizes a light override; unknown fields are dropped.
export function cleanLight(o) {
  const out = {};
  for (const k of LIGHT_FIELDS) {
    if (o[k] === undefined) continue;
    const v = o[k];
    if (k === 'area') out.area = oneOf(v, ['case', 'desk']);
    else if (k === 'shape') out.shape = oneOf(v, SHAPES);
    else if (k === 'plane') out.plane = oneOf(v, PLANES);
    else if (k === 'body') out.body = oneOf(v, BODIES);
    else if (k === 'pos') out.pos = vec(v, 3, -500, 500);
    else if (k === 'size') out.size = num(v, 0, 200);
    else if (k === 'angle') out.angle = num(v, -360, 360);
    else if (k === 'rings') out.rings = oneOf(Number(v), [1, 2]);
    else if (k === 'flip' || k === 'sweep' || k === 'hidden') out[k] = Boolean(v);
    else if (k === 'label') out.label = String(v).slice(0, 60);
  }
  return out;
}

export function cleanProp(p) {
  return {
    area: oneOf(p.area, ['case', 'desk']),
    label: String(p.label ?? '').slice(0, 60),
    pos: vec(p.pos, 3, -500, 500),
    size: vec(p.size, 3, 0, 500),
    style: oneOf(p.style ?? 'box', ['box', 'screen', 'stand']),
  };
}

export function cleanRigShape(r) {
  const out = {};
  if (r.case) {
    out.case = {};
    if (r.case.size) out.case.size = vec(r.case.size, 3, 10, 150);
    if (r.case.placement) out.case.placement = oneOf(r.case.placement, PLACEMENTS);
    if (r.case.spot === null) out.case.spot = null;
    else if (r.case.spot) {
      const [x, z, turn] = vec([r.case.spot.x, r.case.spot.z, r.case.spot.turn ?? 0], 3, -1000, 1000);
      out.case.spot = { x, z, turn: ((turn % 360) + 540) % 360 - 180 };
    }
  }
  if (r.desk?.size) out.desk = { size: vec(r.desk.size, 2, 20, 400) };
  return out;
}

export const flowNames = area => Object.keys(FLOWS[area]);

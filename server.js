// RGB Studio: a local web UI for OpenRGB.
// `node server.js [--open] [--keep-alive]`, then open http://127.0.0.1:6750
//   --open        open the page in your browser
//   --keep-alive  keep running after the page is closed (normally it exits about 15 s later)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { OpenRGBClient, MODE_FLAG, COLOR_MODE } from './src/openrgb.js';
import { SCENES, MOTIONS, BACKDROP_MOTIONS, MAX_COMETS, renderFrame } from './src/effects.js';
import { isHex } from './src/color.js';
import { deviceKeys, buildLights, defaultProps, cleanLight, cleanProp, cleanRigShape, PLACEMENTS, DEFAULT_RIG } from './src/rig.js';
import { FLOWS, MAX_SPEED, effectPositions, areaSize, areaToWorld, worldBox, flowPosition, spiralTurn, squeezeGaps } from './shared/rig-geometry.js';
import { loadSettings, saveSettings, flushSettings, DEFAULTS } from './src/settings.js';
import { saveToPc, PROFILE } from './src/persist.js';
import { startupStatus, enableStartupProfile } from './src/startup.js';
import { writePlayer } from './src/player-export.js';
import { checkOpenRGB } from './src/setup-check.js';

const PORT = 6750;
const HOST = '127.0.0.1';
const FPS = 20;
const MAX_BACKLOG = 64 * 1024;   // bytes; above this OpenRGB is falling behind, so frames are skipped
const SOLID_RESEND = 5;          // seconds between resends of a static look, in case a device reset
const RECONNECT_DELAY = 3000;
const DESK_EFFECT_HEIGHT = 50;  // cm of height above the desk that 3D effects span
const IDLE_EXIT = 15_000;        // after the last page closes
const FIRST_VISIT_EXIT = 60_000; // if no page ever connects
const ROOT = import.meta.dirname;
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const PLAYER_EXE = path.join(ROOT, 'player', 'RGBStudioPlayer.exe');
const args = new Set(process.argv.slice(2));
const OUTDATED = 'RGB Studio was updated while it was running. Restart it to finish updating.';

const settings = loadSettings();
const save = () => saveSettings(settings);

let client = null;
let status = 'connecting';
let devices = [];
let keys = [];
let lights = [];
let leds = [];        // per device, per LED: { p, n, area } for the effects (see renderFrame)
let frames = {};      // per device index: the colors last rendered
let identify = null;
let paused = false;   // true while "Save to PC" is setting hardware modes
let startup = { available: false, enabled: false };
const sseClients = new Set();
const stats = { sent: 0, skipped: 0 };

const isBuiltIn = d => Boolean(settings.builtIn[keys[d.index]]);
const directModeOf = d =>
  d.modes.find(m => /^direct$/i.test(m.name)) ||
  d.modes.find(m => (m.flags & MODE_FLAG.HAS_PER_LED_COLOR) && m.colorMode === COLOR_MODE.PER_LED);

function broadcast(event, data) {
  if (!sseClients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function publicState() {
  return {
    status,
    stats: { ...stats, backlog: client?.backlog ?? 0 },
    scenes: SCENES,
    motions: MOTIONS,
    backdropMotions: BACKDROP_MOTIONS,
    flows: Object.fromEntries(Object.entries(FLOWS).map(([area, f]) => [area, Object.keys(f)])),
    placements: PLACEMENTS,
    settings,
    looks: settings.looks.map(({ id, name, at, look }) => ({ id, name, at, split: !!look.desk, flow: look.flow })),
    rig: { ...settings.rig, props: settings.rig.props ?? defaultProps(settings.rig, devices) },
    lights,
    startup,
    devices: devices.map(d => ({
      index: d.index, key: keys[d.index], type: d.type, name: d.name, vendor: d.vendor, ledCount: d.leds.length,
      zones: d.zones.map(z => ({ index: z.index, name: z.name, type: z.type, count: z.ledsCount, ledStart: z.ledStart, matrix: z.matrix ?? null })),
      activeMode: d.activeMode,
      modes: d.modes.map(({ value, ...m }) => m),
      builtIn: isBuiltIn(d),
    })),
  };
}
const pushState = () => broadcast('state', publicState());

// Put every scene device into its per-LED "Direct" mode so we can stream colors to it.
function takeControl() {
  for (const d of devices) {
    if (isBuiltIn(d)) continue;
    const direct = directModeOf(d);
    if (direct && d.activeMode !== direct.index) {
      client.updateMode(d.index, direct);
      d.activeMode = direct.index;
    }
  }
}

// Each LED's palette position comes from where its light sits in the rig.
function recomputeLayout() {
  lights = buildLights(devices, keys, settings.rig);
  leds = devices.map(d => Array.from(d.leds, () => ({ p: 0, n: [0.5, 0.5, 0.5], area: 'case' })));
  const placed = { case: [], desk: [] };
  if (settings.flow.together) {
    // One flow over every light, measured in the shared world so it can rise from the case up the monitor.
    const spots = [];
    for (const l of lights) {
      if (l.hidden) continue;
      const z = devices[l.device].zones[l.zone];
      effectPositions(l, l.count, z.matrix).forEach((pos, i) => spots.push({ l, i, world: areaToWorld(settings.rig, l.area, pos) }));
    }
    if (spots.length) {
      const { min, size } = worldBox(spots.map(s => s.world));
      const dir = FLOWS.rig[settings.flow.rig];
      const list = spots.map(({ l, i, world }) => {
        const rel = world.map((v, k) => v - min[k]);
        const led = { p: flowPosition(rel, size, dir), n: rel.map((v, k) => (size[k] ? v / size[k] : 0.5)), area: l.area };
        led.face = [led.n[0] - 0.5, led.n[1] - 0.5]; // the whole rig seen from the front, so one radar or bubble spans it
        leds[l.device][l.ledStart + i] = led;
        return led;
      });
      squeezeGaps(list.map(led => led.p), settings.gaps.rig / 100).forEach((p, i) => { list[i].p = p; });
    }
    lastSolid = null;
    return;
  }
  for (const l of lights) {
    if (l.hidden) continue;
    const z = devices[l.device].zones[l.zone];
    const size = areaSize(settings.rig, l.area);
    const box = l.area === 'desk' ? [size[0], DESK_EFFECT_HEIGHT, size[2]] : size;
    const dir = FLOWS[l.area][settings.flow[l.area]];
    effectPositions(l, l.count, z.matrix).forEach((pos, i) => {
      const led = { p: flowPosition(pos, size, dir), n: pos.map((v, k) => v / box[k]), area: l.area };
      if (dir === 'spiral') led.turn = spiralTurn(pos, size);
      leds[l.device][l.ledStart + i] = led;
      placed[l.area].push(led);
    });
  }
  for (const [area, list] of Object.entries(placed)) {
    squeezeGaps(list.map(led => led.p), settings.gaps[area] / 100).forEach((p, i) => { list[i].p = p; });
  }
  lastSolid = null;
}

// Blink one light white (everything else dark) so the user can see which physical part it is. With
// `start`, light its first LED white and the next few pink instead, so the 3D view and the real part
// can be lined up.
const START_TRAIL = ['#ffffff', '#ff0080', '#a00050', '#500028'];
const IDENTIFY_SECONDS = 4, START_SECONDS = 30;
function applyIdentify(d, colors, t) {
  if (!identify) return colors;
  if (Date.now() > identify.until) { identify = null; return colors; }
  const out = colors.map(() => '#000000');
  const l = lights.find(x => x.key === identify.key);
  if (!l || l.device !== d.index) return out;
  if (identify.start) START_TRAIL.slice(0, l.count).forEach((c, i) => { out[l.ledStart + i] = c; });
  else if (Math.floor(t * 3) % 2 === 0) out.fill('#ffffff', l.ledStart, l.ledStart + l.count);
  return out;
}

// Hidden lights (like empty headers) stay dark.
function maskHidden(d, colors) {
  for (const l of lights) if (l.device === d.index && l.hidden) colors.fill('#000000', l.ledStart, l.ledStart + l.count);
  return colors;
}

// The background player's tracks for a device: its visible LEDs, split by area when the areas
// have their own looks (each loops on its own length).
function playerGroups(d) {
  const visible = lights.filter(l => l.device === d.index && !l.hidden).flatMap(l => Array.from({ length: l.count }, (_, i) => l.ledStart + i));
  if (!settings.desk) return [{ indices: visible, look: settings }];
  return ['case', 'desk'].map(area => ({ indices: visible.filter(i => leds[d.index][i].area === area), look: lookFor(area) }));
}

// What a device shows when you're not using it: your still colors, or the look as it is right now.
// Several still colors make a gradient that runs once from the first to the last across the area.
function stillLook(area) {
  const palette = settings.still.colors[area] || [lookFor(area).palette[0]];
  const repeats = palette.length > 1 ? (palette.length - 1) / palette.length : 1;
  return { motion: 'still', palette, brightness: 100, speed: 0, spread: (100 * (repeats - 0.25)) / 1.75 };
}
function stillFrame(d) {
  if (settings.still.mode === 'snapshot') return [...(frames[d.index] || d.colors)];
  const out = d.leds.map(() => '#000000');
  for (const area of ['case', 'desk']) {
    const idx = [];
    leds[d.index].forEach((led, k) => { if (led.area === area) idx.push(k); });
    if (idx.length) renderFrame(idx.map(k => leds[d.index][k]), stillLook(area), 0, d.index).forEach((c, j) => { out[idx[j]] = c; });
  }
  return maskHidden(d, out);
}

// The look for an area. The desk can have its own; otherwise it shares the case's.
const LOOK_KEYS = ['scene', 'motion', 'palette', 'speed', 'brightness', 'spread', 'background', 'comets'];
const lookFor = area => (area === 'desk' && settings.desk ? { ...settings, ...settings.desk } : settings);

function renderDevice(i, t) {
  if (!settings.desk) return renderFrame(leds[i], settings, t, i);
  const out = new Array(leds[i].length);
  for (const area of ['case', 'desk']) {
    const idx = [];
    leds[i].forEach((led, k) => { if (led.area === area) idx.push(k); });
    if (!idx.length) continue;
    const colors = renderFrame(idx.map(k => leds[i][k]), lookFor(area), t, i);
    idx.forEach((k, j) => { out[k] = colors[j]; });
  }
  return out;
}

let lastSolid = null;
let lastSolidAt = 0;
function tick() {
  if (status !== 'connected' || paused) return;
  const t = Date.now() / 1000;
  // Static looks only need sending once (and now and then, in case a device reset).
  const looks = settings.desk ? [settings, lookFor('desk')] : [settings];
  const solidKey = looks.every(l => l.motion === 'still') && !identify ? JSON.stringify(looks.map(l => [l.palette, l.brightness, l.spread])) : null;
  const send = !solidKey || solidKey !== lastSolid || t - lastSolidAt > SOLID_RESEND;
  // Don't pile up packets if OpenRGB is slow to drain them (SMBus RAM is slow).
  const backlogged = client.backlog > MAX_BACKLOG;
  const sentAll = send && !backlogged;
  devices.forEach((d, i) => {
    if (isBuiltIn(d) || !directModeOf(d)) return;
    const colors = applyIdentify(d, maskHidden(d, renderDevice(i, t)), t);
    frames[d.index] = colors;
    if (!send) return;
    if (backlogged) { stats.skipped++; return; }
    client.updateLeds(d.index, colors);
    stats.sent++;
  });
  if (solidKey && sentAll) { lastSolid = solidKey; lastSolidAt = t; }
}
setInterval(tick, 1000 / FPS);
setInterval(() => broadcast('frame', frames), 1000 / FPS);

async function loadDevices() {
  devices = await client.getControllers();
  keys = deviceKeys(devices);
  frames = {};
  recomputeLayout();
  takeControl();
  pushState();
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY);
}

async function connect() {
  status = 'connecting';
  pushState();
  const c = new OpenRGBClient({ name: 'RGB Studio' });
  try {
    await c.connect();
    client = c;
    status = 'connected';
    c.on('devicesChanged', () => loadDevices().catch(e => console.error('Reloading devices failed:', e.message)));
    c.on('close', () => { if (client === c) { status = 'disconnected'; pushState(); scheduleReconnect(); } });
    c.on('error', () => {}); // 'close' follows and handles it
    await loadDevices();
    console.log(`Connected to OpenRGB (protocol ${c.protocol}), ${devices.length} devices`);
    startup = await startupStatus(c); // newer OpenRGB reports it over the SDK
    pushState();
  } catch (e) {
    c.close();
    if (client === c) client = null;
    status = 'disconnected';
    pushState();
    scheduleReconnect();
  }
}

// ---- input checks ---------------------------------------------------------------------------

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return Math.max(lo, Math.min(hi, n));
};

// Older or hand-edited saved looks can omit fields; keep the current value when one is invalid.
function cleanLook(look, current) {
  const next = structuredClone(Object.fromEntries(LOOK_KEYS.map(k => [k, current[k]])));
  if (!look || typeof look !== 'object' || Array.isArray(look)) return next;
  if (typeof look.scene === 'string' && Object.hasOwn(SCENES, look.scene)) next.scene = look.scene;
  if (MOTIONS.includes(look.motion)) next.motion = look.motion;
  if (Array.isArray(look.palette) && look.palette.length && look.palette.every(isHex)) next.palette = look.palette.slice(0, 8);
  for (const k of ['speed', 'brightness', 'spread', 'background']) if (Number.isFinite(look[k])) next[k] = num(look[k], 0, k === 'speed' ? MAX_SPEED : 100);
  if (Number.isFinite(look.comets)) next.comets = Math.round(num(look.comets, 1, MAX_COMETS));
  return next;
}

// Built-in device effects with their colors, speed and so on, so a saved look can put them back.
function builtInSnapshot() {
  return Object.fromEntries(Object.entries(settings.builtIn).map(([key, entry]) => {
    const m = devices.find(d => keys[d.index] === key)?.modes[entry.mode];
    return [key, m ? { mode: m.index, name: m.name, colors: [...(m.colors || [])], colorMode: m.colorMode, speed: m.speed, brightness: m.brightness, direction: m.direction } : entry];
  }));
}

// Run the built-in effects a look saved; every other device goes back to the scene (takeControl).
function applyBuiltIn(saved) {
  const next = {};
  for (const [key, entry] of Object.entries(saved)) {
    if (!entry || !Number.isInteger(entry.mode)) continue;
    const d = devices.find(x => keys[x.index] === key);
    if (!d || status !== 'connected') { next[key] = { mode: entry.mode }; continue; }
    const m = d.modes[entry.mode];
    if (!m || (typeof entry.name === 'string' && entry.name !== m.name)) continue;
    if (Number.isInteger(entry.colorMode)) m.colorMode = entry.colorMode;
    if (Array.isArray(entry.colors) && entry.colors.length && entry.colors.every(isHex) && m.colorsMax > 0) m.colors = entry.colors.slice(0, m.colorsMax);
    if (Number.isFinite(entry.speed) && (m.flags & MODE_FLAG.HAS_SPEED)) m.speed = num(entry.speed, Math.min(m.speedMin, m.speedMax), Math.max(m.speedMin, m.speedMax));
    if (Number.isFinite(entry.brightness) && (m.flags & MODE_FLAG.HAS_BRIGHTNESS)) m.brightness = num(entry.brightness, m.brightnessMin, m.brightnessMax);
    if (Number.isInteger(entry.direction)) m.direction = entry.direction;
    next[key] = { mode: m.index };
    client.updateMode(d.index, m);
    d.activeMode = m.index;
    delete frames[d.index];
  }
  settings.builtIn = next;
}

const requireConnected = () => { if (status !== 'connected') throw new Error('OpenRGB is not connected'); };
const deviceAt = index => {
  requireConnected();
  const d = devices.find(x => x.index === index);
  if (!d) throw new Error('unknown device');
  return d;
};
const layoutChanged = () => { recomputeLayout(); save(); pushState(); return { ok: true }; };

// ---- API -------------------------------------------------------------------------------------

const routes = {
  'GET /api/state': () => publicState(),
  'GET /api/setup/check': async () => ({ ...await checkOpenRGB(), connected: status === 'connected', devices: devices.length }),
  'POST /api/setup/done': body => {
    settings.setupDone = body.done !== false;
    save();
    pushState();
    return { ok: true };
  },

  'POST /api/quit': (_body, res) => {
    res.once('finish', () => shutdown('asked to quit'));
    return { ok: true };
  },

  // Pick a scene, or tweak the current look. `area: 'desk'` edits the desk's own look (and gives
  // the desk one, starting from the case's); `own: false` makes the desk share the case's again.
  'POST /api/scene': body => {
    if (body.own === false) settings.desk = null;
    else if (body.own === true || body.area === 'desk') settings.desk ??= Object.fromEntries(LOOK_KEYS.map(k => [k, structuredClone(settings[k])]));
    const look = body.area === 'desk' ? settings.desk : settings;
    const scene = SCENES[body.scene];
    if (scene) Object.assign(look, { scene: body.scene, motion: scene.motion, palette: [...scene.palette], background: scene.background ?? 0 });
    if (MOTIONS.includes(body.motion)) look.motion = body.motion;
    if (Array.isArray(body.palette) && body.palette.length && body.palette.every(isHex)) look.palette = body.palette.slice(0, 8);
    for (const k of ['speed', 'brightness', 'spread', 'background']) if (body[k] !== undefined) look[k] = num(body[k], 0, k === 'speed' ? MAX_SPEED : 100);
    if (body.comets !== undefined) look.comets = Math.round(num(body.comets, 1, MAX_COMETS));
    if (status === 'connected') takeControl();
    lastSolid = null;
    save();
    pushState();
    return { ok: true };
  },

  'POST /api/flow': body => {
    if (body.together !== undefined && typeof body.together !== 'boolean') throw new Error('together must be true or false');
    const touchesArea = body.area !== undefined || body.together === undefined; // together alone needs no area
    if (touchesArea) {
      if (!FLOWS[body.area]) throw new Error('unknown area');
      if (body.direction !== undefined && !(body.direction in FLOWS[body.area])) throw new Error('unknown flow direction');
    }
    if (body.together !== undefined) settings.flow = { ...settings.flow, together: body.together };
    if (touchesArea && body.direction !== undefined) settings.flow = { ...settings.flow, [body.area]: body.direction };
    if (touchesArea && body.gaps !== undefined) settings.gaps = { ...settings.gaps, [body.area]: num(body.gaps, 0, 100) };
    return layoutChanged();
  },

  // Save both areas and their flow settings. Reusing a name replaces that look in place.
  'POST /api/looks': body => {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40).trim() : '';
    if (!name) throw new Error('give the look a name');
    const look = structuredClone({ ...Object.fromEntries([...LOOK_KEYS, 'desk', 'flow', 'gaps'].map(k => [k, settings[k]])), builtIn: builtInSnapshot() });
    const index = settings.looks.findIndex(l => l.name.toLowerCase() === name.toLowerCase());
    const entry = { id: index < 0 ? crypto.randomUUID() : settings.looks[index].id, name, at: new Date().toISOString(), look };
    if (index < 0) settings.looks.push(entry);
    else settings.looks[index] = entry;
    save();
    pushState();
    return { ok: true };
  },

  // Switch the editor to a saved look, keeping the rig as it is. Anything the look doesn't record
  // (it was saved before that setting existed) goes back to its default rather than staying as it
  // was, so a look always comes back the same. Looks saved before Together existed were separate.
  'POST /api/looks/load': body => {
    const entry = settings.looks.find(l => l.id === body.id);
    if (!entry || !entry.look || typeof entry.look !== 'object' || Array.isArray(entry.look)) throw new Error('unknown look');
    const look = entry.look;
    const base = Object.fromEntries(LOOK_KEYS.map(k => [k, DEFAULTS[k]]));
    Object.assign(settings, cleanLook(look, base));
    settings.desk = look.desk && typeof look.desk === 'object' && !Array.isArray(look.desk) ? cleanLook(look.desk, base) : null;
    settings.flow = { ...settings.flow, together: look.flow?.together === true };
    settings.gaps = { ...settings.gaps };
    for (const area of ['case', 'desk', 'rig']) {
      const direction = look.flow?.[area];
      settings.flow[area] = typeof direction === 'string' && Object.hasOwn(FLOWS[area], direction) ? direction : DEFAULTS.flow[area];
      settings.gaps[area] = Number.isFinite(look.gaps?.[area]) ? num(look.gaps[area], 0, 100) : DEFAULTS.gaps[area];
    }
    if (look.builtIn && typeof look.builtIn === 'object' && !Array.isArray(look.builtIn)) applyBuiltIn(look.builtIn);
    recomputeLayout();
    if (status === 'connected') takeControl();
    lastSolid = null;
    save();
    pushState();
    return { ok: true };
  },

  // Remove a saved look without changing the one showing in the editor.
  'POST /api/looks/delete': body => {
    const index = settings.looks.findIndex(l => l.id === body.id);
    if (index < 0) throw new Error('unknown look');
    settings.looks.splice(index, 1);
    save();
    pushState();
    return { ok: true };
  },

  // Hand a device back to the scene, or give it a built-in hardware effect.
  'POST /api/device': body => {
    const d = deviceAt(body.index);
    const key = keys[d.index];
    if (body.mode === undefined || body.mode === null) {
      delete settings.builtIn[key];
      takeControl();
    } else {
      const m = d.modes[body.mode];
      if (!m) throw new Error('unknown mode');
      if (Array.isArray(body.colors) && body.colors.length && body.colors.every(isHex) && m.colorsMax > 0) {
        m.colors = body.colors.slice(0, m.colorsMax);
        m.colorMode = COLOR_MODE.MODE_SPECIFIC;
      }
      if (body.speed !== undefined && (m.flags & MODE_FLAG.HAS_SPEED)) m.speed = num(body.speed, Math.min(m.speedMin, m.speedMax), Math.max(m.speedMin, m.speedMax));
      if (body.brightness !== undefined && (m.flags & MODE_FLAG.HAS_BRIGHTNESS)) m.brightness = num(body.brightness, m.brightnessMin, m.brightnessMax);
      settings.builtIn[key] = { mode: m.index };
      client.updateMode(d.index, m);
      d.activeMode = m.index;
      delete frames[d.index];
    }
    save();
    pushState();
    return { ok: true };
  },

  'POST /api/rescan': () => { requireConnected(); client.rescan(); return { ok: true }; },

  // Move or reshape one light. `patch` holds any light fields; `reset` drops the user's edits.
  'POST /api/light': body => {
    const l = lights.find(x => x.key === body.key);
    if (!l) throw new Error('unknown light');
    if (body.reset) delete settings.rig.lights[l.key];
    else settings.rig.lights[l.key] = { ...settings.rig.lights[l.key], ...cleanLight(body.patch || {}) };
    // Keep showing the first LEDs while the user turns the light to line it up.
    if (identify?.start && identify.key === l.key) identify.until = Date.now() + START_SECONDS * 1000;
    return layoutChanged();
  },

  // Case size, placement and spot, desk size. Picking a placement puts the case back beside the desk.
  'POST /api/rig': body => {
    const shape = cleanRigShape(body);
    if (shape.case?.placement && !('spot' in shape.case)) shape.case.spot = null;
    if (shape.case) settings.rig.case = { ...settings.rig.case, ...shape.case };
    if (shape.desk) settings.rig.desk = { ...settings.rig.desk, ...shape.desk };
    return layoutChanged();
  },

  // A whole rig file (see docs/rig-format.md), e.g. one written by Claude from the shared prompt.
  'POST /api/rig/import': body => {
    const r = body.rig;
    if (!r || typeof r !== 'object') throw new Error('expected { rig: {...} }');
    const shape = cleanRigShape(r);
    const next = {
      case: { ...settings.rig.case, ...shape.case },
      desk: { ...settings.rig.desk, ...shape.desk },
      props: Array.isArray(r.props) ? r.props.map(cleanProp) : null,
      lights: {},
    };
    const known = new Set(lights.map(l => l.key));
    for (const [key, o] of Object.entries(r.lights || {})) if (known.has(key)) next.lights[key] = cleanLight(o);
    settings.rig = next;
    return layoutChanged();
  },

  'POST /api/rig/reset': () => {
    settings.rig = structuredClone(DEFAULT_RIG);
    return layoutChanged();
  },

  'POST /api/identify': body => {
    if (!lights.some(x => x.key === body.key)) throw new Error('unknown light');
    identify = { key: body.key, start: !!body.start, until: Date.now() + (body.start ? START_SECONDS : IDENTIFY_SECONDS) * 1000 };
    return { ok: true };
  },

  // Record the looks for the background player, and store the still colors on the PC itself (in
  // device memory where possible, and as an OpenRGB profile) for when nothing is running.
  'POST /api/save': async body => {
    requireConnected();
    if (body.still) {
      const { mode, colors = {} } = body.still;
      settings.still = {
        mode: mode === 'snapshot' ? 'snapshot' : 'custom',
        colors: Object.fromEntries(['case', 'desk'].map(a => {
          const c = colors[a];
          return [a, Array.isArray(c) && c.length && c.every(isHex) ? c.slice(0, 8) : settings.still.colors[a]];
        })),
      };
    }
    const player = writePlayer({ devices, groups: playerGroups, render: (d, t) => maskHidden(d, renderDevice(d.index, t)), control: d => (isBuiltIn(d) || !directModeOf(d) ? null : client.modeBody(directModeOf(d))), still: stillFrame });
    const stillFrames = Object.fromEntries(devices.map(d => [d.index, stillFrame(d)]));
    paused = true;
    try {
      const results = await saveToPc(client, { devices, frames: stillFrames, lights, lookFor, style: 'still', isBuiltIn });
      settings.saved = { at: new Date().toISOString(), style: 'player' };
      save();
      startup = await startupStatus(client);
      return { ok: true, profile: PROFILE, results, startup, player: { ...player, built: fs.existsSync(PLAYER_EXE) } };
    } finally {
      // OpenRGB writes the profile on a background thread, so give it a moment before taking the
      // devices back. Live control resumes; the saved profile is restored when RGB Studio exits.
      setTimeout(() => {
        paused = false;
        if (status !== 'connected') return;
        devices.forEach(d => { d.activeMode = -1; });
        takeControl();
        pushState();
      }, 1500);
    }
  },

  // Start the background player. It waits while this editor is open, then takes over.
  'POST /api/player': () => {
    if (!fs.existsSync(PLAYER_EXE)) throw new Error('The player isn’t built yet: run player\\build.cmd');
    spawn(PLAYER_EXE, [], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },

  'POST /api/startup-profile': async () => {
    startup = await enableStartupProfile(client);
    pushState();
    return { ok: true, startup };
  },
};

// ---- HTTP ------------------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

// Only this page may drive the API: blocks other websites (CSRF) and DNS-rebinding tricks.
function allowed(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  if (req.method !== 'POST') return true;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return (req.headers['content-type'] || '').startsWith('application/json');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, root, rel) {
  const file = path.join(root, path.normalize('/' + rel));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    pageOpened();
    req.on('close', () => { sseClients.delete(res); if (!sseClients.size) pagesClosed(); });
    return;
  }

  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try {
      const out = await route(req.method === 'POST' ? await readBody(req) : {}, res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: OUTDATED }));
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const p = url.pathname;
  // Three.js is served straight from node_modules so everything works offline.
  if (p.startsWith('/vendor/three/')) return serveFile(res, THREE_DIR, p.slice('/vendor/three/'.length));
  if (p.startsWith('/shared/')) return serveFile(res, SHARED, p.slice('/shared/'.length));
  serveFile(res, PUBLIC, p === '/' ? 'index.html' : p);
});

// ---- lifetime --------------------------------------------------------------------------------

let exitTimer = null;
function pageOpened() { clearTimeout(exitTimer); exitTimer = null; }
function pagesClosed(delay = IDLE_EXIT) {
  if (args.has('--keep-alive')) return;
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => shutdown('the page was closed'), delay);
}

// Hand the lights back to OpenRGB's saved profile on the way out, so they keep their saved look.
async function shutdown(reason) {
  console.log(`Stopping (${reason}).`);
  try {
    if (settings.saved && client?.connected) {
      await client.loadProfile(PROFILE);
    }
  } catch {}
  flushSettings(settings);
  client?.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('asked to stop'));

function openBrowser() {
  const url = `http://${HOST}:${PORT}`;
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log('RGB Studio is already running.');
  if (args.has('--open')) openBrowser();
  process.exit(0);
});
server.listen(PORT, HOST, async () => {
  console.log(`RGB Studio running at http://${HOST}:${PORT}`);
  startup = await startupStatus(client);
  connect();
  if (args.has('--open')) openBrowser();
  pagesClosed(FIRST_VISIT_EXIT);
});

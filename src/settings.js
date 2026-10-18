// Per-user settings: the current look, the rig layout and what was last saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENES } from './effects.js';
import { DEFAULT_RIG } from './rig.js';

const DATA_DIR = process.env.RGB_STUDIO_DATA || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'RGB Studio')
  : path.join(os.homedir(), '.config', 'rgb-studio'));
const FILE = path.resolve(DATA_DIR, 'settings.json');
const LEGACY_FILE = path.join(import.meta.dirname, '..', 'settings.json');
const WRITE_DELAY = 300;

export const DEFAULTS = {
  setupDone: false,
  scene: 'cyberpunk',
  palette: SCENES.cyberpunk.palette,
  motion: SCENES.cyberpunk.motion,
  speed: 40,
  brightness: 100,
  spread: 50,
  background: 0, // how bright the dark parts of effects like comet are
  comets: 1, // comets in flight at once, for the comet motion
  desk: null, // the desk's own look ({ scene, motion, palette, … }), or null to share the case's
  flow: { case: 'up', desk: 'right', rig: 'up', together: false }, // together: one flow across every light
  gaps: { case: 100, desk: 100, rig: 100 }, // how much of the empty space between parts effects cross, in %
  looks: [], // named looks to switch between in the editor
  rig: DEFAULT_RIG,
  builtIn: {}, // device key → { mode } for devices running their own hardware effect
  // The lights when you're not using them: the player's "Still colors", and what OpenRGB shows when
  // nothing is running. Each area has one color or a gradient; null means the first color of its look.
  still: { mode: 'custom', colors: { case: null, desk: null } },
  saved: null, // { at, style } after "Save to PC"
};

export function loadSettings() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) {
    try {
      // Copy once, without overwriting another instance's settings or changing the legacy file.
      fs.copyFileSync(LEGACY_FILE, FILE, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EEXIST') console.warn(`Could not migrate settings.json: ${e.message}`);
    }
  }
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Ignoring unreadable settings.json: ${e.message}`);
  }
  const rig = { ...DEFAULT_RIG, ...stored.rig };
  const settings = {
    ...DEFAULTS, ...stored,
    setupDone: typeof stored.setupDone === 'boolean' ? stored.setupDone : Boolean(Object.keys(stored.rig?.lights || {}).length || stored.saved || stored.looks?.length),
    looks: Array.isArray(stored.looks) ? stored.looks.filter(l =>
      l && typeof l.id === 'string' && typeof l.name === 'string' && typeof l.at === 'string' &&
      l.look && typeof l.look === 'object' && !Array.isArray(l.look)) : [],
    flow: { ...DEFAULTS.flow, ...stored.flow },
    gaps: { ...DEFAULTS.gaps, ...stored.gaps },
    still: { ...DEFAULTS.still, ...stored.still, colors: stillColors(stored.still?.colors) },
    rig: { ...rig, case: { ...DEFAULT_RIG.case, ...rig.case }, desk: { ...DEFAULT_RIG.desk, ...rig.desk }, lights: { ...rig.lights } },
  };
  if (!fs.existsSync(FILE)) flushSettings(settings);
  return settings;
}

// Older settings kept a single color per area.
function stillColors(stored = {}) {
  const list = v => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : null);
  return { case: list(stored.case), desk: list(stored.desk) };
}

// Writes are batched and atomic, so a crash mid-write can't leave a half-written file.
let timer = null;
export function saveSettings(settings) {
  clearTimeout(timer);
  timer = setTimeout(() => flushSettings(settings), WRITE_DELAY);
}

export function flushSettings(settings) {
  clearTimeout(timer);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, FILE);
}

// settings.json next to server.js: the current look, the rig layout and what was last saved.
import fs from 'node:fs';
import path from 'node:path';
import { SCENES } from './effects.js';
import { DEFAULT_RIG } from './rig.js';

const FILE = path.join(import.meta.dirname, '..', 'settings.json');
const WRITE_DELAY = 300;

export const DEFAULTS = {
  scene: 'cyberpunk',
  palette: SCENES.cyberpunk.palette,
  motion: SCENES.cyberpunk.motion,
  speed: 40,
  brightness: 100,
  spread: 50,
  background: 0, // how bright the dark parts of effects like comet are
  flow: { case: 'up', desk: 'right' },
  gaps: { case: 100, desk: 100 }, // how much of the empty space between parts effects cross, in %
  rig: DEFAULT_RIG,
  builtIn: {}, // device key → { mode } for devices running their own hardware effect
  saved: null, // { at, style } after "Save to PC"
};

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Ignoring unreadable settings.json: ${e.message}`);
  }
  const rig = { ...DEFAULT_RIG, ...stored.rig };
  return {
    ...DEFAULTS, ...stored,
    flow: { ...DEFAULTS.flow, ...stored.flow },
    gaps: { ...DEFAULTS.gaps, ...stored.gaps },
    rig: { ...rig, case: { ...DEFAULT_RIG.case, ...rig.case }, desk: { ...DEFAULT_RIG.desk, ...rig.desk }, lights: { ...rig.lights } },
  };
}

// Writes are batched and atomic, so a crash mid-write can't leave a half-written file.
let timer = null;
export function saveSettings(settings) {
  clearTimeout(timer);
  timer = setTimeout(() => flushSettings(settings), WRITE_DELAY);
}

export function flushSettings(settings) {
  clearTimeout(timer);
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, FILE);
}

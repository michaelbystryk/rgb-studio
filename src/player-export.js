// Records the current looks for the background player (player/), which plays them with nothing
// else running. See docs/player-format.md for the files it writes.
import fs from 'node:fs';
import path from 'node:path';
import { cycleSeconds } from '../shared/rig-geometry.js';
import { hexToRgb } from './color.js';

export const PLAYER_DIR = path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.config'), 'RGB Studio');
export const PLAYER_FPS = 20;

// How many cycles each motion takes to come back to where it started. Motions missing here never
// repeat exactly, so they're recorded for a while and the end fades into the start.
const CYCLES_PER_LOOP = { flow: 1, bounce: 2, breathe: 4, comet: 'colors', beam: 'colors', fill: 'colors' };
const RANDOM_LOOP = { min: 20, cycles: 8, max: 60 }; // seconds, cycles, seconds
const FADE = 1.5;                                     // seconds of crossfade on a random loop

function loopOf(look) {
  if (look.motion === 'still') return { seconds: 0, exact: true };
  const cycle = cycleSeconds(look.speed);
  const n = CYCLES_PER_LOOP[look.motion];
  if (n) return { seconds: cycle * (n === 'colors' ? look.palette.length : n), exact: true };
  return { seconds: Math.min(RANDOM_LOOP.max, Math.max(RANDOM_LOOP.min, cycle * RANDOM_LOOP.cycles)), exact: false };
}

const mix = (a, b, w) => a.map((v, c) => Math.round(v + (b[c] - v) * w));

// One track: the given LEDs of a device over one loop of `look`. render(t) gives the device's colors.
function bakeTrack(indices, look, render) {
  const { seconds, exact } = loopOf(look);
  const frames = Math.max(1, Math.round(seconds * PLAYER_FPS));
  const fade = exact ? 0 : Math.min(FADE, seconds / 4);
  const data = Buffer.alloc(frames * indices.length * 3);
  let o = 0;
  for (let k = 0; k < frames; k++) {
    const t = (k * seconds) / frames;
    const now = render(t);
    // The last moments blend into what came just before the start, so frame 0 follows on smoothly.
    const w = fade && t > seconds - fade ? (t - (seconds - fade)) / fade : 0;
    const before = w ? render(t - seconds) : null;
    for (const i of indices) {
      const rgb = before ? mix(hexToRgb(now[i]), hexToRgb(before[i]), w) : hexToRgb(now[i]);
      data[o++] = rgb[0]; data[o++] = rgb[1]; data[o++] = rgb[2];
    }
  }
  return { indices, frames, data };
}

// devices: OpenRGB controllers; groups(d) → [{ indices, look }] of the device's visible LEDs;
// render(d, t) → its colors; control(d) → mode packet body or null; still(d) → hex color per LED.
export function writePlayer({ devices, groups, render, control, still }, dir = PLAYER_DIR) {
  const meta = { version: 1, fps: PLAYER_FPS, savedAt: new Date().toISOString(), devices: [] };
  const chunks = [];
  let offset = 0;
  for (const d of devices) {
    const body = control(d);
    const tracks = [];
    if (body) {
      for (const { indices, look } of groups(d)) {
        if (!indices.length) continue;
        const track = bakeTrack(indices, look, t => render(d, t));
        tracks.push({ leds: indices, frames: track.frames, offset });
        chunks.push(track.data);
        offset += track.data.length;
      }
    }
    meta.devices.push({
      name: d.name, location: d.location, ledCount: d.leds.length,
      control: body ? body.toString('base64') : null,
      tracks,
      still: Buffer.from(still(d).flatMap(hexToRgb)).toString('base64'),
    });
  }
  fs.mkdirSync(dir, { recursive: true });
  // The player reloads when player.json changes, so the frames it points into go first.
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file + '.tmp', content);
    fs.renameSync(file + '.tmp', file);
  };
  write('player.bin', Buffer.concat(chunks));
  write('player.json', JSON.stringify(meta));
  return { dir, bytes: offset, devices: meta.devices.filter(d => d.tracks.length).map(d => d.name) };
}

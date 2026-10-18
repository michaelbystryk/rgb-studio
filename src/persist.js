// "Save to PC": puts every device into a mode it can run on its own, stores it on the device where
// it supports that, and saves an OpenRGB profile so OpenRGB can restore everything without us.
import { MODE_FLAG, COLOR_MODE, DIRECTION } from './openrgb.js';
import { pickDistinct, scaleHex } from './color.js';

export const PROFILE = 'RGB Studio';

// Built-in effects that look like each motion, best match first.
const LOOKALIKES = {
  flow: [/wave/i, /marquee|chase/i, /shift|fading|flow|cycle/i, /visor|rain/i, /pulse|breath/i],
  bounce: [/visor|scanner/i, /wave/i, /marquee|chase/i, /shift|fading/i],
  breathe: [/breath/i, /pulse/i, /fading/i, /shift/i],
  twinkle: [/starry|twinkle|sparkle/i, /rain/i, /flash/i, /fading/i],
  comet: [/marquee|chase/i, /rain/i, /visor/i, /wave/i],
  noise: [/fading|shift/i, /wave/i, /breath|pulse/i],
  beam: [/marquee|chase|spin/i, /wave/i],
  bubbles: [/pulse|breath/i, /fading/i, /rain/i],
  lightning: [/flash|strobe|blink/i, /starry/i, /pulse/i],
  fill: [/fill|stack/i, /marquee|chase/i, /wave/i],
};
// Effects that don't fit any look (random flicker, alternating halves).
const NEVER = /alternating|candle|random|reactive|rainbow|spectrum|direct|custom|static|off/i;

const has = (m, flag) => (m.flags & flag) !== 0;
const scale = (lo, hi, pct) => Math.round(lo + ((hi - lo) * pct) / 100);
const isDirect = m => /^direct$/i.test(m.name);

function movingMode(d, look) {
  const ranks = LOOKALIKES[look.motion] || LOOKALIKES.flow;
  let best = null, bestScore = Infinity;
  for (const m of d.modes) {
    if (NEVER.test(m.name)) continue;
    const specific = has(m, MODE_FLAG.HAS_MODE_SPECIFIC_COLOR) && m.colorsMax > 0;
    const perLed = has(m, MODE_FLAG.HAS_PER_LED_COLOR);
    if (!specific && !perLed) continue;
    const rank = ranks.findIndex(re => re.test(m.name));
    if (rank < 0) continue;
    // Prefer modes that can show two or more palette colors.
    const score = rank + (specific && m.colorsMax >= 2 ? 0 : 10);
    if (score < bestScore) { best = m; bestScore = score; }
  }
  return best;
}

function directionFor(m, look, area) {
  const dir = look.flow[area];
  if (has(m, MODE_FLAG.HAS_DIRECTION_UD) && ['up', 'down', 'spiral'].includes(dir)) return dir === 'down' ? DIRECTION.DOWN : DIRECTION.UP;
  if (has(m, MODE_FLAG.HAS_DIRECTION_LR)) {
    if (dir === 'right' || dir === 'front') return DIRECTION.RIGHT;
    if (dir === 'left' || dir === 'rear') return DIRECTION.LEFT;
  }
  return m.direction;
}

// Configure one hardware mode from the look. Returns the LED colors to send, if the mode uses them.
function configureMode(m, look, frame) {
  const pct = look.brightness;
  if (has(m, MODE_FLAG.HAS_SPEED)) m.speed = scale(m.speedMin, m.speedMax, look.speed);
  const dimInColor = !has(m, MODE_FLAG.HAS_BRIGHTNESS);
  if (!dimInColor) m.brightness = scale(m.brightnessMin, m.brightnessMax, pct);
  if (has(m, MODE_FLAG.HAS_MODE_SPECIFIC_COLOR) && m.colorsMax > 0) {
    const n = Math.max(m.colorsMin, Math.min(m.colorsMax, 8, look.palette.length));
    let colors = pickDistinct(look.palette, n);
    while (colors.length < n) colors = colors.concat(colors).slice(0, n);
    m.colors = colors.map(c => (dimInColor ? scaleHex(c, pct / 100) : c));
    m.colorMode = COLOR_MODE.MODE_SPECIFIC;
    return null;
  }
  m.colorMode = COLOR_MODE.PER_LED;
  return frame;
}

function stillMode(d, frame, visible) {
  const colors = visible.map(i => frame[i]);
  const uniform = colors.every(c => c === colors[0]);
  // Per-LED modes the device keeps by itself hold the exact gradient.
  const custom = d.modes.find(m => !isDirect(m) && has(m, MODE_FLAG.HAS_PER_LED_COLOR) && (has(m, MODE_FLAG.MANUAL_SAVE) || has(m, MODE_FLAG.AUTOMATIC_SAVE)));
  if (custom) return { mode: custom, leds: frame };
  const stat = d.modes.find(m => /^static$/i.test(m.name) && has(m, MODE_FLAG.HAS_MODE_SPECIFIC_COLOR));
  // A handful of LEDs (like a motherboard logo) loses little by becoming one color the device can store.
  if (stat && colors.length && (uniform || (colors.length <= 3 && has(stat, MODE_FLAG.MANUAL_SAVE)))) {
    stat.colors = Array(Math.max(1, stat.colorsMin)).fill(colors[Math.floor(colors.length / 2)]);
    stat.colorMode = COLOR_MODE.MODE_SPECIFIC;
    return { mode: stat, leds: null };
  }
  const direct = d.modes.find(isDirect) || d.modes.find(m => has(m, MODE_FLAG.HAS_PER_LED_COLOR));
  return direct ? { mode: direct, leds: frame } : null;
}

const storedOn = m => (has(m, MODE_FLAG.MANUAL_SAVE) || has(m, MODE_FLAG.AUTOMATIC_SAVE) ? 'device' : 'profile');

// devices: OpenRGB controllers; frames: current colors per device index; lights: built rig lights.
export async function saveToPc(client, { devices, frames, lights, lookFor, style, isBuiltIn }) {
  const results = [];
  for (const d of devices) {
    const frame = frames[d.index] || d.colors;
    const mine = lights.filter(l => l.device === d.index);
    const visible = mine.filter(l => !l.hidden).flatMap(l => Array.from({ length: l.count }, (_, i) => l.ledStart + i));
    const area = mine.find(l => !l.hidden)?.area || 'case';
    const look = lookFor(area);

    if (isBuiltIn(d)) {
      const m = d.modes[d.activeMode];
      if (m && has(m, MODE_FLAG.MANUAL_SAVE)) client.saveMode(d.index, m);
      results.push({ device: d.name, mode: m?.name ?? '?', stored: m ? storedOn(m) : 'profile', note: 'its own built-in effect' });
      continue;
    }
    if (!visible.length) continue;

    let pick = null;
    if (style === 'moving' && look.motion !== 'still') {
      const m = movingMode(d, look);
      if (m) {
        m.direction = directionFor(m, look, area);
        pick = { mode: m, leds: configureMode(m, look, frame) };
      }
    }
    pick ||= stillMode(d, frame, visible);
    if (!pick) continue;

    client.updateMode(d.index, pick.mode);
    d.activeMode = pick.mode.index;
    if (pick.leds) client.updateLeds(d.index, pick.leds);
    if (has(pick.mode, MODE_FLAG.MANUAL_SAVE)) client.saveMode(d.index, pick.mode);
    results.push({
      device: d.name, mode: pick.mode.name, stored: storedOn(pick.mode),
      note: style === 'moving' && look.motion !== 'still' && !LOOKALIKES[look.motion]?.some(re => re.test(pick.mode.name)) ? 'no matching effect, so a still snapshot' : null,
    });
  }

  // Requests are answered in order, so once this returns OpenRGB has applied everything above.
  await client.getProfiles();
  client.saveProfile(PROFILE);
  const profiles = await client.getProfiles();
  if (!profiles.includes(PROFILE)) throw new Error('OpenRGB did not save the profile');
  return results;
}

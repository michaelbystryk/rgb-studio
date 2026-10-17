// Color helpers: '#rrggbb' strings, [r, g, b] in 0-255, and [h, s, v] with h in degrees.

export const hexToRgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const rgbToHex = rgb =>
  '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export const isHex = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

export const scaleHex = (hex, k) => rgbToHex(hexToRgb(hex).map(v => v * k));

export function rgbToHsv([r, g, b]) {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max / 255];
}

export function hsvToRgb([h, s, v]) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return 255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

// Sample a looping palette (as HSV stops) at t in [0, 1). Blends the shortest way around the hue
// wheel so e.g. blue → purple stays saturated instead of washing out toward white.
export function samplePalette(stops, t) {
  const n = stops.length;
  if (n === 1) return hsvToRgb(stops[0]);
  t = ((t % 1) + 1) % 1;
  const f = t * n, i = Math.floor(f), k = f - i;
  const a = stops[i % n], b = stops[(i + 1) % n];
  const e = k * k * (3 - 2 * k); // smoothstep, so the blend doesn't look banded
  // Grey and black stops have no hue; borrow the other stop's so they fade without a color sweep.
  const ha = a[1] ? a[0] : b[0], hb = b[1] ? b[0] : a[0];
  let dh = hb - ha;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  return hsvToRgb([(ha + dh * e + 360) % 360, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e]);
}

const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Pick `n` palette colors that are as far apart in hue as possible, keeping the first.
export function pickDistinct(palette, n) {
  if (palette.length <= n) return [...palette];
  const hues = palette.map(c => rgbToHsv(hexToRgb(c))[0]);
  const picked = [0];
  while (picked.length < n) {
    let best = -1, bestDist = -1;
    hues.forEach((h, i) => {
      if (picked.includes(i)) return;
      const d = Math.min(...picked.map(j => hueDistance(h, hues[j])));
      if (d > bestDist) { best = i; bestDist = d; }
    });
    picked.push(best);
  }
  return picked.sort((a, b) => a - b).map(i => palette[i]);
}

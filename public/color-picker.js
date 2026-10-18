// A color picker that stays in the page instead of opening the system color dialog: a
// saturation/brightness square, a hue strip, a hex box, your recent colors and a few quick picks.
const RECENT_KEY = 'rgbstudio.recentColors';
const RECENT_MAX = 16;
const QUICK = ['#ff0000', '#ff5a00', '#ffb800', '#ffff00', '#00ff40', '#00ffc8', '#00b3ff', '#0040ff',
  '#5000ff', '#a000ff', '#ff00d0', '#ff2b6e', '#ffffff', '#ffc890', '#000000'];

const isHex = s => /^#[0-9a-f]{6}$/i.test(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToHex([h, s, v]) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return v - v * s * clamp(Math.min(k, 4 - k), 0, 1);
  };
  return '#' + [5, 3, 1].map(n => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('');
}

// Browser storage can be unavailable (private windows, blocked site data); recents are a nicety.
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)).filter(isHex).slice(0, RECENT_MAX); } catch { return []; }
}
function remember(hex) {
  const list = [hex, ...loadRecent().filter(c => c !== hex)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

const make = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, attrs);

// One popover, shared by every swatch. It's moved into the swatch's dialog when there is one, so a
// modal dialog doesn't make it inert.
let pop = null;
let active = null; // { swatch, hsv, start }

function build() {
  pop = make('div', 'cp');
  pop.popover = 'manual';
  const sv = make('div', 'cp-sv');
  const knob = make('div', 'cp-knob');
  sv.append(knob);
  const hue = make('input', 'cp-hue', { type: 'range', min: 0, max: 359, step: 1, ariaLabel: 'Hue' });
  const now = make('span', 'cp-now');
  const hex = make('input', 'cp-hex', { spellcheck: false, maxLength: 7, ariaLabel: 'Hex color' });
  const row = make('div', 'cp-row');
  row.append(now, hex);
  const recentLabel = make('div', 'cp-label', { textContent: 'Recent' });
  const recent = make('div', 'cp-grid cp-recent');
  const quick = make('div', 'cp-grid');
  for (const c of QUICK) quick.append(chip(c));
  pop.append(sv, hue, row, recentLabel, recent, make('div', 'cp-label', { textContent: 'Quick picks' }), quick);

  pop.draw = () => {
    const [h, s, v] = active.hsv;
    const c = hsvToHex(active.hsv);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex([h, 1, 1])})`;
    knob.style.left = `${s * 100}%`;
    knob.style.top = `${(1 - v) * 100}%`;
    knob.style.background = c;
    hue.value = Math.round(h);
    now.style.background = c;
    if (document.activeElement !== hex) hex.value = c;
  };
  pop.drawRecent = () => {
    const list = loadRecent();
    recentLabel.hidden = recent.hidden = !list.length;
    recent.replaceChildren(...list.map(chip));
  };

  const set = (hsv, fromHex) => {
    active.hsv = hsv;
    const c = hsvToHex(hsv);
    active.swatch.setColor(c);
    pop.draw();
    if (!fromHex) hex.value = c;
    active.swatch.onInput?.(c);
  };
  const fromPointer = e => {
    const r = sv.getBoundingClientRect();
    set([active.hsv[0], clamp((e.clientX - r.left) / r.width, 0, 1), 1 - clamp((e.clientY - r.top) / r.height, 0, 1)]);
  };
  sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); fromPointer(e); });
  sv.addEventListener('pointermove', e => { if (sv.hasPointerCapture(e.pointerId)) fromPointer(e); });
  // Moving the hue of a grey or black would change nothing, so it turns the color on fully.
  hue.addEventListener('input', () => set([+hue.value, active.hsv[1] || 1, active.hsv[2] || 1]));
  hex.addEventListener('input', () => {
    const v = hex.value.trim().replace(/^#?/, '#');
    if (isHex(v)) set(hexToHsv(v.toLowerCase()), true);
  });
  hex.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); close(); } });

  function chip(c) {
    const b = make('button', 'cp-chip', { type: 'button', title: c });
    b.style.background = c;
    b.addEventListener('click', () => set(hexToHsv(c)));
    return b;
  }

  // Clicking anywhere else, or Escape, closes it. Escape shouldn't also close the dialog under it.
  document.addEventListener('pointerdown', e => {
    if (active && !pop.contains(e.target) && !active.swatch.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', e => {
    if (active && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  window.addEventListener('resize', () => active && place());
  window.addEventListener('scroll', e => { if (active && !pop.contains(e.target)) place(); }, true);
}

function place() {
  const r = active.swatch.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight, gap = 8;
  const below = r.bottom + gap + h <= innerHeight;
  pop.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
  pop.style.top = `${below ? r.bottom + gap : Math.max(8, r.top - gap - h)}px`;
}

function open(swatch) {
  if (!pop) build();
  if (active) close();
  const home = swatch.closest('dialog[open]') || document.body;
  if (pop.parentNode !== home) home.append(pop);
  active = { swatch, hsv: hexToHsv(swatch.value), start: swatch.value };
  pop.drawRecent();
  pop.draw();
  pop.showPopover();
  place();
  swatch.classList.add('open');
}

function close() {
  if (!active) return;
  const { swatch, start } = active;
  active = null;
  pop.hidePopover();
  swatch.classList.remove('open');
  if (swatch.value !== start) {
    remember(swatch.value);
    swatch.onChange?.(swatch.value);
  }
}

// True while a color is being picked, so the page can hold off redrawing the swatch under it.
export const pickingColor = () => !!active;

// A swatch button. onInput runs as the color changes, onChange once the picker closes.
export function colorSwatch(value, { onInput, onChange, title = 'Pick a color', className = '' } = {}) {
  const b = make('button', `swatch ${className}`.trim(), { type: 'button', title });
  b.setColor = c => { b.value = c; b.style.setProperty('--c', c); };
  b.setColor(isHex(value) ? value.toLowerCase() : '#000000');
  Object.assign(b, { onInput, onChange });
  b.addEventListener('click', () => (active?.swatch === b ? close() : open(b)));
  return b;
}

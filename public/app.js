import { createRigView } from './rig-view.js';
import { cycleSeconds, caseSpot } from '/shared/rig-geometry.js';
import { colorSwatch, pickingColor } from './color-picker.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  n.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
  return n;
};

const FLAG = { SPEED: 1, BRIGHTNESS: 16 };
const ICONS = {
  dram: '<rect x="3" y="7" width="18" height="9" rx="1"/><path d="M6 16v3M10 16v3M14 16v3M18 16v3M7 10h2M11 10h2M15 10h2"/>',
  gpu: '<rect x="2" y="6" width="20" height="11" rx="2"/><circle cx="9" cy="11.5" r="3"/><circle cx="16" cy="11.5" r="2"/>',
  motherboard: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="5" height="5"/><path d="M16 8v8M8 16h5"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  ledstrip: '<path d="M3 12h18"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>',
  cooler: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 3-5 4-3M14 12c4 0 5 3 3 4M12 14c0 4-3 5-4 3M10 12c-4 0-5-3-3-4"/>',
  default: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
};
const TYPE_LABEL = { dram: 'Memory', gpu: 'Graphics card', motherboard: 'Motherboard', keyboard: 'Keyboard', mouse: 'Mouse', headset: 'Headset', monitor: 'Monitor', ledstrip: 'LED controller', cooler: 'Cooler' };
const MOTION_LABEL = { still: 'Still', flow: 'Flow', bounce: 'Bounce', breathe: 'Breathe', twinkle: 'Twinkle', comet: 'Comet', noise: 'Drift', beam: 'Beam', bubbles: 'Bubbles', lightning: 'Lightning', fill: 'Fill' };
const FLOW_LABEL = {
  case: { up: 'Rising ↑', down: 'Falling ↓', front: 'Rear → front', rear: 'Front → rear', diagonal: 'Diagonal ↗', out: 'From center', spiral: 'Spiral ↻', clockwise: 'Spin ↻', anticlockwise: 'Spin ↺' },
  desk: { right: 'Left → right', left: 'Right → left', back: 'Toward monitor', front: 'Toward me', out: 'From center', clockwise: 'Spin ↻', anticlockwise: 'Spin ↺' },
  rig: { up: 'Rising ↑', down: 'Falling ↓', right: 'Left → right', left: 'Right → left', back: 'Toward monitor', front: 'Toward me', out: 'From center', clockwise: 'Spin ↻', anticlockwise: 'Spin ↺' },
};
// Where a light can be mounted; each sets its plane and pins one coordinate.
const MOUNTS = {
  case: {
    bottom: { label: 'Bottom panel', plane: 'xz', set: p => { p[1] = 2.5; } },
    top: { label: 'Top panel', plane: 'xz', set: (p, [, H]) => { p[1] = H - 2.5; } },
    rear: { label: 'Rear panel', plane: 'yz', set: p => { p[0] = 2; } },
    front: { label: 'Front panel', plane: 'yz', set: (p, [L]) => { p[0] = L - 2; } },
    board: { label: 'On the motherboard', plane: 'xy', set: p => { p[2] = Math.min(p[2], 6); } },
    glass: { label: 'Facing the glass', plane: 'xy', set: (p, [, , W]) => { p[2] = W - 1.5; } },
  },
  desk: {
    flat: { label: 'Lying flat', plane: 'xz', set: () => {} },
    upright: { label: 'Standing, facing you', plane: 'xy', set: () => {} },
    sideways: { label: 'Standing, facing sideways', plane: 'yz', set: () => {} },
  },
};
const PLACEMENT_LABEL = { 'desk-left': 'On the desk, left', 'desk-right': 'On the desk, right', 'floor-left': 'On the floor, left', 'floor-right': 'On the floor, right' };

const prettyName = d => d.name.replace(/\s*\((Wired|Wireless)\)$/, '');
const round = v => Math.round(v * 10) / 10;

let state = null;
let selectedKey = null;
let setup = null;
let setupStarted = false;
let setupTimer = null;
let setupRequest = null;
let setupSaving = false;
const STEPS = ['openrgb', 'setup', 'devices', 'review', 'look'];
const STEP_TITLE = ['Connect to OpenRGB', 'Your setup', 'Your devices', 'Check where lights are', 'Pick a look'];
const ledEls = {}; // device index → [{ el, led }]

async function post(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  // An editor started before an update doesn't know newer requests (older ones answer 405).
  if (r.status === 405) throw new Error('RGB Studio was updated while it was running. Restart it to finish updating.');
  if (!r.ok) throw new Error(out.error || r.statusText);
  return out;
}
const tryPost = (url, body) => post(url, body).catch(e => toast(e.message));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sendScene = debounce(body => tryPost('/api/scene', body), 40);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---- rig view -------------------------------------------------------------------------------

const view = createRigView($('#rig'), {
  onSelect: key => { if (!setup) selectedKey = key; renderSide(); },
  onMove: (key, pos) => tryPost('/api/light', { key, patch: { pos } }),
  onMoveCase: spot => tryPost('/api/rig', { case: { spot } }),
});
document.querySelectorAll('[data-rotate]').forEach(b => b.addEventListener('click', () => view.rotate(+b.dataset.rotate)));
$('#fit').addEventListener('click', () => view.fit());

const lightByKey = key => state.lights.find(l => l.key === key);
const patchLight = (key, patch) => tryPost('/api/light', { key, patch });

function identify(light) {
  if (state.devices[light.device]?.builtIn) return toast(`${light.label} is running a built-in effect. Switch it back to the scene to identify it.`);
  tryPost('/api/identify', { key: light.key });
  toast(`Blinking “${light.label}” white on your PC…`);
}

function showStart(light) {
  if (state.devices[light.device]?.builtIn) return toast(`${light.label} is running a built-in effect. Switch it back to the scene first.`);
  tryPost('/api/identify', { key: light.key, start: true });
  toast(`On your PC, “${light.label}” now shows its first LED in white, with pink after it. ${light.shape === 'ring' ? 'Turn its lights' : light.shape === 'matrix' ? 'Turn it' : 'Reverse or turn it'} until the 3D view shows the same.`);
}

function mountOf(light) {
  const [L, H, W] = state.rig.case.size;
  const [x, y, z] = light.pos;
  if (light.area === 'desk') return { xz: 'flat', xy: 'upright', yz: 'sideways' }[light.plane];
  if (light.plane === 'xz') return y < H / 2 ? 'bottom' : 'top';
  if (light.plane === 'yz') return x < L / 2 ? 'rear' : 'front';
  return z < W / 2 ? 'board' : 'glass';
}

function numberInput(value, onchange, { step = 0.5, min, max } = {}) {
  return el('input', { type: 'number', value: round(value), step, min, max, onchange: e => Number.isFinite(+e.target.value) && onchange(+e.target.value) });
}

function renderSide() {
  const side = $('#side');
  // Leave the panel alone while someone is typing in one of its number boxes.
  if (document.activeElement?.tagName === 'INPUT' && side.contains(document.activeElement)) return;
  const light = selectedKey && lightByKey(selectedKey);
  const scroll = side.scrollTop;
  const kids = setup ? setupPanel() : light ? lightEditor(light) : lightList();
  side.replaceChildren(...kids.filter(Boolean));
  side.scrollTop = scroll;
}

function lightList() {
  const row = l => el('button', { class: 'light-row' + (l.hidden ? ' off' : '') + (l.key === selectedKey ? ' active' : ''), onclick: () => { selectedKey = l.key; view.select(l.key); renderSide(); } },
    el('span', {}, l.label), el('small', {}, l.hidden ? 'not connected' : MOUNTS[l.area][mountOf(l)]?.label ?? ''));
  const group = (title, list) => list.length ? el('div', { class: 'side-group' }, el('h3', {}, title), ...list.map(row)) : null;
  const caseL = state.lights.filter(l => l.area === 'case' && !l.hidden);
  const deskL = state.lights.filter(l => l.area === 'desk' && !l.hidden);
  const offL = state.lights.filter(l => l.hidden);
  return [
    el('p', { class: 'hint' }, 'Click a light to set it up, or drag it to where it really is.'),
    group('In your case', caseL),
    group('On your desk', deskL),
    offL.length ? el('details', { class: 'side-group' }, el('summary', {}, `Not connected (${offL.length})`), ...offL.map(row)) : null,
    rigSettings(),
  ];
}

const sizeInputs = (values, names, send) => el('div', { class: 'dims' }, ...values.map((v, i) =>
  el('label', {}, names[i], numberInput(v, n => { const next = [...values]; next[i] = n; send(next); }, { step: 1, min: 10 }))));

function rigSettings() {
  const rig = state.rig;
  return el('div', { class: 'side-group' },
    el('h3', {}, 'Your setup'),
    el('label', { class: 'side-field' }, 'Case sits',
      el('select', { onchange: e => tryPost('/api/rig', { case: { placement: e.target.value } }) },
        ...state.placements.map(p => el('option', { value: p, selected: p === rig.case.placement }, PLACEMENT_LABEL[p])))),
    el('div', { class: 'side-field' }, 'Case size (cm)', sizeInputs(rig.case.size, ['Depth', 'Height', 'Width'], size => tryPost('/api/rig', { case: { size } }))),
    caseSpotField(),
    el('div', { class: 'side-field' }, 'Desk size (cm)', sizeInputs(rig.desk.size, ['Width', 'Depth'], size => tryPost('/api/rig', { desk: { size } }))),
    el('div', { class: 'side-actions' },
      el('button', { class: 'ghost small', onclick: startSetup }, 'Run setup again'),
      el('button', { class: 'ghost small', onclick: openShare }, 'Share / import…'),
      el('button', { class: 'link', onclick: () => confirm('Put every light back where RGB Studio first guessed?') && tryPost('/api/rig/reset') }, 'Reset layout')));
}

// Where the case stands and which way it faces. x and z are measured from the desk's back-left
// corner; the 3D view also lets you click the case and drag it.
function caseSpotField() {
  const spot = caseSpot(state.rig);
  const send = patch => tryPost('/api/rig', { case: { spot: { ...spot, ...patch } } });
  return el('div', { class: 'side-field' }, 'Case spot (cm from the desk\'s back-left corner)',
    el('div', { class: 'dims' },
      el('label', {}, 'Across', numberInput(spot.x, x => send({ x }), { step: 1 })),
      el('label', {}, 'Forward', numberInput(spot.z, z => send({ z }), { step: 1 })),
      el('label', {}, 'Turn °', numberInput(spot.turn, turn => send({ turn }), { step: 15 }))),
    el('div', { class: 'side-actions' },
      el('button', { class: 'ghost small', title: 'Turn the case left', onclick: () => send({ turn: spot.turn + 90 }) }, '⟲ 90°'),
      el('button', { class: 'ghost small', title: 'Turn the case right', onclick: () => send({ turn: spot.turn - 90 }) }, '⟳ 90°')));
}

function lightEditor(l) {
  const d = state.devices[l.device];
  const back = () => { selectedKey = null; view.select(null); renderSide(); };
  const mounts = MOUNTS[l.area];
  const kids = [
    el('button', { class: 'link', onclick: back }, '← All lights'),
    el('h3', { class: 'editor-title' }, l.label),
    el('p', { class: 'hint' }, `${prettyName(d)} · ${d.zones[l.zone].name} · ${l.count} LED${l.count === 1 ? '' : 's'}`),
  ];
  if (!l.hidden) {
    kids.push(
      el('label', { class: 'side-field' }, 'Where',
        el('select', { onchange: e => moveArea(l, e.target.value) },
          el('option', { value: 'case', selected: l.area === 'case' }, 'In the case'),
          el('option', { value: 'desk', selected: l.area === 'desk' }, 'On the desk'))),
      el('label', { class: 'side-field' }, 'Mounted',
        el('select', { onchange: e => setMount(l, e.target.value) },
          ...Object.entries(mounts).map(([k, m]) => el('option', { value: k, selected: k === mountOf(l) }, m.label)))),
      el('div', { class: 'side-field' }, 'Position (cm)', el('div', { class: 'dims' }, ...['x', 'y', 'z'].map((axis, i) =>
        el('label', {}, axis, numberInput(l.pos[i], v => { const pos = [...l.pos]; pos[i] = v; patchLight(l.key, { pos }); })))),
      ),
    );
    if (l.shape === 'ring' || l.shape === 'bar' || l.shape === 'matrix') {
      kids.push(el('div', { class: 'dims' },
        el('label', {}, l.shape === 'ring' ? 'Radius' : 'Length', numberInput(l.size, size => patchLight(l.key, { size }), { min: 0.5 })),
        el('label', {}, l.shape === 'ring' ? 'Turn lights °' : 'Turn °', numberInput(l.angle, angle => patchLight(l.key, { angle }), { step: 15 }))));
    }
    if (l.shape === 'ring') {
      kids.push(el('label', { class: 'side-field' }, 'Lit faces',
        el('select', { onchange: e => patchLight(l.key, { rings: +e.target.value }) },
          el('option', { value: 1, selected: l.rings === 1 }, 'One face: a single ring of lights'),
          el('option', { value: 2, selected: l.rings === 2 }, 'Both faces: a ring on the front and the back'))));
    }
    if (l.plane === 'xz' && l.count > 1) {
      const fan = l.shape === 'ring';
      kids.push(el('label', { class: 'side-field check' },
        el('input', { type: 'checkbox', checked: !!l.sweep, onchange: e => patchLight(l.key, { sweep: e.target.checked }) }),
        fan ? 'Sweep across the fan' : 'Sweep across it',
        el('span', { class: 'hint' }, fan
          ? 'Rising effects light it from the glass side to the back, instead of the whole fan at once. Turn ° picks the edge it starts from.'
          : `It lies flat, so rising effects would light it all at once. This sweeps them across it from ${l.area === 'desk' ? 'the edge nearest you to the far edge' : 'the glass side to the back'} instead.`)));
    }
  }
  kids.push(el('div', { class: 'side-actions' },
    !l.hidden && el('button', { class: 'ghost small', onclick: () => identify(l) }, 'Identify'),
    !l.hidden && l.count > 1 && el('button', { class: 'ghost small', title: `Light the first LED of this ${l.shape === 'ring' ? 'fan' : 'part'} on your PC and here, to line them up`, onclick: () => showStart(l) }, 'Show first LED'),
    ...(!l.hidden && l.shape !== 'matrix' ? reverseButtons(l) : []),
    el('button', { class: 'ghost small', onclick: () => patchLight(l.key, { hidden: !l.hidden }) }, l.hidden ? 'It is connected' : 'Nothing connected'),
    el('button', { class: 'link', onclick: () => tryPost('/api/light', { key: l.key, reset: true }) }, 'Reset')));
  return kids;
}

// Reverse flips which way the LEDs run. On a fan that only changes the direction around the ring,
// so fans also get Upside down, which turns the whole ring of lights half a turn.
function reverseButtons(l) {
  const reverse = el('button', { class: 'ghost small' + (l.flip ? ' on' : ''), title: l.shape === 'ring' ? 'LEDs run the other way around on your fan? Reverse their direction.' : 'Colors running the wrong way on this part? Reverse its LED order.', onclick: () => patchLight(l.key, { flip: !l.flip }) }, 'Reverse');
  if (l.shape !== 'ring') return [reverse];
  const upsideDown = Math.abs(Math.abs(l.angle) - 180) < 1;
  return [reverse, el('button', { class: 'ghost small' + (upsideDown ? ' on' : ''), title: 'Effects start from the wrong edge of this fan? Turn its lights upside down.', onclick: () => patchLight(l.key, { angle: ((l.angle + 180) % 360 + 540) % 360 - 180 }) }, 'Upside down')];
}

function setMount(l, name) {
  const m = MOUNTS[l.area][name];
  const pos = [...l.pos];
  m.set(pos, state.rig.case.size);
  patchLight(l.key, { plane: m.plane, pos });
}

function moveArea(l, area) {
  const [L, H, W] = state.rig.case.size;
  const [DW, DD] = state.rig.desk.size;
  const pos = area === 'case' ? [L / 2, H / 2, W / 2] : [DW / 2, 2, DD / 2];
  patchLight(l.key, { area, pos, plane: area === 'case' ? 'xy' : 'xz' });
}

// ---- first-run setup -------------------------------------------------------------------------

function startSetup() {
  setupStarted = true;
  setup = { step: 0, check: null, missingOpen: false };
  selectedKey = null;
  view.select(null);
  renderSide();
  syncSetupCheck();
  $('.stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshSetupCheck() {
  const current = setup;
  if (!current || setupRequest === current) return;
  setupRequest = current;
  try {
    const r = await fetch('/api/setup/check');
    if (!r.ok) return;
    const check = await r.json();
    if (setup !== current) return;
    current.check = check;
    renderSide();
  } catch {
    // The next poll can try again.
  } finally {
    if (setupRequest === current) setupRequest = null;
  }
}

function syncSetupCheck() {
  const polling = setup && STEPS[setup.step] === 'openrgb' && state.status !== 'connected';
  if (polling && setupTimer === null) {
    refreshSetupCheck();
    setupTimer = setInterval(refreshSetupCheck, 3000);
  } else if (!polling) {
    clearInterval(setupTimer);
    setupTimer = null;
  }
}

function setupStep(step) {
  setup.step = step;
  if (STEPS[step] === 'devices') {
    if (!setup.devicesSeen) {
      setup.missingOpen = !state.devices.length;
      setup.devicesSeen = true;
    }
    if (!setup.check) refreshSetupCheck();
  }
  view.select(null);
  syncSetupCheck();
  renderSide();
  $('#side').scrollTop = 0;
}

async function finishSetup(saveToPc = false, skipped = false) {
  if (setupSaving) return;
  setupSaving = true;
  renderSide();
  try {
    await post('/api/setup/done');
    setup = null;
    selectedKey = null;
    syncSetupCheck();
    view.select(null);
    renderSide();
    if (skipped) toast('You can run setup again from Your setup.');
    if (saveToPc) $('#save').click();
  } catch (e) { toast(e.message); }
  finally { setupSaving = false; if (setup) renderSide(); }
}

function setupPanel() {
  const step = STEPS[setup.step];
  const body = { openrgb: setupOpenRGB, setup: setupRig, devices: setupDevices, review: setupReview, look: setupLook }[step]();
  return [
    el('div', { class: 'setup-head' }, el('h3', {}, 'Set up RGB Studio'),
      el('p', { class: 'hint' }, `Step ${setup.step + 1} of ${STEPS.length} · ${STEP_TITLE[setup.step]}`)),
    ...body,
    el('div', { class: 'setup-nav' },
      el('div', { class: 'setup-buttons' },
        el('button', { class: 'ghost', hidden: setup.step === 0, disabled: setupSaving, onclick: () => setupStep(setup.step - 1) }, 'Back'),
        el('button', { class: 'primary', disabled: setupSaving || (step === 'openrgb' && state.status !== 'connected'), onclick: () => step === 'look' ? finishSetup() : setupStep(setup.step + 1) }, step === 'look' ? 'Finish' : 'Next')),
      step === 'look' && el('button', { class: 'ghost small', disabled: setupSaving || state.status !== 'connected', onclick: () => finishSetup(true) }, 'Finish and Save to PC…'),
      el('button', { class: 'link', disabled: setupSaving, onclick: () => finishSetup(false, true) }, 'Skip setup')),
  ];
}

const setupLink = (label, href) => el('a', { class: 'link', href, target: '_blank', rel: 'noopener' }, label);
function setupInstall() {
  return el('p', { class: 'hint' }, 'Install PawnIO from ', setupLink('pawnio.eu', 'https://pawnio.eu'),
    ' first, then OpenRGB 0.9 or newer from ', setupLink('openrgb.org', 'https://openrgb.org/releases.html'),
    ' with the Windows installer (.msi). Keep the option to install it as a background service.');
}

function setupOpenRGB() {
  if (state.status === 'connected') return [el('p', { class: 'ok-note' }, `✓ Connected to OpenRGB · ${state.devices.length} devices`)];
  const c = setup.check;
  const hint = el('p', { class: 'hint' }, 'This page connects by itself as soon as OpenRGB is ready.');
  if (c?.platform === 'other') return [setupInstall(), hint];
  const row = (label, ok, note) => el('div', { class: 'setup-check ' + (ok === undefined ? 'wait' : ok ? 'ok' : 'bad') },
    el('span', { 'aria-hidden': 'true' }, ok === undefined ? '…' : ok ? '✓' : '✗'),
    el('div', {}, label, note && el('small', {}, note)));
  let instruction = null;
  if (c) {
    if (!c.installed) instruction = setupInstall();
    else {
      const text = c.service === 'missing' && !c.app
        ? 'Open OpenRGB as administrator, go to its SDK Server tab and click Start Server. Or reinstall it with the background service option so it runs on its own.'
        : c.service === 'stopped' && !c.app
          ? 'The OpenRGB service is installed but stopped. Restart your PC, or press Win+R, type services.msc, find OpenRGB and click Start.'
          : !c.port
            ? "OpenRGB is running, but its SDK server isn't answering. In OpenRGB's SDK Server tab, click Start Server."
            : 'OpenRGB is answering. Connecting…';
      instruction = el('p', { class: 'hint' }, text);
    }
  }
  return [
    el('div', { class: 'side-group' },
      row('PawnIO driver', c ? c.pawnio === 'running' : undefined, 'Optional · needed for RAM and some motherboards'),
      row('OpenRGB installed', c?.installed),
      row(c?.app ? 'OpenRGB app is open' : 'OpenRGB service running', c ? c.service === 'running' || c.app : undefined),
      row('SDK server answering on port 6742', c?.port)),
    instruction, hint,
  ];
}

function setupRig() {
  const rig = state.rig;
  return [el('div', { class: 'side-group' },
    el('div', { class: 'side-field' }, "Where's your case?",
      el('div', { class: 'seg' }, ...state.placements.map(placement => el('button', {
        class: placement === rig.case.placement ? 'active' : '',
        onclick: () => tryPost('/api/rig', { case: { placement } }),
      }, PLACEMENT_LABEL[placement])))),
    el('div', { class: 'side-field' }, 'Case size (cm)', sizeInputs(rig.case.size, ['Depth', 'Height', 'Width'], size => tryPost('/api/rig', { case: { size } }))),
    el('div', { class: 'side-field' }, 'Desk size (cm)', sizeInputs(rig.desk.size, ['Width', 'Depth'], size => tryPost('/api/rig', { desk: { size } })))),
    el('p', { class: 'hint' }, 'Rough sizes are fine. You can drag the case into place in the 3D view later.'),
  ];
}

function setupDevices() {
  const current = setup;
  const c = setup.check;
  return [
    el('div', { class: 'side-group' }, el('h3', {}, `Found ${state.devices.length} devices`), ...state.devices.map(d =>
      el('div', { class: 'device-head setup-device' }, deviceIcon(d),
        el('div', {}, el('div', { class: 'device-name' }, prettyName(d)), el('div', { class: 'device-meta' }, `${d.ledCount} LEDs`))))),
    el('details', { class: 'side-group setup-tips', open: setup.missingOpen, ontoggle: e => {
      if (setup === current && e.target.isConnected) current.missingOpen = e.target.open;
    } }, el('summary', {}, 'Something missing?'),
      el('p', { class: 'hint' }, 'RAM or motherboard missing? OpenRGB needs the PawnIO driver for those. ',
        c?.pawnio === 'missing' ? "PawnIO isn't installed. " : '',
        setupLink('Install it', 'https://pawnio.eu'), ', then restart your PC.'),
      c?.others?.length ? el('p', { class: 'hint' }, `These apps can hold on to your devices: ${c.others.join(', ')}. Turn off their lighting control or close them, then rescan.`) : null,
      el('p', { class: 'hint' }, 'Still missing? Check that ', setupLink('OpenRGB supports it', 'https://openrgb.org/devices.html')),
      el('button', { class: 'ghost small', disabled: state.status !== 'connected', onclick: () => tryPost('/api/rescan') }, 'Rescan')),
  ];
}

function setupReview() {
  const block = l => el('div', { class: 'light-row setup-light', tabindex: 0, onclick: () => view.select(l.key), onmouseenter: () => view.select(l.key), onfocus: () => view.select(l.key) },
    el('span', {}, l.label), el('small', {}, MOUNTS[l.area][mountOf(l)]?.label ?? ''),
    el('div', { class: 'side-actions' }, el('button', { class: 'ghost small', onclick: () => identify(l) }, 'Identify')),
    el('label', { class: 'side-field' }, 'Where',
      el('select', { onchange: e => moveArea(l, e.target.value) },
        el('option', { value: 'case', selected: l.area === 'case' }, 'In the case'),
        el('option', { value: 'desk', selected: l.area === 'desk' }, 'On the desk'))),
    el('label', { class: 'side-field' }, 'Mounted',
      el('select', { onchange: e => setMount(l, e.target.value) },
        ...Object.entries(MOUNTS[l.area]).map(([key, m]) => el('option', { value: key, selected: key === mountOf(l) }, m.label)))),
    el('button', { class: 'link', onclick: () => patchLight(l.key, { hidden: true }) }, 'Nothing connected'));
  const group = (title, area) => {
    const lights = state.lights.filter(l => l.area === area && !l.hidden);
    return lights.length ? el('div', { class: 'side-group' }, el('h3', {}, title), ...lights.map(block)) : null;
  };
  const hidden = state.lights.filter(l => l.hidden);
  return [
    el('p', { class: 'hint' }, "RGB Studio guessed where each light is. Click Identify to blink it on your PC, and fix any guess that's wrong. You can fine-tune positions later by dragging lights in the 3D view."),
    group('In your case', 'case'), group('On your desk', 'desk'),
    hidden.length ? el('details', { class: 'side-group' }, el('summary', {}, `Not connected (${hidden.length})`),
      ...hidden.map(l => el('div', { class: 'light-row off' }, el('span', {}, l.label),
        el('button', { class: 'link', onclick: () => patchLight(l.key, { hidden: false }) }, 'It is connected')))) : null,
  ];
}

function setupLook() {
  return [el('div', { class: 'side-group' }, el('h3', {}, 'Pick your first look'),
    el('div', { class: 'setup-scenes' }, ...Object.entries(state.scenes).map(([key, scene]) => {
      const sw = el('span', { class: 'setup-swatch' });
      sw.style.background = swatchStyle(scene);
      return el('button', { class: 'scene' + (state.settings.scene === key ? ' active' : ''), onclick: () => tryPost('/api/scene', { scene: key, area: 'case' }) }, sw, scene.label);
    })))];
}

// ---- share / import --------------------------------------------------------------------------

const LIGHT_FIELDS = ['label', 'area', 'shape', 'pos', 'plane', 'size', 'angle', 'rings', 'flip', 'sweep', 'hidden', 'body'];
function rigFile() {
  const { case: c, desk, props } = state.rig;
  return {
    format: 'rgb-studio-rig/1',
    case: c, desk, props,
    lights: Object.fromEntries(state.lights.map(l => [l.key, Object.fromEntries(LIGHT_FIELDS.map(k => [k, l[k]]))])),
  };
}
function openShare() {
  $('#share-json').value = JSON.stringify(rigFile(), null, 2);
  $('#share-dlg').showModal();
}
const copy = async text => { await navigator.clipboard.writeText(text); toast('Copied'); };
$('#share-copy').addEventListener('click', () => copy($('#share-json').value));
$('#share-claude').addEventListener('click', async () => {
  const prompt = await (await fetch('/claude-prompt.md')).text();
  copy(prompt.replace('{{RIG}}', JSON.stringify(rigFile(), null, 2)));
});
$('#share-import').addEventListener('click', async () => {
  let rig;
  try {
    const text = $('#share-json').value;
    rig = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); // tolerate text around the JSON
  } catch {
    return toast('That is not a valid layout file');
  }
  try {
    await post('/api/rig/import', { rig });
    $('#share-dlg').close();
    toast('Layout imported');
  } catch (e) { toast(e.message); }
});

// ---- looks ----------------------------------------------------------------------------------

const loop = pal => [...pal, pal[0]];
const PASSES = ['comet', 'fill', 'beam'];
function swatchStyle(s) {
  const pal = s.palette;
  if (s.motion === 'still') return pal.length > 1 ? `linear-gradient(90deg in hsl shorter hue, ${pal.join(', ')})` : pal[0];
  // The dark parts glow faintly in the same color when the look has a background glow.
  const dark = c => (s.background ? `color-mix(in srgb, ${c} ${s.background * 0.5}%, #000)` : '#000');
  if (PASSES.includes(s.motion)) return `linear-gradient(90deg, ${pal.flatMap((c, i) => [`${dark(c)} ${(i / pal.length) * 100}%`, `${c} ${((i + 0.8) / pal.length) * 100}%`, `${dark(c)} ${((i + 0.85) / pal.length) * 100}%`]).join(', ')})`;
  return `linear-gradient(90deg in hsl shorter hue, ${loop(loop(pal)).join(', ')})`;
}

// Paints a preview of a look and plays it at the look's own speed, brightness and gradient width,
// so fine-tuning shows up here too.
function paintSwatch(node, look) {
  node.className = node.className.replace(/\bm-\S+/g, '').trim() + ` m-${look.motion}`;
  node.style.background = swatchStyle(look);
  const b = (look.brightness ?? 100) / 100;
  if (look.motion === 'still') { node.style.backgroundSize = '100% 100%'; node.style.filter = `brightness(${b})`; return; }
  // A wider gradient fits more colors into the preview. The image is one tile, so sliding by
  // exactly one tile loops seamlessly whatever its size.
  const size = ['flow', 'bounce', 'breathe'].includes(look.motion) ? Math.max(120, 400 - 4 * (look.spread ?? 50)) : 200;
  node.style.backgroundSize = `${size}% 100%`;
  node.style.setProperty('--to', `${(-100 * size) / (size - 100)}%`);
  const cycle = cycleSeconds(look.speed ?? 40);
  const duration = {
    flow: [2 * cycle], bounce: [cycle], breathe: [4 * cycle, cycle], twinkle: [2 * cycle],
    noise: [3 * cycle], bubbles: [3 * cycle], lightning: [3],
  }[look.motion] || [(cycle * look.palette.length) / (look.motion === 'comet' ? look.comets ?? 1 : 1)];
  node.style.animationDuration = duration.map(d => `${d.toFixed(2)}s`).join(', ');
  node.style.filter = look.motion === 'lightning' ? '' : look.motion === 'twinkle' ? `brightness(${0.6 * b}) contrast(1.4)` : `brightness(${b})`;
}

function renderStatus() {
  const s = $('#status');
  s.className = 'status ' + state.status;
  s.textContent = state.status === 'connected'
    ? `Connected · ${state.devices.length} devices`
    : state.status === 'connecting' ? 'Connecting to OpenRGB…' : 'OpenRGB not running — retrying';
  $('#save').disabled = state.status !== 'connected';
}

// The desk can have its own look. `editArea` is the one the scene cards and fine-tuning change.
let editArea = 'case';
const editing = () => (editArea === 'desk' && state.settings.desk ? state.settings.desk : state.settings);
const sendLook = body => tryPost('/api/scene', { ...body, area: editArea });

// "Whole rig" shares one look; picking Case or Desk splits them, and both sections then edit that part.
const TARGETS = {
  all: { label: 'Whole rig', title: '', hint: 'One look across every device, perfectly in sync.' },
  case: { label: 'Case', title: ' for the case', hint: 'Fans, RAM and motherboard. The desk keeps its own look.' },
  desk: { label: 'Desk', title: ' for the desk', hint: 'Keyboard, mouse and monitor. The case keeps its own look.' },
};
// What was just picked, until the server's state catches up, so the switch doesn't flick back.
let wantSplit = null;
function isSplit() {
  const split = !!state.settings.desk;
  if (wantSplit === split) wantSplit = null;
  return wantSplit ?? split;
}
function pickTarget(target) {
  wantSplit = target !== 'all';
  editArea = target === 'all' ? 'case' : target;
  tryPost('/api/scene', { own: wantSplit });
  render();
}

function renderLookTarget() {
  if (!isSplit()) editArea = 'case';
  const target = isSplit() ? editArea : 'all';
  const seg = () => el('div', { class: 'seg' }, ...Object.entries(TARGETS).map(([k, t]) =>
    el('button', { class: k === target ? 'active' : '', onclick: () => pickTarget(k) }, t.label)));
  $('#look-title').textContent = `1 · Pick a look${TARGETS[target].title}`;
  $('#tune-title').textContent = `2 · Fine-tune it${TARGETS[target].title}`;
  $('#look-hint').textContent = TARGETS[target].hint;
  $('#look-area').replaceChildren(seg());
  $('#tune-area').replaceChildren(seg());
}

// Saved looks always hold both areas, whichever one is being edited.
let looksSig = '';
function renderLooks() {
  const looks = state.looks ?? [];
  const sig = JSON.stringify(looks);
  if (sig === looksSig) return;
  looksSig = sig;
  $('#saved-looks').replaceChildren(...(looks.length ? looks.map(l =>
    el('span', { class: 'seg saved-look' },
      el('button', { title: `Load ${l.name}: ${l.split ? 'separate case and desk looks' : 'whole rig'}, ${l.flow?.together ? `flow together: ${l.flow.rig ?? '?'}` : `case flow ${l.flow?.case ?? '?'}, desk flow ${l.flow?.desk ?? '?'}`}`, onclick: () => tryPost('/api/looks/load', { id: l.id }) }, l.name),
      el('button', { title: `Delete ${l.name}`, 'aria-label': `Delete ${l.name}`, onclick: () => confirm(`Delete “${l.name}”?`) && tryPost('/api/looks/delete', { id: l.id }) }, '×')))
    : [el('span', { class: 'hint' }, 'Save a look to come back to it later.')]));
}

$('#save-look').addEventListener('click', () => {
  $('#look-name').value = '';
  $('#look-name').setCustomValidity('');
  $('#look-dlg').showModal();
});
$('#look-name').addEventListener('input', e => e.target.setCustomValidity(''));
$('#look-save').addEventListener('click', () => $('#look-name').setCustomValidity('')); // let a failed save be retried
$('#look-cancel').addEventListener('click', () => $('#look-dlg').close());
$('#look-dlg form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#look-name').value.trim();
  if (!name) {
    $('#look-name').setCustomValidity('Give the look a name.');
    return $('#look-name').reportValidity();
  }
  $('#look-save').disabled = true;
  try {
    await post('/api/looks', { name });
    $('#look-dlg').close();
    toast('Look saved');
  } catch (e) {
    // The toast sits behind the open dialog, so show the error on the name field.
    $('#look-name').setCustomValidity(`Couldn’t save: ${e.message}`);
    $('#look-name').reportValidity();
  } finally {
    $('#look-save').disabled = false;
  }
});

// The selected look's card follows your fine-tuning; the others show each scene as it comes.
const LOOK_KEYS = ['motion', 'palette', 'speed', 'brightness', 'spread', 'background', 'comets'];
let scenesSig = '';
function renderScenes() {
  const st = editing();
  const sig = JSON.stringify([Object.keys(state.scenes), editArea, st.scene, LOOK_KEYS.map(k => st[k])]);
  if (sig === scenesSig) return;
  scenesSig = sig;
  $('#scenes').replaceChildren(...Object.entries(state.scenes).map(([key, s]) => {
    const active = st.scene === key;
    const look = active ? Object.fromEntries(LOOK_KEYS.map(k => [k, st[k]])) : s;
    const sw = el('div', { class: 'swatch' });
    paintSwatch(sw, look);
    return el('button', { class: 'scene' + (active ? ' active' : ''), onclick: () => sendLook({ scene: key }) },
      sw, el('div', { class: 'name' }, s.label), el('div', { class: 'kind' }, MOTION_LABEL[look.motion]));
  }));
}

const SPEED_TEXT = { flow: 'one full cycle every', bounce: 'one sweep every', breathe: 'one breath every', twinkle: 'a twinkle every', comet: 'one pass every', noise: 'drifting, one change every', beam: 'one turn every', bubbles: 'a bubble every', lightning: 'a chance of a strike every', fill: 'one fill every' };
const SPREAD_TEXT = {
  comet: ['Tail length', 'how far the light trails behind'],
  noise: ['Blob size', 'small busy blobs or big slow ones'],
  beam: ['Beam width', 'a thin line or a wide sweep'],
  bubbles: ['Bubble size', 'how far each ring grows'],
  lightning: ['Afterglow', 'how long each flash lingers'],
  fill: ['Dark gap', 'how long it stays black before the next color'],
  default: ['Gradient width', 'how many colors show on a device at once'],
};
const PALETTE_HINT = {
  still: 'the gradient blends between these, in order',
  comet: 'each pass takes the next color, so the cycle runs through these in order',
  fill: 'each fill takes the next color, in order',
  bubbles: 'each bubble picks one of these',
  lightning: 'each strike picks one of these',
  beam: 'the beam slowly shifts through these',
  twinkle: 'twinkles pick from these, over a dim gradient',
  default: 'the gradient blends between these, in order',
};

let shownPalette = '';
let previewBar = null;
function renderTune() {
  const st = editing();
  const moving = st.motion !== 'still';
  $('#motion').replaceChildren(...state.motions.map(m =>
    el('button', { class: m === st.motion ? 'active' : '', onclick: () => sendLook({ motion: m }) }, MOTION_LABEL[m])));
  $('#speed-field').classList.toggle('disabled', !moving);
  for (const k of ['speed', 'brightness', 'spread', 'background']) {
    const input = $('#' + k);
    if (document.activeElement !== input) input.value = st[k];
  }
  showSpeed(st.speed);
  $('#brightness-val').textContent = `${st.brightness}%`;
  $('#background-field').style.display = state.backdropMotions.includes(st.motion) ? '' : 'none';
  $('#comets-field').style.display = st.motion === 'comet' ? '' : 'none';
  $('#comets').replaceChildren(...[1, 2, 3, 4].map(n =>
    el('button', { class: n === (st.comets ?? 1) ? 'active' : '', onclick: () => sendLook({ comets: n }) }, String(n))));
  showBackground(st.background);
  const [label, hint] = SPREAD_TEXT[st.motion] || SPREAD_TEXT.default;
  $('#spread-label').textContent = label;
  $('#spread-hint').textContent = hint;
  $('#palette-hint').textContent = PALETTE_HINT[st.motion] || PALETTE_HINT.default;

  const look = Object.fromEntries(LOOK_KEYS.map(k => [k, st[k]]));
  if (previewBar && !pickingColor()) paintSwatch(previewBar, look);
  const sig = JSON.stringify([editArea, st.palette, st.motion, st.scene]);
  if (sig === shownPalette || pickingColor()) return;
  shownPalette = sig;
  const pal = [...st.palette];
  const bar = previewBar = el('div', { class: 'preview-bar' });
  const paint = () => paintSwatch(bar, { ...look, palette: pal });
  const resend = () => { shownPalette = ''; sendLook({ palette: pal }); };
  const stops = pal.map((c, i) => el('div', { class: 'stop' },
    colorSwatch(c, { onInput: v => { pal[i] = v; paint(); sendScene({ palette: pal, area: editArea }); } }),
    pal.length > 1 ? el('button', { class: 'rm', title: 'Remove color', onclick: () => { pal.splice(i, 1); resend(); } }, '×') : null));
  const add = pal.length < 8 ? el('button', { class: 'add-stop', title: 'Add color', onclick: () => { pal.push(pal.at(-1)); resend(); } }, '+') : null;
  paint();
  $('#palette').replaceChildren(...stops, add, bar);
}

function showBackground(v) {
  $('#background-val').textContent = v ? `${v}%, the gaps glow faintly in your colors` : 'off, the gaps stay black';
}

function showSpeed(speed) {
  const text = SPEED_TEXT[editing().motion];
  $('#speed-val').textContent = text ? `${text} ${cycleSeconds(speed).toFixed(1)}s` : '';
}

const sendGaps = debounce(body => tryPost('/api/flow', body), 60);
function showGaps(area, v) {
  $(`#gaps-${area}-val`).textContent = v >= 100 ? 'as measured' : v ? `${v}% of the gaps` : 'gaps skipped';
}

// What was just picked, until the server's state catches up, so the switch doesn't flick back.
let wantTogether = null;
function isTogether() {
  const together = !!state.settings.flow.together;
  if (wantTogether === together) wantTogether = null;
  return wantTogether ?? together;
}

function renderFlows() {
  const together = isTogether();
  $('#flow-mode').replaceChildren(...[[true, 'Together'], [false, 'Separate']].map(([value, label]) =>
    el('button', {
      class: value === together ? 'active' : '',
      title: value ? 'One flow across every light, in real space' : 'The case and the desk each have their own flow',
      onclick: () => { wantTogether = value; tryPost('/api/flow', { together: value }); renderFlows(); },
    }, label)));
  $('#row-rig').hidden = !together;
  $('#row-case').hidden = $('#row-desk').hidden = together;
  for (const area of ['case', 'desk', 'rig']) {
    const gaps = $(`#gaps-${area}`);
    if (document.activeElement !== gaps) gaps.value = state.settings.gaps[area];
    showGaps(area, state.settings.gaps[area]);
    const cur = state.settings.flow[area];
    $(`#flow-${area}`).replaceChildren(...state.flows[area].map(dir =>
      el('button', { class: dir === cur ? 'active' : '', onclick: () => tryPost('/api/flow', { area, direction: dir }) }, FLOW_LABEL[area][dir] || dir)));
  }
}

// ---- devices: one card per device, one row of LEDs per zone ---------------------------------

function deviceIcon(d) {
  const icon = el('div', { class: 'device-icon' });
  icon.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[d.type] || ICONS.default}</svg>`;
  return icon;
}

let deviceSig = '';
function renderDevices() {
  const sig = JSON.stringify([state.devices.map(d => [d.key, d.ledCount, d.builtIn, d.activeMode]), state.lights.map(l => [l.key, l.label, l.hidden])]);
  if (sig === deviceSig) return;
  deviceSig = sig;
  $('#devices').replaceChildren(...state.devices.map(d => {
    ledEls[d.index] = [];
    const lights = state.lights.filter(l => l.device === d.index);
    const zones = d.builtIn
      ? [el('div', { class: 'leds' }, el('span', { class: 'hw-note' }, `Running its built-in “${d.modes[d.activeMode]?.name ?? '?'}” effect`))]
      : lights.map(l => {
          const leds = el('div', { class: 'leds' + (l.count > 40 ? ' many' : '') });
          if (l.hidden) leds.append(el('span', { class: 'hw-note' }, 'Nothing connected'));
          else for (let i = 0; i < l.count; i++) {
            const dot = el('span', { class: 'led' });
            leds.append(dot);
            ledEls[d.index].push({ el: dot, led: l.ledStart + i });
          }
          const name = lights.length > 1 ? el('button', { class: 'zone-name link', title: 'Show in the layout', onclick: () => { selectedKey = l.key; view.select(l.key); renderSide(); } }, l.label) : null;
          return el('div', { class: 'zone' + (l.hidden ? ' off' : '') }, name, leds);
        });
    const icon = deviceIcon(d);
    const zoneInfo = d.zones.length > 1 ? ` · ${d.zones.length} zones` : '';
    return el('div', { class: 'device' },
      el('div', { class: 'device-head' }, icon,
        el('div', {}, el('div', { class: 'device-name' }, prettyName(d)),
          el('div', { class: 'device-meta' }, `${TYPE_LABEL[d.type] || d.type} · ${d.ledCount} LED${d.ledCount === 1 ? '' : 's'}${zoneInfo}`))),
      el('div', { class: 'zones' }, ...zones),
      el('div', { class: 'device-foot' },
        d.builtIn ? el('span', { class: 'badge' }, 'Built-in effect') : el('span', { class: 'badge scene-on' }, 'Following scene'),
        d.builtIn
          ? el('div', {},
              el('button', { class: 'link', onclick: () => openHardware(d) }, 'Change'), ' · ',
              el('button', { class: 'link', onclick: () => tryPost('/api/device', { index: d.index, mode: null }) }, 'Back to scene'))
          : el('button', { class: 'link', onclick: () => openHardware(d) }, 'Use a built-in effect…')));
  }));
}

// ---- built-in (hardware) effect picker -------------------------------------------------------

let hwSel = null;
function openHardware(d) {
  const modes = d.modes.filter(m => !/^(direct|custom)$/i.test(m.name));
  hwSel = { device: d, mode: modes.find(m => m.index === d.activeMode) || modes[0] };
  $('#hw-title').textContent = prettyName(d);
  const drawModes = () => $('#hw-modes').replaceChildren(...modes.map(m =>
    el('button', { type: 'button', class: 'chip' + (m === hwSel.mode ? ' active' : ''), onclick: () => { hwSel.mode = m; drawModes(); drawOpts(); } }, m.name)));
  const drawOpts = () => {
    const m = hwSel.mode, box = $('#hw-opts');
    if (!m) return box.replaceChildren(el('p', { class: 'hint' }, 'This device has no built-in effects. It can only follow scenes.'));
    hwSel.colors = m.colorsMax > 0 ? (m.colors.length ? [...m.colors] : Array(Math.max(1, m.colorsMin)).fill(state.settings.palette[0])) : [];
    const kids = [];
    if (m.colorsMax > 0) {
      const row = el('div', { class: 'palette' });
      const draw = () => row.replaceChildren(...hwSel.colors.map((c, i) => el('div', { class: 'stop' },
        colorSwatch(c, { onInput: v => { hwSel.colors[i] = v; } }),
        hwSel.colors.length > Math.max(1, m.colorsMin) ? el('button', { type: 'button', class: 'rm', onclick: () => { hwSel.colors.splice(i, 1); draw(); } }, '×') : null)),
        hwSel.colors.length < m.colorsMax ? el('button', { type: 'button', class: 'add-stop', onclick: () => { hwSel.colors.push(hwSel.colors.at(-1)); draw(); } }, '+') : '');
      draw();
      kids.push(el('div', { class: 'field' }, el('label', {}, 'Colors'), row));
    }
    const slider = (label, key, lo, hi, val) => {
      hwSel[key] = val;
      return el('div', { class: 'field' }, el('label', {}, label),
        el('input', { type: 'range', min: Math.min(lo, hi), max: Math.max(lo, hi), value: val, oninput: e => { hwSel[key] = +e.target.value; } }));
    };
    hwSel.speed = hwSel.brightness = undefined;
    if (m.flags & FLAG.SPEED) kids.push(slider('Speed', 'speed', m.speedMin, m.speedMax, m.speed));
    if ((m.flags & FLAG.BRIGHTNESS) && m.brightnessMax > m.brightnessMin) kids.push(slider('Brightness', 'brightness', m.brightnessMin, m.brightnessMax, m.brightness));
    box.replaceChildren(...kids);
  };
  drawModes();
  drawOpts();
  $('#hw-apply').disabled = !hwSel.mode;
  $('#hw').showModal();
}
$('#hw').addEventListener('close', () => {
  if ($('#hw').returnValue !== 'apply' || !hwSel?.mode) return;
  const { device, mode, colors, speed, brightness } = hwSel;
  tryPost('/api/device', { index: device.index, mode: mode.index, colors: colors.length ? colors : undefined, speed, brightness });
});

// ---- save to PC ------------------------------------------------------------------------------

function startupNote(startup) {
  if (!startup.available) {
    return el('p', { class: 'hint' }, 'OpenRGB is not installed as a Windows service here. To get your still colors back after a restart, open OpenRGB and load the “RGB Studio” profile, or pick it as OpenRGB’s startup profile in its settings.');
  }
  if (startup.enabled) return el('p', { class: 'ok-note' }, '✓ OpenRGB shows your still colors when your PC starts and when it wakes from sleep.');
  const btn = el('button', { type: 'button', class: 'ghost', onclick: async () => {
    btn.disabled = true;
    btn.textContent = startup.needsAdmin ? 'Waiting for Windows…' : 'Setting it up…';
    try {
      const out = await post('/api/startup-profile');
      btn.replaceWith(startupNote(out.startup));
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  } }, 'Load it when my PC starts');
  return el('div', { class: 'stack' },
    el('p', { class: 'hint' }, `Devices without their own memory get their colors from OpenRGB. Let OpenRGB show your still colors when your PC starts and wakes up?${startup.needsAdmin ? ' Windows asks for permission once.' : ''}`),
    btn);
}

// The player is started from here; it waits while this page is open and takes over once it closes.
function playerNote(player) {
  if (!player.built) return el('p', { class: 'hint' }, 'The player isn’t built yet. Run player\\build.cmd in the RGB Studio folder, then save again.');
  const btn = el('button', { type: 'button', class: 'ghost', onclick: async () => {
    btn.disabled = true;
    try {
      await post('/api/player');
      btn.replaceWith(el('p', { class: 'ok-note' }, '✓ The player is in your tray. It takes over when you close this page.'));
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  } }, 'Start the player');
  return el('div', { class: 'stack' }, el('p', { class: 'hint' }, 'Already running? It picks up the new look by itself.'), btn);
}

// The still colors being picked in the save dialog: a color or a gradient per area.
let stillPick = null;
function drawStill() {
  const pickCustom = () => { $('#save-dlg input[name=still][value=custom]').checked = true; };
  $('#still-colors').replaceChildren(...['case', 'desk'].map(area => {
    const list = stillPick[area];
    const bar = el('div', { class: 'preview-bar' });
    const paint = () => paintSwatch(bar, { motion: 'still', palette: list, brightness: 100 });
    const changed = () => { pickCustom(); drawStill(); };
    const row = el('div', { class: 'palette' },
      ...list.map((c, i) => el('div', { class: 'stop' },
        colorSwatch(c, { title: `Pick a ${area} color`, onInput: v => { list[i] = v; pickCustom(); paint(); } }),
        list.length > 1 ? el('button', { type: 'button', class: 'rm', title: 'Remove color', onclick: () => { list.splice(i, 1); changed(); } }, '×') : null)),
      list.length < 8 ? el('button', { type: 'button', class: 'add-stop', title: 'Add a color to make a gradient', onclick: () => { list.push(list.at(-1)); changed(); } }, '+') : null,
      list.length > 1 ? bar : null);
    paint();
    return el('div', { class: 'still-row' }, el('span', {}, area === 'case' ? 'Case' : 'Desk'), row);
  }));
}

$('#save').addEventListener('click', () => {
  const { still, palette } = state.settings;
  const deskPalette = state.settings.desk?.palette || palette;
  $(`#save-dlg input[name=still][value=${still.mode}]`).checked = true;
  stillPick = { case: [...(still.colors.case || [palette[0]])], desk: [...(still.colors.desk || [deskPalette[0]])] };
  drawStill();
  $('#save-out').replaceChildren();
  $('#save-go').disabled = false;
  $('#save-dlg').showModal();
});
$('#save-go').addEventListener('click', async () => {
  const still = { mode: new FormData($('#save-dlg form')).get('still'), colors: stillPick };
  $('#save-go').disabled = true;
  $('#save-out').replaceChildren(el('p', { class: 'hint' }, 'Saving…'));
  try {
    const out = await post('/api/save', { still });
    $('#save-out').replaceChildren(
      el('p', { class: 'ok-note' }, '✓ Saved. Your look is recorded for the player, and your still colors are stored in OpenRGB.'),
      el('p', { class: 'hint' }, `Recorded: ${out.player.devices.map(n => n.replace(/\s*\((Wired|Wireless)\)$/, '')).join(', ')}. Missing one? It may be asleep or still being found by OpenRGB; save again once it shows up.`),
      playerNote(out.player),
      startupNote(out.startup));
  } catch (e) {
    $('#save-out').replaceChildren(el('p', { class: 'bad-note' }, `Couldn’t save: ${e.message}`));
  } finally {
    $('#save-go').disabled = false;
  }
});

// ---- wiring ---------------------------------------------------------------------------------

function render() {
  renderStatus();
  renderLookTarget();
  renderLooks();
  renderScenes();
  renderTune();
  renderFlows();
  renderSide();
  renderDevices();
  view.setState(state);
}

for (const area of ['case', 'desk', 'rig']) {
  $(`#gaps-${area}`).addEventListener('input', e => {
    showGaps(area, +e.target.value);
    sendGaps({ area, gaps: +e.target.value });
  });
}

for (const k of ['speed', 'brightness', 'spread', 'background']) {
  $('#' + k).addEventListener('input', e => {
    const v = +e.target.value;
    editing()[k] = v;
    if (k === 'speed') showSpeed(v);
    if (k === 'brightness') $('#brightness-val').textContent = `${v}%`;
    if (k === 'background') showBackground(v);
    sendScene({ [k]: v, area: editArea });
  });
}
$('#rescan').addEventListener('click', () => tryPost('/api/rescan'));

const events = new EventSource('/api/events');
events.addEventListener('state', e => {
  state = JSON.parse(e.data);
  if (!setupStarted && state.settings.setupDone === false) startSetup(); // undefined: an editor from before the guide
  syncSetupCheck();
  if (selectedKey && !lightByKey(selectedKey)) selectedKey = null;
  render();
});
events.addEventListener('frame', e => {
  const frames = JSON.parse(e.data);
  view.setFrame(frames);
  for (const [idx, colors] of Object.entries(frames)) {
    for (const dot of ledEls[idx] || []) {
      const c = colors[dot.led];
      if (dot.c === c) continue;
      dot.c = c;
      dot.el.style.background = c;
      dot.el.style.boxShadow = `0 0 6px ${c}`;
    }
  }
});
events.onerror = () => { if (state) { state.status = 'disconnected'; syncSetupCheck(); renderStatus(); renderSide(); } };

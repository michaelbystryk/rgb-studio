// 3D view of the rig. Shows every light with its live colors and lets you drag lights to where
// they really are. Geometry comes from /shared/rig-geometry.js, same as the server.
//
// Mouse: left-drag a light to move it; left- or middle-drag elsewhere to orbit; right-drag or
// Shift + drag to pan; scroll to zoom toward the cursor.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ledLayout, lightExtent, areaFrames, areaSize, caseSpot } from '/shared/rig-geometry.js';

const ELEVATION = THREE.MathUtils.degToRad(28);  // starting view: from above, at an angle
const START_YAW = Math.PI / 4;
const FOV = 35;
const SNAP = 0.5;          // cm
const DESK_MAX_HEIGHT = 80;
const FIT_MARGIN = 1.04;
const WASH_STRENGTH = 0.5;
const WALL_HEIGHT = 75;    // cm above the desk
const WALL_MARGIN = 40;    // cm the wall reaches past each side of the desk
const WASH_TEXTURE = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const COLORS = { bg: '#07070d', panel: '#12121b', panelEdge: '#2c2c44', part: '#191924', partEdge: '#34344e', select: '#7b5cff', idle: '#15151c' };

// Rotation from a light's own frame (u, v, w) into its area: see planeToArea in rig-geometry.js.
const PLANE_Q = {
  xy: new THREE.Quaternion(),
  xz: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
  yz: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
};
const PLANE_NORMAL = { xy: new THREE.Vector3(0, 0, 1), xz: new THREE.Vector3(0, 1, 0), yz: new THREE.Vector3(1, 0, 0) };

const UP = new THREE.Vector3(0, 1, 0);
const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.1, ...extra });
function boxWithEdges(size, fill, edge) {
  const geo = new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geo, fill);
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: edge })));
  return mesh;
}

export function createRigView(host, { onSelect = () => {}, onMove = () => {}, onMoveCase = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const tip = document.createElement('div');
  tip.className = 'rig-tip';
  host.appendChild(tip);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);
  scene.add(new THREE.HemisphereLight('#50507a', '#08080c', 1.1));
  const sun = new THREE.DirectionalLight('#b0b4ff', 0.5);
  sun.position.set(-1, 3, 2);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000);
  camera.position.set(Math.sin(START_YAW) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(START_YAW) * Math.cos(ELEVATION));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.2));
  composer.addPass(new OutputPass());

  const world = new THREE.Group();
  scene.add(world);
  let areas = {};        // area name → group in world
  let pieces = [];       // { light, group, leds: InstancedMesh, glow, spin }
  let walls = [];        // { mesh, normal, area } walls hidden when they're between the camera and the inside
  let pickables = [];
  let caseParts = [];    // case meshes: click to select the case, then drag to move it
  let caseSelected = false;
  let state = null;
  let sig = '';
  let selected = null;
  let selBox = null;
  const targets = {};    // device index → THREE.Color[]
  let userMoved = false;

  // ---- building the scene -------------------------------------------------------------------

  function buildCase(group, [L, H, W]) {
    const panel = flat(COLORS.panel, { transparent: true, opacity: 0.92 });
    const add = (size, pos, normal) => {
      const m = boxWithEdges(size, panel, COLORS.panelEdge);
      m.position.set(...pos);
      group.add(m);
      walls.push({ mesh: m, normal: new THREE.Vector3(...normal), area: group });
      caseParts.push(m);
    };
    const t = 0.6;
    add([L, t, W], [L / 2, -t / 2, W / 2], [0, -1, 0]);     // bottom
    add([L, t, W], [L / 2, H + t / 2, W / 2], [0, 1, 0]);   // top
    add([t, H, W], [-t / 2, H / 2, W / 2], [-1, 0, 0]);     // rear
    add([t, H, W], [L + t / 2, H / 2, W / 2], [1, 0, 0]);   // front
    add([L, H, t], [L / 2, H / 2, -t / 2], [0, 0, -1]);     // motherboard tray
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(L, H), new THREE.MeshBasicMaterial({ color: '#8aa0ff', transparent: true, opacity: 0.04, depthWrite: false }));
    glass.position.set(L / 2, H / 2, W);
    group.add(glass);
    caseParts.push(glass);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), new THREE.LineBasicMaterial({ color: COLORS.panelEdge }));
    outline.position.set(L / 2, H / 2, W / 2);
    group.add(outline);
    // Every PC has a motherboard; draw a plain one for context.
    const board = boxWithEdges([L * 0.62, H * 0.62, 0.4], flat(COLORS.part), COLORS.partEdge);
    board.position.set(L * 0.36, H * 0.6, 0.5);
    group.add(board);
    caseParts.push(board);
  }

  function buildDesk(group, [DW, , DD], floorCase) {
    const top = boxWithEdges([DW, 2, DD], flat('#0e0e16'), COLORS.panelEdge);
    top.position.set(DW / 2, -1, DD / 2);
    group.add(top);
    // The wall behind the desk, where lights on the back of a monitor shine. It reaches the floor
    // when the desk stands on legs, and is wide enough to sit behind a case beside the desk.
    const bottom = floorCase ? -group.position.y : -2;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(DW + 2 * WALL_MARGIN, WALL_HEIGHT - bottom), flat('#101018', { side: THREE.DoubleSide }));
    wall.position.set(DW / 2, (WALL_HEIGHT + bottom) / 2, -0.5);
    group.add(wall);
    walls.push({ mesh: wall, normal: new THREE.Vector3(0, 0, -1), area: group });
    if (floorCase) {
      for (const [x, z] of [[3, 3], [DW - 3, 3], [3, DD - 3], [DW - 3, DD - 3]]) {
        const leg = boxWithEdges([3, group.position.y - 2, 3], flat(COLORS.panel), COLORS.panelEdge);
        leg.position.set(x, -2 - (group.position.y - 2) / 2, z);
        group.add(leg);
      }
    }
  }

  function buildProp(p) {
    const fill = p.style === 'screen' ? flat('#0b0b12') : flat(COLORS.part);
    const m = boxWithEdges(p.size, fill, COLORS.partEdge);
    m.position.set(...p.pos);
    if (p.style === 'screen') {
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(p.size[0] - 1.5, p.size[1] - 1.5), new THREE.MeshBasicMaterial({ color: '#04050a' }));
      glass.position.z = p.size[2] / 2 + 0.05;
      m.add(glass);
    }
    return m;
  }

  // Body drawn in the light's own frame: u, v across the light, w out of its face.
  function buildBody(light, matrix) {
    const g = new THREE.Group();
    const part = flat(COLORS.part);
    if (light.body === 'fan') {
      const s = light.size * 2 + 2.4, depth = 2.5, bar = 1.1;
      for (const [w, h, x, y] of [[s, bar, 0, (s - bar) / 2], [s, bar, 0, -(s - bar) / 2], [bar, s, (s - bar) / 2, 0], [bar, s, -(s - bar) / 2, 0]]) {
        const m = boxWithEdges([w, h, depth], part, COLORS.partEdge);
        m.position.set(x, y, 0);
        g.add(m);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(light.size * 0.3, light.size * 0.3, 1.5, 24), part);
      hub.rotation.x = Math.PI / 2;
      g.add(hub);
      const spin = new THREE.Group();
      const bladeMat = new THREE.MeshStandardMaterial({ color: '#2a2a3c', transparent: true, opacity: 0.6, side: THREE.DoubleSide });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const b = new THREE.Mesh(new THREE.PlaneGeometry(light.size * 0.6, light.size * 0.34), bladeMat);
        b.position.set(Math.cos(a) * light.size * 0.55, Math.sin(a) * light.size * 0.55, 0);
        b.rotation.set(0.5, 0, a + Math.PI / 2);
        spin.add(b);
      }
      g.add(spin);
      g.userData.spin = spin;
    } else if (light.body === 'ram') {
      const m = boxWithEdges([light.size + 1, 0.7, 4.5], part, COLORS.partEdge);
      m.position.z = -2.4;
      g.add(m);
    } else if (light.body === 'keyboard') {
      const [w, h] = lightExtent(light, matrix);
      const m = boxWithEdges([w + 2, h + 2, 2], part, COLORS.partEdge);
      m.position.z = -1.1;
      g.add(m);
    } else if (light.body === 'mouse') {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), part);
      m.scale.set(3.2, 6, 1.9);
      m.position.set(0, -2, -1.9);
      g.add(m);
    }
    return g;
  }

  const ledGeo = new THREE.SphereGeometry(0.45, 10, 8);
  function buildPiece(light, zone, builtIn) {
    const group = new THREE.Group();
    group.position.set(...light.pos);
    group.quaternion.copy(PLANE_Q[light.plane]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(light.angle || 0)));
    const body = buildBody(light, zone.matrix);
    group.add(body);

    const layout = ledLayout(light, light.count, zone.matrix);
    const keySize = light.shape === 'matrix' && zone.matrix ? (light.size / zone.matrix.width) * 0.78 : 0;
    const geo = keySize ? new THREE.BoxGeometry(keySize, keySize, 0.4) : ledGeo;
    const leds = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff' }), layout.length);
    const m4 = new THREE.Matrix4();
    layout.forEach(([u, v, w], i) => {
      m4.makeTranslation(u, v, w + (keySize ? 0.2 : 0));
      leds.setMatrixAt(i, m4);
      leds.setColorAt(i, new THREE.Color(COLORS.idle));
    });
    group.add(leds);

    let glow = null;
    if (light.shape === 'ring' || light.body === 'ram') {
      glow = new THREE.PointLight('#000000', 0, light.shape === 'ring' ? 30 : 14, 1.5);
      group.add(glow);
    }
    const piece = { light, group, leds, glow, wash: buildWash(light), spin: body.userData.spin, builtIn };
    group.traverse(o => { if (o.isMesh) { o.userData.piece = piece; pickables.push(o); } });
    return piece;
  }

  // Lights behind a screen face the wall, so they show as a soft patch of color on it.
  function buildWash(light) {
    if (light.area !== 'desk' || light.plane !== 'xy') return null;
    const [x, y, z] = light.pos;
    const behind = (state.rig.props || []).some(p => p.area === 'desk' && p.style === 'screen'
      && z < p.pos[2] - p.size[2] / 2 + 0.5 && Math.abs(x - p.pos[0]) < p.size[0] / 2 && Math.abs(y - p.pos[1]) < p.size[1] / 2);
    if (!behind) return null;
    const r = 7 + z * 1.2; // a light further from the wall spreads wider
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: WASH_TEXTURE, color: '#000000', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    wash.scale.set(r * 2.2, r * 1.8, 1);
    wash.position.set(x, y + r * 0.25, 0.1);
    areas.desk.add(wash);
    return wash;
  }

  function rebuild() {
    world.clear();
    pieces = [];
    walls = [];
    pickables = [];
    caseParts = [];
    areas = {};
    const rig = state.rig;
    for (const name of ['case', 'desk']) {
      areas[name] = new THREE.Group();
      world.add(areas[name]);
    }
    placeAreas(rig);
    buildCase(areas.case, rig.case.size);
    buildDesk(areas.desk, areaSize(rig, 'desk'), rig.case.placement.startsWith('floor'));
    if (rig.case.placement.startsWith('floor')) {
      const grid = new THREE.GridHelper(600, 60, '#1a1a28', '#12121c');
      grid.position.set(rig.desk.size[0] / 2, 0, rig.desk.size[1] / 2);
      world.add(grid);
    }
    for (const p of rig.props || []) areas[p.area]?.add(buildProp(p));

    const builtIn = Object.fromEntries(state.devices.map(d => [d.index, d.builtIn]));
    for (const light of state.lights) {
      if (light.hidden) continue;
      const zone = state.devices[light.device]?.zones[light.zone];
      if (!zone) continue;
      const piece = buildPiece(light, zone, builtIn[light.device]);
      areas[light.area].add(piece.group);
      pieces.push(piece);
    }
    highlight();
  }

  function placeAreas(rig) {
    const frames = areaFrames(rig);
    for (const [name, g] of Object.entries(areas)) {
      g.position.set(...frames[name].origin);
      g.rotation.y = frames[name].turn;
    }
  }

  function highlight() {
    if (selBox) { selBox.removeFromParent(); selBox = null; }
    const target = caseSelected ? areas.case : pieces.find(x => x.light.key === selected)?.group;
    if (!target) return;
    target.updateWorldMatrix(true, true); // the box is measured now, before the next render places the case
    selBox = new THREE.BoxHelper(target, COLORS.select);
    scene.add(selBox);
  }

  // ---- camera -------------------------------------------------------------------------------

  // Frame everything, keeping the current viewing direction.
  function fit() {
    const box = new THREE.Box3().setFromObject(world);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    // Corners of each part, not of the whole scene's box, so tilted views fit snugly.
    const corners = [];
    world.updateMatrixWorld();
    world.traverse(o => {
      if (!o.isMesh || !o.visible || o.material.blending === THREE.AdditiveBlending) return;
      o.geometry.computeBoundingBox();
      const { min, max } = o.geometry.boundingBox;
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(o.matrixWorld));
    });
    const back = camera.position.clone().sub(controls.target).normalize(); // toward the camera
    const right = new THREE.Vector3().crossVectors(UP, back).normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const tanH = tanV * Math.max(0.3, host.clientWidth / Math.max(1, host.clientHeight));
    // Each corner needs the camera far enough back that it lands inside the frame.
    let dist = 0;
    for (const c of corners) {
      const p = c.sub(center);
      dist = Math.max(dist, p.dot(back) + Math.abs(p.dot(right)) / tanH, p.dot(back) + Math.abs(p.dot(up)) / tanV);
    }
    dist *= FIT_MARGIN;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(back, dist);
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.update();
  }

  // Quarter turns around the target from the toolbar, eased in the render loop.
  let turnLeft = 0;

  // ---- pointer: select, drag along the light's plane, pan, zoom -----------------------------

  const raycaster = new THREE.Raycaster();
  const ndc = e => {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const pick = e => {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.intersectObjects(pickables, false)[0]?.object.userData.piece ?? null;
  };
  const onCase = e => {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.intersectObjects(caseParts.filter(m => m.visible), false).length > 0;
  };
  const floorAt = e => {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.ray.intersectPlane(new THREE.Plane(UP, 0), new THREE.Vector3());
  };

  // This listener is added before OrbitControls' own, so grabbing a light can switch the camera
  // off before it sees the press.
  let drag = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    const start = { x: e.clientX, y: e.clientY, moved: false };
    const piece = e.button === 0 && !e.shiftKey ? pick(e) : null;
    if (!piece) {
      drag = e.button === 0 ? { ...start, onCase: onCase(e) } : null;
      // Once the case is selected, dragging it moves it across the floor.
      if (drag?.onCase && caseSelected) {
        const from = floorAt(e);
        if (!from) return;
        controls.enabled = false;
        renderer.domElement.setPointerCapture(e.pointerId);
        Object.assign(drag, { moveCase: true, from, spot: { ...caseSpot(state.rig) } });
      }
      return;
    }
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    // Drag on the plane the light is mounted in, expressed in its area's frame.
    const area = areas[piece.light.area];
    const normal = PLANE_NORMAL[piece.light.plane].clone().transformDirection(area.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, piece.group.getWorldPosition(new THREE.Vector3()));
    raycaster.setFromCamera(ndc(e), camera);
    const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    drag = { ...start, piece, plane, from: hit && area.worldToLocal(hit.clone()), pos: [...piece.light.pos] };
  });

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the floor
  // Once someone moves the camera, resizing the page no longer refits it.
  controls.addEventListener('start', () => { tip.style.opacity = 0; userMoved = true; });

  renderer.domElement.addEventListener('pointermove', e => {
    if (!drag) return hover(e);
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    tip.style.opacity = 0;
    if (drag.moveCase) {
      const now = floorAt(e);
      if (!now) return;
      const spot = { ...drag.spot, x: Math.round(drag.spot.x + now.x - drag.from.x), z: Math.round(drag.spot.z + now.z - drag.from.z) };
      state.rig = { ...state.rig, case: { ...state.rig.case, spot } };
      placeAreas(state.rig);
      selBox?.update();
      return;
    }
    if (!drag.piece || !drag.from) return;
    raycaster.setFromCamera(ndc(e), camera);
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!hit) return;
    const { light } = drag.piece;
    const now = areas[light.area].worldToLocal(hit);
    const size = areaSize(state.rig, light.area);
    const max = [size[0], light.area === 'desk' ? DESK_MAX_HEIGHT : size[1], size[2]];
    const delta = [now.x - drag.from.x, now.y - drag.from.y, now.z - drag.from.z];
    light.pos = drag.pos.map((v, i) => Math.max(0, Math.min(max[i], Math.round((v + delta[i]) / SNAP) * SNAP)));
    drag.piece.group.position.set(...light.pos);
    selBox?.update();
  });

  renderer.domElement.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    controls.enabled = true;
    if (d?.moveCase && d.moved) return onMoveCase(caseSpot(state.rig));
    if (!d || (d.moved && !d.piece)) return; // an orbit, not a click
    selected = d.piece?.light.key ?? null;
    caseSelected = !d.piece && d.onCase;
    highlight();
    onSelect(selected);
    if (d.moved) onMove(selected, d.piece.light.pos);
  });

  function hover(e) {
    const piece = pick(e);
    const caseHint = !piece && onCase(e);
    renderer.domElement.style.cursor = piece || (caseHint && caseSelected) ? 'grab' : 'default';
    if (!piece && !caseHint) { tip.style.opacity = 0; return; }
    const r = host.getBoundingClientRect();
    tip.textContent = piece ? piece.light.label : caseSelected ? 'Drag to move the case' : 'PC case: click to select, then drag to move';
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top + 10}px`;
    tip.style.opacity = 1;
  }
  renderer.domElement.addEventListener('pointerleave', () => { tip.style.opacity = 0; });

  // ---- render loop --------------------------------------------------------------------------

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    if (!userMoved && state && w > 0) fit();
  }
  new ResizeObserver(resize).observe(host);

  const tmp = new THREE.Color();
  const idle = new THREE.Color(COLORS.idle);
  const camDir = new THREE.Vector3();
  const wallPos = new THREE.Vector3();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const k = 1 - Math.exp(-dt * 18); // ease toward each new frame so 20 fps updates look smooth
    if (Math.abs(turnLeft) > 1e-4) {
      const step = turnLeft * (1 - Math.exp(-dt * 10));
      turnLeft -= step;
      camera.position.sub(controls.target).applyAxisAngle(UP, step).add(controls.target);
    }
    controls.update();

    // Cutaway: hide the walls between the camera and the inside.
    for (const w of walls) {
      const n = w.normal.clone().transformDirection(w.area.matrixWorld);
      camDir.copy(w.mesh.getWorldPosition(wallPos)).sub(camera.position);
      w.mesh.visible = n.dot(camDir) > 0;
    }

    for (const p of pieces) {
      const colors = p.builtIn ? null : targets[p.light.device];
      const avg = new THREE.Color(0, 0, 0);
      for (let i = 0; i < p.light.count; i++) {
        p.leds.getColorAt(i, tmp);
        tmp.lerp(colors?.[p.light.ledStart + i] ?? idle, k);
        p.leds.setColorAt(i, tmp);
        avg.add(tmp);
      }
      p.leds.instanceColor.needsUpdate = true;
      if (p.glow) {
        avg.multiplyScalar(1 / Math.max(1, p.light.count));
        p.glow.color.copy(avg);
        p.glow.intensity = (p.light.shape === 'ring' ? 260 : 40) * Math.max(avg.r, avg.g, avg.b);
      }
      if (p.wash) p.wash.material.color.copy(avg).multiplyScalar((p.glow ? 1 : 1 / Math.max(1, p.light.count)) * WASH_STRENGTH);
      if (p.spin) p.spin.rotation.z -= dt * 2.2;
    }
    composer.render();
  });

  return {
    setState(next) {
      state = next;
      const s = JSON.stringify([next.rig, next.lights, next.devices.map(d => [d.builtIn, d.zones.length])]);
      if (s === sig || drag?.moved) return;
      const first = !sig;
      sig = s;
      rebuild();
      if (first && host.clientWidth) fit();
    },
    setFrame(frames) {
      for (const [dev, colors] of Object.entries(frames)) targets[dev] = colors.map(c => new THREE.Color(c));
    },
    select(key) { selected = key; caseSelected = false; highlight(); },
    rotate(step) { turnLeft += (step * Math.PI) / 2; },
    fit() { userMoved = false; fit(); },
  };
}

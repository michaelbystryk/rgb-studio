// Minimal OpenRGB SDK client (protocol versions 0-5), no dependencies.
// Protocol reference: https://gitlab.com/CalcProgrammer1/OpenRGB/-/blob/master/Documentation/OpenRGBSDK.md
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { hexToRgb, rgbToHex } from './color.js';

const CLIENT_PROTOCOL = 5;
const MAGIC = Buffer.from('ORGB');
const HEADER_SIZE = 16;

const PKT = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  REQUEST_RESCAN_DEVICES: 140,
  PROFILE_LIST: 150,
  SAVE_PROFILE: 151,
  LOAD_PROFILE: 152,
  UPDATELEDS: 1050,
  UPDATEMODE: 1101,
  SAVEMODE: 1102,
};

export const MODE_FLAG = {
  HAS_SPEED: 1 << 0,
  HAS_DIRECTION_LR: 1 << 1,
  HAS_DIRECTION_UD: 1 << 2,
  HAS_DIRECTION_HV: 1 << 3,
  HAS_BRIGHTNESS: 1 << 4,
  HAS_PER_LED_COLOR: 1 << 5,
  HAS_MODE_SPECIFIC_COLOR: 1 << 6,
  HAS_RANDOM_COLOR: 1 << 7,
  MANUAL_SAVE: 1 << 8,
  AUTOMATIC_SAVE: 1 << 9,
};

export const COLOR_MODE = { NONE: 0, PER_LED: 1, MODE_SPECIFIC: 2, RANDOM: 3 };
export const DIRECTION = { LEFT: 0, RIGHT: 1, UP: 2, DOWN: 3, HORIZONTAL: 4, VERTICAL: 5 };

const DEVICE_TYPES = [
  'motherboard', 'dram', 'gpu', 'cooler', 'ledstrip', 'keyboard', 'mouse',
  'mousemat', 'headset', 'headset_stand', 'gamepad', 'light', 'speaker',
  'virtual', 'storage', 'case', 'microphone', 'accessory', 'keypad',
  'laptop', 'monitor', 'unknown',
];

const ZONE_TYPES = ['single', 'linear', 'matrix'];
const NO_LED = 0xFFFFFFFF;

class Reader {
  constructor(buf) { this.buf = buf; this.o = 0; }
  u16() { const v = this.buf.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.o); this.o += 4; return v; }
  str() {
    const len = this.u16();
    const s = this.buf.toString('utf8', this.o, this.o + len).replace(/\0+$/, '');
    this.o += len;
    return s;
  }
  // RGBColor on the wire is 0x00BBGGRR, i.e. bytes R, G, B, pad.
  color() {
    const c = rgbToHex([this.buf[this.o], this.buf[this.o + 1], this.buf[this.o + 2]]);
    this.o += 4;
    return c;
  }
  colors() { return Array.from({ length: this.u16() }, () => this.color()); }
}

class Writer {
  constructor() { this.parts = []; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(s + '\0', 'utf8'); this.u16(b.length); this.parts.push(b); return this; }
  color(hex) { this.parts.push(Buffer.from([...hexToRgb(hex), 0])); return this; }
  colors(list) { this.u16(list.length); list.forEach(c => this.color(c)); return this; }
  buffer() { return Buffer.concat(this.parts); }
}

const cstr = s => Buffer.from(s + '\0', 'utf8');
// Several packets start with a data_size field that counts itself.
const withSize = inner => Buffer.concat([new Writer().u32(inner.length + 4).buffer(), inner]);

function parseMode(r, v, index) {
  const m = { index, name: r.str(), value: r.i32(), flags: r.u32(), speedMin: r.u32(), speedMax: r.u32() };
  if (v >= 3) { m.brightnessMin = r.u32(); m.brightnessMax = r.u32(); }
  m.colorsMin = r.u32();
  m.colorsMax = r.u32();
  m.speed = r.u32();
  if (v >= 3) m.brightness = r.u32();
  m.direction = r.u32();
  m.colorMode = r.u32();
  m.colors = r.colors();
  return m;
}

function writeMode(w, m, v) {
  w.str(m.name).i32(m.value).u32(m.flags).u32(m.speedMin).u32(m.speedMax);
  if (v >= 3) w.u32(m.brightnessMin).u32(m.brightnessMax);
  w.u32(m.colorsMin).u32(m.colorsMax).u32(m.speed);
  if (v >= 3) w.u32(m.brightness);
  w.u32(m.direction).u32(m.colorMode).colors(m.colors);
}

function parseController(buf, v, index) {
  const r = new Reader(buf);
  r.u32(); // data_size
  const d = { index, type: DEVICE_TYPES[r.i32()] || 'unknown', name: r.str() };
  d.vendor = v >= 1 ? r.str() : '';
  d.description = r.str();
  d.version = r.str();
  d.serial = r.str();
  d.location = r.str();
  const numModes = r.u16();
  d.activeMode = r.i32();
  d.modes = Array.from({ length: numModes }, (_, i) => parseMode(r, v, i));
  d.zones = [];
  let ledStart = 0;
  for (let i = 0, n = r.u16(); i < n; i++) {
    const z = { index: i, name: r.str(), type: ZONE_TYPES[r.i32()] || 'linear', ledsMin: r.u32(), ledsMax: r.u32(), ledsCount: r.u32() };
    if (r.u16() > 0) {
      const height = r.u32(), width = r.u32();
      const map = Array.from({ length: height }, () => Array.from({ length: width }, () => r.u32()));
      z.matrix = { height, width, map };
    }
    if (v >= 4) {
      z.segments = Array.from({ length: r.u16() }, () => ({ name: r.str(), type: r.i32(), start: r.u32(), count: r.u32() }));
    }
    if (v >= 5) r.u32(); // zone flags
    z.ledStart = ledStart;
    ledStart += z.ledsCount;
    d.zones.push(z);
  }
  d.leds = Array.from({ length: r.u16() }, () => ({ name: r.str(), value: r.u32() }));
  d.colors = r.colors();
  return d;
}

export class OpenRGBClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 6742, name = 'RGB Studio' } = {}) {
    super();
    Object.assign(this, { host, port, name });
    this.protocol = 0;
    this.connected = false;
    this.rx = Buffer.alloc(0);
    this.waiters = [];
    this.chain = Promise.resolve();
  }

  // Resolves once connected and the protocol version is agreed. Emits 'close' when the link drops.
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock;
      sock.setNoDelay(true);
      sock.once('error', reject);
      sock.on('data', d => this.onData(d));
      sock.on('close', () => {
        this.connected = false;
        for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('connection closed')); }
        this.emit('close');
      });
      sock.once('connect', async () => {
        sock.removeListener('error', reject);
        sock.on('error', e => this.emit('error', e));
        this.connected = true;
        try {
          const resp = await this.request(0, PKT.REQUEST_PROTOCOL_VERSION, new Writer().u32(CLIENT_PROTOCOL).buffer(), 1000);
          this.protocol = Math.min(CLIENT_PROTOCOL, resp.readUInt32LE(0));
        } catch {
          this.protocol = 0; // servers before protocol 1 never answer the version request
        }
        this.send(0, PKT.SET_CLIENT_NAME, cstr(this.name));
        resolve(this);
      });
    });
  }

  close() { this.sock?.destroy(); }

  // Bytes waiting to be written to OpenRGB; grows when it can't keep up.
  get backlog() { return this.sock?.writableLength ?? 0; }

  onData(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= HEADER_SIZE) {
      if (!this.rx.subarray(0, 4).equals(MAGIC)) {
        // Out of sync: skip ahead to the next header.
        const next = this.rx.indexOf(MAGIC, 1);
        this.rx = next < 0 ? this.rx.subarray(this.rx.length - 3) : this.rx.subarray(next);
        continue;
      }
      const size = this.rx.readUInt32LE(12);
      if (this.rx.length < HEADER_SIZE + size) return;
      const dev = this.rx.readUInt32LE(4), id = this.rx.readUInt32LE(8);
      const body = Buffer.from(this.rx.subarray(HEADER_SIZE, HEADER_SIZE + size));
      this.rx = this.rx.subarray(HEADER_SIZE + size);
      const wi = this.waiters.findIndex(w => w.id === id && w.dev === dev);
      if (wi >= 0) {
        const [w] = this.waiters.splice(wi, 1);
        clearTimeout(w.timer);
        w.resolve(body);
      } else if (id === PKT.DEVICE_LIST_UPDATED) {
        this.emit('devicesChanged');
      }
    }
  }

  send(dev, id, body = Buffer.alloc(0)) {
    if (!this.connected) throw new Error('not connected to OpenRGB');
    const h = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(h);
    h.writeUInt32LE(dev, 4);
    h.writeUInt32LE(id, 8);
    h.writeUInt32LE(body.length, 12);
    this.sock.write(Buffer.concat([h, body]));
  }

  // Requests are serialized so responses can't be confused with each other.
  request(dev, id, body, timeout = 5000) {
    const run = () => new Promise((resolve, reject) => {
      const w = { dev, id, resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for OpenRGB (packet ${id})`));
      }, timeout);
      this.waiters.push(w);
      this.send(dev, id, body);
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async getControllers() {
    const count = (await this.request(0, PKT.REQUEST_CONTROLLER_COUNT)).readUInt32LE(0);
    const body = this.protocol > 0 ? new Writer().u32(this.protocol).buffer() : Buffer.alloc(0);
    const out = [];
    for (let i = 0; i < count; i++) out.push(parseController(await this.request(i, PKT.REQUEST_CONTROLLER_DATA, body), this.protocol, i));
    return out;
  }

  updateLeds(dev, colors) { this.send(dev, PKT.UPDATELEDS, withSize(new Writer().colors(colors).buffer())); }

  // The body of a mode packet; the background player sends it as is (see docs/player-format.md).
  modeBody(mode) {
    const w = new Writer().i32(mode.index);
    writeMode(w, mode, this.protocol);
    return withSize(w.buffer());
  }
  modePacket(id, dev, mode) { this.send(dev, id, this.modeBody(mode)); }
  updateMode(dev, mode) { this.modePacket(PKT.UPDATEMODE, dev, mode); }
  // Stores the mode in the device's own memory (for modes flagged MANUAL_SAVE).
  saveMode(dev, mode) { if (this.protocol >= 3) this.modePacket(PKT.SAVEMODE, dev, mode); }

  async getProfiles() {
    if (this.protocol < 2) return [];
    const r = new Reader(await this.request(0, PKT.PROFILE_LIST));
    r.u32(); // data_size
    return Array.from({ length: r.u16() }, () => r.str());
  }
  saveProfile(name) { this.send(0, PKT.SAVE_PROFILE, cstr(name)); }
  loadProfile(name) { this.send(0, PKT.LOAD_PROFILE, cstr(name)); }
  rescan() { if (this.protocol >= 5) this.send(0, PKT.REQUEST_RESCAN_DEVICES); }
}

export { NO_LED };

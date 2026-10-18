// Read-only checks for the setup guide. The port probe sends no SDK data.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OPTIONS = { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
const RGB_APPS = {
  'icue.exe': 'Corsair iCUE',
  'nzxt cam.exe': 'NZXT CAM',
  'lghub.exe': 'Logitech G HUB',
  'lghub_agent.exe': 'Logitech G HUB',
  'armourycrate.exe': 'ASUS Armoury Crate',
  'armourycrateservice.exe': 'ASUS Armoury Crate',
  'signalrgb.exe': 'SignalRGB',
  'razer synapse 3.exe': 'Razer Synapse',
  'razercentral.exe': 'Razer Synapse',
  'msi center.exe': 'MSI Center',
};

async function serviceStatus(name) {
  try {
    const { stdout } = await run('sc', ['query', name], OPTIONS);
    return /STATE\s*:\s*\d+\s+RUNNING\b/i.test(stdout) ? 'running' : 'stopped';
  } catch (e) {
    return Number(e.code) === 1060 || /FAILED\s+1060\b/i.test(e.stdout || '') ? 'missing' : 'stopped';
  }
}

function portOpen() {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const done = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
    try { socket.connect(6742, '127.0.0.1'); } catch { done(false); }
  });
}

function installedFile() {
  try {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .some(dir => dir && fs.existsSync(path.join(dir, 'OpenRGB', 'OpenRGB.exe')));
  } catch { return false; }
}

let cached = null;
let checkedAt = 0;
let pending = null;
export async function checkOpenRGB() {
  if (process.platform !== 'win32') return { platform: 'other' };
  if (cached && Date.now() - checkedAt < 2000) return cached;
  if (pending) return pending;
  pending = (async () => {
    const [service, pawnio, tasks, port] = await Promise.all([
      serviceStatus('OpenRGB'),
      serviceStatus('PawnIO'),
      run('tasklist', ['/fo', 'csv', '/nh'], OPTIONS).catch(() => ({ stdout: '' })),
      portOpen(),
    ]);
    const exes = [...tasks.stdout.matchAll(/^"([^"]+)"/gm)].map(m => m[1].toLowerCase());
    const app = exes.includes('openrgb.exe');
    cached = {
      platform: 'win32', service, pawnio, app,
      installed: service !== 'missing' || installedFile() || app,
      port,
      others: [...new Set(exes.map(exe => RGB_APPS[exe]).filter(Boolean))],
    };
    checkedAt = Date.now();
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}

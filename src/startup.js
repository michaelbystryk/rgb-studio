// Makes the OpenRGB Windows service load our profile when it starts and when the PC wakes up,
// so saved lighting comes back without RGB Studio running. Needs admin once, via a UAC prompt.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROFILE } from './persist.js';

const run = promisify(execFile);
const HELPER = path.join(import.meta.dirname, '..', 'tools', 'set-startup-profile.js');
const SERVICE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\OpenRGB';

let configPath; // undefined = not looked up yet, null = no OpenRGB service

async function findConfig() {
  if (configPath !== undefined) return configPath;
  configPath = null;
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('reg', ['query', SERVICE_KEY, '/v', 'ImagePath']);
    const exe = stdout.match(/ImagePath\s+REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?\.exe)/i)?.[1];
    const file = exe && path.join(path.dirname(exe), 'service_config', 'OpenRGB.json');
    if (file && fs.existsSync(file)) configPath = file;
  } catch {
    // no OpenRGB service installed
  }
  return configPath;
}

export async function startupStatus() {
  const file = await findConfig();
  if (!file) return { available: false, enabled: false };
  try {
    const pm = JSON.parse(fs.readFileSync(file, 'utf8')).ProfileManager || {};
    const on = p => p?.enabled && p.name === PROFILE;
    return { available: true, enabled: Boolean(on(pm.service_startup_profile) && on(pm.resume_profile)) };
  } catch {
    return { available: true, enabled: false };
  }
}

const psQuote = s => `'${s.replace(/'/g, "''")}'`;

// Runs tools/set-startup-profile.js as admin. Resolves when the helper has finished (or the user said no).
export async function enableStartupProfile() {
  const file = await findConfig();
  if (!file) throw new Error('The OpenRGB service is not installed');
  const args = [HELPER, file, PROFILE].map(a => psQuote(`"${a}"`)).join(',');
  const command = `Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${args} -Verb RunAs -WindowStyle Hidden -Wait`;
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } catch {
    throw new Error('Windows did not give permission (the admin prompt was cancelled)');
  }
  return startupStatus();
}

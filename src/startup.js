// Makes the OpenRGB Windows service load our profile when it starts and when the PC wakes up,
// so saved lighting comes back without RGB Studio running. OpenRGB 1.1 and later take the setting
// over the SDK; older versions need their config file edited as admin, via a UAC prompt.
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

const viaSdk = client => Boolean(client?.connected && client.hasSettings);

export async function startupStatus(client) {
  const file = await findConfig();
  if (!file) return { available: false, enabled: false };
  const needsAdmin = !viaSdk(client);
  try {
    const pm = viaSdk(client) ? await client.getSettings('ProfileManager') : JSON.parse(fs.readFileSync(file, 'utf8')).ProfileManager || {};
    const on = p => p?.enabled && p.name === PROFILE;
    return { available: true, needsAdmin, enabled: Boolean(on(pm.service_startup_profile) && on(pm.resume_profile)) };
  } catch {
    return { available: true, needsAdmin, enabled: false };
  }
}

const psQuote = s => `'${s.replace(/'/g, "''")}'`;

// Over the SDK when OpenRGB allows it; otherwise runs tools/set-startup-profile.js as admin, which
// restarts the service. Resolves when the setting is made (or the user said no).
export async function enableStartupProfile(client) {
  const file = await findConfig();
  if (!file) throw new Error('The OpenRGB service is not installed');
  if (viaSdk(client)) {
    const on = { enabled: true, name: PROFILE };
    if (!await client.modifySettings({ ProfileManager: { service_startup_profile: on, resume_profile: on } })) throw new Error('OpenRGB did not accept the setting');
    return startupStatus(client);
  }
  const args = [HELPER, file, PROFILE].map(a => psQuote(`"${a}"`)).join(',');
  const command = `Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${args} -Verb RunAs -WindowStyle Hidden -Wait`;
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } catch {
    throw new Error('Windows did not give permission (the admin prompt was cancelled)');
  }
  return startupStatus();
}

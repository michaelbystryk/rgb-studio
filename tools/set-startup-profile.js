// Tells the OpenRGB service to load a profile on startup and on wake from sleep.
// Run as admin: node tools/set-startup-profile.js "<OpenRGB dir>\service_config\OpenRGB.json" "RGB Studio"
// RGB Studio runs this for you (with a UAC prompt) from the Save dialog.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [file, profile] = process.argv.slice(2);
if (!file || !profile || path.basename(file) !== 'OpenRGB.json' || path.basename(path.dirname(file)) !== 'service_config') {
  console.error('usage: node set-startup-profile.js <...\\service_config\\OpenRGB.json> <profile name>');
  process.exit(2);
}

const sc = (...args) => {
  try { return execFileSync('sc', args, { encoding: 'utf8' }); } catch (e) { return e.stdout || ''; }
};
const waitFor = state => {
  for (let i = 0; i < 60 && !sc('query', 'OpenRGB').includes(state); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
};

// Edit while the service is stopped so it can't write its old settings back over ours.
sc('stop', 'OpenRGB');
waitFor('STOPPED');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.ProfileManager ||= {};
for (const key of ['service_startup_profile', 'resume_profile']) config.ProfileManager[key] = { enabled: true, name: profile };
fs.writeFileSync(file, JSON.stringify(config, null, 4));
sc('start', 'OpenRGB');
waitFor('RUNNING');

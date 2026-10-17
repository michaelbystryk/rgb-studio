// Read-only probe: connects to OpenRGB and prints every device, zone and mode. Useful for bug reports.
import { OpenRGBClient } from '../src/openrgb.js';

const client = await new OpenRGBClient({ name: 'RGB Studio probe' }).connect();
console.log('protocol', client.protocol);
for (const d of await client.getControllers()) {
  console.log(`\n#${d.index} [${d.type}] ${d.vendor} ${d.name}  serial="${d.serial}"  leds=${d.leds.length}  active=${d.modes[d.activeMode]?.name}`);
  for (const z of d.zones) {
    const segs = z.segments?.length ? `  segments: ${z.segments.map(s => `${s.name}(${s.count})`).join(', ')}` : '';
    console.log(`  zone ${z.index} "${z.name}" ${z.type} ${z.ledsCount} LEDs${z.matrix ? ` ${z.matrix.width}x${z.matrix.height}` : ''}${segs}`);
  }
  for (const m of d.modes) {
    console.log(`  mode ${m.index} "${m.name}" flags=${m.flags} colors=${m.colorsMin}-${m.colorsMax} speed=${m.speedMin}-${m.speedMax} dir=${m.direction}`);
  }
}
console.log('\nprofiles:', await client.getProfiles());
client.close();

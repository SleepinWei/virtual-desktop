import { parseArgs } from 'node:util';
import { createService } from '../../src/server.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, port: { type: 'string', default: '8081' } } });
const port = Number(values.port);
if (!values.root || !values.canvaskit || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Pass --root, --canvaskit and a valid --port');
const service = createService({ dataDir: '.data/native', adminToken: process.env.ADMIN_TOKEN || 'dev-local', maxActive: 2,
  chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: 2 } });
const address = await service.listen(port);
console.log(`virtual-desktop live native candidate: ${address}/native`);
console.log('Trusted local fixtures; native pixel-path and general website gate remain unverified.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
